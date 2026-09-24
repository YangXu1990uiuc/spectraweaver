// Copyright 2026 The workstreams Authors
// SPDX-License-Identifier: Apache-2.0
// Part of workstreams: https://github.com/YangXu1990uiuc/workstreams

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

export interface Paths {
  /** Settings shared by all of the user's machines: token, password hash, where state lives. */
  configDir: string;
  configFile: string;
  tokenFile: string;
  passwordFile: string;
  /** Holds one state directory per host, because home directories are often shared over NFS. */
  stateBase: string;
  /** How stateBase was chosen, for `workstreams config`. */
  stateSource: string;
  /** This host's state: socket, pid files, logs, tabs. */
  stateDir: string;
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
 *   $WORKSTREAMS_STATE_DIR, $WORKSTREAMS_HOME/state, `stateDir` in config.json
 *   (set with `workstreams config state-dir`), then $XDG_STATE_HOME/workstreams.
 * The config directory is $WORKSTREAMS_CONFIG_DIR, $WORKSTREAMS_HOME/config, then
 * $XDG_CONFIG_HOME/workstreams.
 *
 * State is not kept in $XDG_RUNTIME_DIR: without linger it is deleted when the user's last
 * login session ends, taking the socket with it.
 */
export function resolvePaths(env: Record<string, string | undefined> = process.env): Paths {
  const home = homedir();
  const workstreamsHome = env.WORKSTREAMS_HOME ? resolve(expandHome(env.WORKSTREAMS_HOME)) : undefined;
  const configDir =
    env.WORKSTREAMS_CONFIG_DIR ??
    (workstreamsHome ? join(workstreamsHome, "config") : join(env.XDG_CONFIG_HOME || join(home, ".config"), "workstreams"));
  const configFile = join(configDir, "config.json");

  let stateBase: string;
  let stateSource: string;
  const configured = readStateDirSetting(configFile);
  if (env.WORKSTREAMS_STATE_DIR) {
    stateBase = resolve(expandHome(env.WORKSTREAMS_STATE_DIR));
    stateSource = "$WORKSTREAMS_STATE_DIR";
  } else if (workstreamsHome) {
    stateBase = join(workstreamsHome, "state");
    stateSource = "$WORKSTREAMS_HOME";
  } else if (configured) {
    stateBase = configured;
    stateSource = `stateDir in ${configFile}`;
  } else {
    stateBase = join(env.XDG_STATE_HOME || join(home, ".local", "state"), "workstreams");
    stateSource = "default";
  }

  const stateDir = stateDirIn(stateBase);
  const daemonSocket = join(stateDir, "daemon.sock");
  if (daemonSocket.length > MAX_SOCKET_PATH) {
    throw new Error(
      `the state directory's path is too long for a Unix socket (${daemonSocket.length} bytes, ` +
        `limit ${MAX_SOCKET_PATH}): ${stateDir}\nChoose a shorter one with \`workstreams config state-dir PATH\`.`,
    );
  }
  return {
    configDir,
    configFile,
    tokenFile: join(configDir, "auth.token"),
    passwordFile: join(configDir, "password"),
    stateBase,
    stateSource,
    stateDir,
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

/** This host's directory under the base, unless a daemon from the older flat layout still runs. */
function stateDirIn(base: string): string {
  const hostDir = join(base, hostKey());
  // Earlier versions kept state directly in the base directory. While a daemon started by
  // such a version is alive, keep using its directory, so upgrading only the server works.
  if (!existsSync(hostDir) && flatLayoutDaemonAlive(base)) return base;
  return hostDir;
}

function flatLayoutDaemonAlive(base: string): boolean {
  try {
    const pid = Number(readFileSync(join(base, "daemon.pid"), "utf8").trim());
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
