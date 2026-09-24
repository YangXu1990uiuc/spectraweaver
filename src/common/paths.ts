// Copyright 2026 The workstreams Authors
// SPDX-License-Identifier: Apache-2.0
// Part of workstreams: https://github.com/YangXu1990uiuc/workstreams

import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Paths {
  configDir: string;
  stateDir: string;
  daemonSocket: string;
  configFile: string;
  tokenFile: string;
  passwordFile: string;
  metaFile: string;
  daemonPidFile: string;
  serverPidFile: string;
  daemonLog: string;
  serverLog: string;
}

// sockaddr_un.sun_path is 108 bytes on Linux and 104 on macOS.
const MAX_SOCKET_PATH = 100;

/**
 * State lives under XDG_STATE_HOME rather than XDG_RUNTIME_DIR: without linger, the
 * runtime dir is deleted when the user's last login session ends, taking the socket with it.
 * WORKSTREAMS_CONFIG_DIR / WORKSTREAMS_STATE_DIR override both (tests, parallel instances).
 */
export function resolvePaths(env: Record<string, string | undefined> = process.env): Paths {
  const home = homedir();
  const configDir =
    env.WORKSTREAMS_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME || join(home, ".config"), "workstreams");
  const stateDir =
    env.WORKSTREAMS_STATE_DIR ?? join(env.XDG_STATE_HOME || join(home, ".local", "state"), "workstreams");
  const daemonSocket = join(stateDir, "daemon.sock");
  if (daemonSocket.length > MAX_SOCKET_PATH) {
    throw new Error(`socket path too long (${daemonSocket.length} bytes): ${daemonSocket}`);
  }
  return {
    configDir,
    stateDir,
    daemonSocket,
    configFile: join(configDir, "config.json"),
    tokenFile: join(configDir, "auth.token"),
    passwordFile: join(configDir, "password"),
    metaFile: join(stateDir, "meta.json"),
    daemonPidFile: join(stateDir, "daemon.pid"),
    serverPidFile: join(stateDir, "server.pid"),
    daemonLog: join(stateDir, "daemon.log"),
    serverLog: join(stateDir, "server.log"),
  };
}

export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}
