// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

const NAME = "spectraweaver";
/** The project's former name. Its default directories are still found; see resolvePaths. */
const FORMER_NAME = "workstreams";

export interface Paths {
  /** Settings shared by all of the user's machines: token, password hash, where state lives. */
  configDir: string;
  configFile: string;
  tokenFile: string;
  passwordFile: string;
  /** Set while configDir is the former name's: where `up` copies it (see migrateOlderState). */
  pendingConfigDir?: string;
  /** Holds one state directory per host, because home directories are often shared over NFS. */
  stateBase: string;
  /** How stateBase was chosen, for `spectraweaver config`. */
  stateSource: string;
  /** This host's state: socket, pid files, logs, tabs. */
  stateDir: string;
  /** Where earlier versions kept this host's state, now that no daemon runs there. */
  olderStateDirs: string[];
  daemonSocket: string;
  instanceFile: string;
  metaFile: string;
  daemonPidFile: string;
  serverStateFile: string;
  daemonLog: string;
  serverLog: string;
}

// sockaddr_un.sun_path is 108 bytes on Linux and 104 on macOS.
export const MAX_SOCKET_PATH = 100;

const MAX_HOST_KEY = 20;

/**
 * The per-host directory name: the short host name, like `hostname -s`. Socket paths are
 * limited to about 100 bytes and company home paths are often long, so longer names are
 * truncated and suffixed with a hash of the full name to stay distinct.
 */
export function hostKey(name: string = hostname()): string {
  const short = (name.split(".")[0] ?? "").replace(/[^A-Za-z0-9_-]/g, "_") || "localhost";
  if (short.length <= MAX_HOST_KEY) return short;
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 7);
  return `${short.slice(0, MAX_HOST_KEY - 8)}-${hash}`;
}

export function expandHome(path: string): string {
  return path.replace(/^~(?=$|\/)/, homedir());
}

/**
 * Where everything lives. The config directory is tiny and fine in a small home directory;
 * state can go anywhere. In order of precedence, the state base directory is:
 *   $SPECTRAWEAVER_STATE_DIR, $SPECTRAWEAVER_HOME/state, `stateDir` in config.json
 *   (set with `spectraweaver config state-dir`), then $XDG_STATE_HOME/spectraweaver.
 * The config directory is $SPECTRAWEAVER_CONFIG_DIR, $SPECTRAWEAVER_HOME/config, then
 * $XDG_CONFIG_HOME/spectraweaver.
 *
 * Directories from earlier versions stay in use while they are needed: the former name's
 * config directory until `up` copies it, and an older state directory while a daemon started
 * there runs, so upgrading only the server keeps every session. This function only reads.
 *
 * State is not kept in $XDG_RUNTIME_DIR: without linger it is deleted when the user's last
 * login session ends, taking the socket with it.
 */
export function resolvePaths(env: Record<string, string | undefined> = process.env): Paths {
  const home = homedir();
  const appHome = env.SPECTRAWEAVER_HOME ? resolve(expandHome(env.SPECTRAWEAVER_HOME)) : undefined;
  const xdgConfig = env.XDG_CONFIG_HOME || join(home, ".config");
  const xdgState = env.XDG_STATE_HOME || join(home, ".local", "state");

  let configDir = env.SPECTRAWEAVER_CONFIG_DIR ?? (appHome ? join(appHome, "config") : join(xdgConfig, NAME));
  let pendingConfigDir: string | undefined;
  const formerConfigDir = join(xdgConfig, FORMER_NAME);
  if (!env.SPECTRAWEAVER_CONFIG_DIR && !appHome && !existsSync(configDir) && existsSync(formerConfigDir)) {
    pendingConfigDir = configDir;
    configDir = formerConfigDir;
  }
  const configFile = join(configDir, "config.json");

  let stateBase: string;
  let stateSource: string;
  const configured = readStateDirSetting(configFile);
  if (env.SPECTRAWEAVER_STATE_DIR) {
    stateBase = resolve(expandHome(env.SPECTRAWEAVER_STATE_DIR));
    stateSource = "$SPECTRAWEAVER_STATE_DIR";
  } else if (appHome) {
    stateBase = join(appHome, "state");
    stateSource = "$SPECTRAWEAVER_HOME";
  } else if (configured) {
    stateBase = configured;
    stateSource = `stateDir in ${configFile}`;
  } else {
    stateBase = join(xdgState, NAME);
    stateSource = "default";
  }

  // Earlier versions kept state directly in the base directory, and before that under the
  // former name. While a daemon started in one of those runs, keep using its directory.
  const older = [{ base: stateBase, dir: stateBase }];
  if (stateSource === "default") {
    const formerBase = join(xdgState, FORMER_NAME);
    older.push({ base: formerBase, dir: join(formerBase, hostKey()) }, { base: formerBase, dir: formerBase });
  }
  let stateDir = join(stateBase, hostKey());
  const running = existsSync(stateDir) ? undefined : older.find(({ dir }) => daemonAlive(dir));
  if (running) {
    if (running.base !== stateBase) stateSource = `${FORMER_NAME} (the former name), while its daemon runs`;
    stateBase = running.base;
    stateDir = running.dir;
  }
  const olderStateDirs = running ? [] : older.map(({ dir }) => dir).filter((dir) => existsSync(dir));
  const daemonSocket = join(stateDir, "daemon.sock");
  if (daemonSocket.length > MAX_SOCKET_PATH) {
    throw new Error(
      `the state directory's path is too long for a Unix socket (${daemonSocket.length} bytes, ` +
        `limit ${MAX_SOCKET_PATH}): ${stateDir}\nChoose a shorter one with \`spectraweaver config state-dir PATH\`.`,
    );
  }
  return {
    configDir,
    configFile,
    tokenFile: join(configDir, "auth.token"),
    passwordFile: join(configDir, "password"),
    pendingConfigDir,
    stateBase,
    stateSource,
    stateDir,
    olderStateDirs,
    daemonSocket,
    instanceFile: join(stateDir, "instance.json"),
    metaFile: join(stateDir, "meta.json"),
    daemonPidFile: join(stateDir, "daemon.pid"),
    serverStateFile: join(stateDir, "server.json"),
    daemonLog: join(stateDir, "daemon.log"),
    serverLog: join(stateDir, "server.log"),
  };
}

export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** Whether a daemon that keeps its state in this directory is still running. */
function daemonAlive(dir: string): boolean {
  try {
    const pid = Number(readFileSync(join(dir, "daemon.pid"), "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readStateDirSetting(configFile: string): string | undefined {
  try {
    const value = (JSON.parse(readFileSync(configFile, "utf8")) as { stateDir?: unknown }).stateDir;
    return typeof value === "string" && value.trim() ? resolve(expandHome(value.trim())) : undefined;
  } catch {
    return undefined;
  }
}
