// Copyright 2026 The workstreams Authors
// SPDX-License-Identifier: Apache-2.0
// Part of workstreams: https://github.com/YangXu1990uiuc/workstreams

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { ensurePrivateDir, type Paths } from "./paths.ts";

export interface Config {
  /**
   * Names this instance's login cookie. Browsers scope cookies by host, not port, so two
   * instances reached as localhost:7777 and localhost:7778 would otherwise overwrite each
   * other's cookie.
   */
  instanceId: string;
  /** Remembered so the URL, and so a bookmark, stays the same across restarts. */
  port?: number;
  host?: string;
}

export function loadConfig(paths: Paths): Config {
  let stored: Record<string, unknown> = {};
  if (existsSync(paths.configFile)) {
    try {
      stored = JSON.parse(readFileSync(paths.configFile, "utf8")) as Record<string, unknown>;
    } catch {
      stored = {};
    }
  }
  const config: Config = {
    instanceId:
      typeof stored.instanceId === "string" && /^[0-9a-f]{8}$/.test(stored.instanceId)
        ? stored.instanceId
        : randomBytes(4).toString("hex"),
  };
  if (Number.isInteger(stored.port) && (stored.port as number) > 0 && (stored.port as number) < 65536) {
    config.port = stored.port as number;
  }
  if (typeof stored.host === "string" && stored.host) config.host = stored.host;
  if (config.instanceId !== stored.instanceId) saveConfig(paths, config);
  return config;
}

export function saveConfig(paths: Paths, config: Config): void {
  ensurePrivateDir(paths.configDir);
  const temp = `${paths.configFile}.tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, paths.configFile);
}
