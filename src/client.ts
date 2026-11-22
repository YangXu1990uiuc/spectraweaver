// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

// How the command line reaches this user's daemon (its unix socket) and server (its HTTP
// interface for the command line, with the login token).

import { existsSync, readFileSync } from "node:fs";
import type { Paths } from "./common/paths.ts";
import {
  type DaemonMessage,
  type DaemonRequest,
  decodeJson,
  encodeJsonFrame,
  FrameDecoder,
  type HelloResult,
  KIND_JSON,
  PROTOCOL_VERSION,
} from "./common/protocol.ts";

export interface ServerState {
  pid: number;
  host: string;
  port: number;
}

/**
 * Sends a request to the daemon and resolves with its answer. Requests in `before` go first and
 * are not answered (input is never answered); the daemon handles requests in order, so once
 * the answer comes they have been carried out.
 */
export function daemonCall<T>(paths: Paths, request: DaemonRequest, before: DaemonRequest[] = []): Promise<T> {
  if (paths.socketProblem) return Promise.reject(new Error(paths.socketProblem));
  return new Promise((resolve, reject) => {
    let socket: { end(): void } | null = null;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.end();
      action();
    };
    const decoder = new FrameDecoder((kind, payload) => {
      if (kind !== KIND_JSON) return;
      const message = decodeJson<DaemonMessage>(payload);
      if (message.t !== "res" || message.id !== 1) return;
      settle(() => (message.ok ? resolve(message.result as T) : reject(new Error(message.error))));
    });
    Bun.connect({
      unix: paths.daemonSocket,
      socket: {
        data: (_socket, chunk) => decoder.push(chunk),
        close: () => settle(() => reject(new Error("the daemon closed the connection"))),
      },
    })
      .then((connected) => {
        socket = connected;
        for (const first of before) connected.write(encodeJsonFrame({ ...first, t: "req", id: 0 }));
        connected.write(encodeJsonFrame({ ...request, t: "req", id: 1 }));
        timer = setTimeout(() => settle(() => reject(new Error("the daemon did not answer"))), 5000);
      })
      .catch(() => settle(() => reject(new Error("the daemon is not running (start it with `spectraweaver up`)"))));
  });
}

export async function daemonHello(paths: Paths): Promise<HelloResult | null> {
  if (paths.socketProblem || !existsSync(paths.daemonSocket)) return null;
  try {
    return await daemonCall<HelloResult>(paths, { op: "hello", protocol: PROTOCOL_VERSION, client: "spectraweaver-cli" });
  } catch {
    return null;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readServerState(paths: Paths): ServerState | null {
  try {
    const state = JSON.parse(readFileSync(paths.serverStateFile, "utf8")) as ServerState;
    return isAlive(state.pid) ? state : null;
  } catch {
    return null;
  }
}

export function serverUrl(host: string, port: number): string {
  const shown = host === "0.0.0.0" || host === "::" ? "localhost" : host.includes(":") ? `[${host}]` : host;
  return `http://${shown}:${port}`;
}

/**
 * Calls the server's interface for the command line (/api/v1/...). Null if no server runs;
 * throws with the server's message if it refuses.
 */
export async function serverCall<T>(
  paths: Paths,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T | null> {
  const server = readServerState(paths);
  if (!server) return null;
  let token: string;
  try {
    token = readFileSync(paths.tokenFile, "utf8").trim();
  } catch {
    throw new Error(`cannot read the login token (${paths.tokenFile}); restart the server with \`spectraweaver up\``);
  }
  const response = await fetch(`${serverUrl(server.host, server.port)}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404 && (await response.clone().text()) === "not found") {
    throw new Error("the server predates this command; restart it with `spectraweaver down` and `spectraweaver up`");
  }
  if (!response.ok) throw new Error((await response.text()) || `the server answered ${response.status}`);
  return (await response.json()) as T;
}
