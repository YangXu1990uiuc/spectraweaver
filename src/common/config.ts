// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./files.ts";
import { ensurePrivateDir, type Paths } from "./paths.ts";

/** Settings shared by all of the user's machines (the config directory may be on NFS). */
export interface Settings {
  /** Where per-host state lives, if not the default (e.g. when the home directory is small). */
  stateDir?: string;
}

/** This host's instance. Kept in the per-host state directory, never shared between hosts. */
export interface Instance {
  /**
   * Names the login cookie. Browsers scope cookies by host, not port, so two instances
   * reached as localhost:7777 and localhost:7778 would otherwise overwrite each other's login.
   */
  instanceId: string;
  /** Remembered so the URL, and so a bookmark, stays the same across restarts. */
  port?: number;
  host?: string;
}

function readJson(file: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function loadSettings(paths: Paths): Settings {
  const stored = readJson(paths.configFile);
  return typeof stored.stateDir === "string" && stored.stateDir ? { stateDir: stored.stateDir } : {};
}

export function saveSettings(paths: Paths, settings: Settings): void {
  ensurePrivateDir(paths.configDir);
  writeFileAtomic(paths.configFile, `${JSON.stringify(settings, null, 2)}\n`);
}

export function loadInstance(paths: Paths): Instance {
  const stored = readJson(paths.instanceFile);
  const instance: Instance = {
    instanceId:
      typeof stored.instanceId === "string" && /^[0-9a-f]{8}$/.test(stored.instanceId)
        ? stored.instanceId
        : randomBytes(4).toString("hex"),
  };
  const port = stored.port;
  if (typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536) instance.port = port;
  if (typeof stored.host === "string" && stored.host) instance.host = stored.host;
  if (instance.instanceId !== stored.instanceId) saveInstance(paths, instance);
  return instance;
}

export function saveInstance(paths: Paths, instance: Instance): void {
  ensurePrivateDir(paths.stateDir);
  writeFileAtomic(paths.instanceFile, `${JSON.stringify(instance, null, 2)}\n`);
}

/**
 * Brings older directories forward (see resolvePaths). The former name's config directory
 * is copied, not moved: other hosts sharing it over NFS may still run the old version, and
 * would lose their token. This host's tabs and instance settings (port, login cookie name)
 * move out of the directories earlier versions used for state: the flat layout, which broke
 * when hosts shared it, and the former name's. Returns a line for each change.
 */
export function migrateOlderState(paths: Paths): string[] {
  const changes: string[] = [];
  if (paths.pendingConfigDir) {
    ensurePrivateDir(paths.pendingConfigDir);
    for (const name of ["auth.token", "password", "config.json"]) {
      const from = join(paths.configDir, name);
      if (existsSync(from)) writeFileAtomic(join(paths.pendingConfigDir, name), readFileSync(from, "utf8"));
    }
    changes.push(`copied  ${paths.configDir} to ${paths.pendingConfigDir}`);
  }
  for (const dir of paths.olderStateDirs) {
    for (const name of ["meta.json", "instance.json"]) {
      const from = join(dir, name);
      const to = join(paths.stateDir, name);
      if (!existsSync(from) || existsSync(to)) continue;
      ensurePrivateDir(paths.stateDir);
      renameSync(from, to);
      changes.push(`moved   ${name} from ${dir} into ${paths.stateDir}`);
    }
  }
  return changes;
}
