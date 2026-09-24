#!/usr/bin/env bun
// Copyright 2026 The workstreams Authors
// SPDX-License-Identifier: Apache-2.0
// Part of workstreams: https://github.com/YangXu1990uiuc/workstreams

import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensurePrivateDir, type Paths, resolvePaths } from "./common/paths.ts";
import {
  type DaemonMessage,
  type DaemonRequest,
  decodeJson,
  encodeJsonFrame,
  FrameDecoder,
  type HelloResult,
  KIND_JSON,
  type SessionInfo,
} from "./common/protocol.ts";
import { VERSION } from "./common/version.ts";

const DEFAULT_PORT = 7777;
const DEFAULT_HOST = "127.0.0.1";

const USAGE = `workstreams ${VERSION}: persistent terminals in the browser

Usage:
  workstreams up [--port N] [--host ADDR] [--allow-host NAME]...
                        start the daemon and the server in the background
  workstreams down [--all]
                        stop the server; --all also stops the daemon, ending every session
  workstreams status    show what is running
  workstreams token     print the login token and link
  workstreams new [--size 120x36] [--cwd DIR] [-- COMMAND...]
                        create a session (COMMAND is typed into its shell)
  workstreams ls        list sessions
  workstreams daemon    run the daemon in the foreground
  workstreams server [--port N] [--host ADDR] [--allow-host NAME]...
                        run the server in the foreground
`;

interface ServerState {
  pid: number;
  host: string;
  port: number;
}

interface Flags {
  values: Map<string, string[]>;
  rest: string[];
}

function parseFlags(args: string[], known: string[]): Flags {
  const values = new Map<string, string[]>();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      rest.push(...args.slice(i + 1));
      break;
    }
    const [name, inline] = arg.startsWith("--") ? arg.slice(2).split("=", 2) : [undefined, undefined];
    if (name === undefined) {
      rest.push(arg);
      continue;
    }
    if (!known.includes(name)) fail(`unknown option --${name}\n\n${USAGE}`);
    const isBoolean = name === "all";
    const value = isBoolean ? "true" : (inline ?? args[++i]);
    if (value === undefined) fail(`--${name} needs a value`);
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  return { values, rest };
}

function flag(flags: Flags, name: string): string | undefined {
  return flags.values.get(name)?.at(-1);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// ---- talking to the daemon -------------------------------------------------------------

function daemonCall<T>(paths: Paths, request: DaemonRequest): Promise<T> {
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
        connected.write(encodeJsonFrame({ ...request, t: "req", id: 1 }));
        timer = setTimeout(() => settle(() => reject(new Error("the daemon did not answer"))), 5000);
      })
      .catch(() => settle(() => reject(new Error("the daemon is not running (start it with `workstreams up`)"))));
  });
}

async function daemonHello(paths: Paths): Promise<HelloResult | null> {
  if (!existsSync(paths.daemonSocket)) return null;
  try {
    return await daemonCall<HelloResult>(paths, { op: "hello", protocol: 1, client: "workstreams-cli" });
  } catch {
    return null;
  }
}

// ---- background processes --------------------------------------------------------------

/** Command line that re-runs this program, whether compiled or run from source with bun. */
function selfArgv(args: string[]): string[] {
  const compiled = Bun.main.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(Bun.main);
  return compiled ? [process.execPath, ...args] : [process.execPath, Bun.main, ...args];
}

function spawnDetached(argv: string[], logFile: string): void {
  const out = openSync(logFile, "a", 0o600);
  // A new session (setsid) and no controlling terminal: closing the terminal that ran
  // `workstreams up` must not take the daemon with it.
  const child = spawn(argv[0]!, argv.slice(1), {
    detached: true,
    stdio: ["ignore", out, out],
    cwd: homedir(),
    env: process.env,
  });
  child.unref();
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await Bun.sleep(100);
  }
  return false;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readServerState(paths: Paths): ServerState | null {
  try {
    const state = JSON.parse(readFileSync(join(paths.stateDir, "server.json"), "utf8")) as ServerState;
    return isAlive(state.pid) ? state : null;
  } catch {
    return null;
  }
}

function serverUrl(host: string, port: number): string {
  const shown = host === "0.0.0.0" || host === "::" ? "localhost" : host.includes(":") ? `[${host}]` : host;
  return `http://${shown}:${port}`;
}

async function serverHealthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
    return response.ok && ((await response.json()) as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
}

async function loginLink(paths: Paths, url: string): Promise<string> {
  const { loadOrCreateToken } = await import("./server/auth.ts");
  return `${url}/#token=${loadOrCreateToken(paths.tokenFile)}`;
}

// ---- commands --------------------------------------------------------------------------

async function cmdUp(args: string[]): Promise<void> {
  const flags = parseFlags(args, ["port", "host", "allow-host"]);
  const port = Number(flag(flags, "port") ?? DEFAULT_PORT);
  const host = flag(flags, "host") ?? DEFAULT_HOST;
  const allowHosts = flags.values.get("allow-host") ?? [];
  const paths = resolvePaths();
  ensurePrivateDir(paths.stateDir);

  if (await daemonHello(paths)) {
    console.log("daemon  already running");
  } else {
    spawnDetached(selfArgv(["daemon"]), paths.daemonLog);
    if (!(await waitFor(async () => (await daemonHello(paths)) !== null, 5000))) {
      fail(`the daemon did not start; see ${paths.daemonLog}`);
    }
    console.log("daemon  started");
  }

  const running = readServerState(paths);
  const url = serverUrl(running?.host ?? host, running?.port ?? port);
  if (running && (await serverHealthy(url))) {
    console.log(`server  already running at ${url}`);
  } else {
    const allow = allowHosts.flatMap((name) => ["--allow-host", name]);
    spawnDetached(selfArgv(["server", "--port", String(port), "--host", host, ...allow]), paths.serverLog);
    if (!(await waitFor(() => serverHealthy(url), 10_000))) {
      fail(`the server did not start; see ${paths.serverLog}`);
    }
    console.log(`server  started at ${url}`);
  }

  console.log(`\nOpen ${await loginLink(paths, url)}`);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(running?.host ?? host);
  if (loopback) {
    const shownPort = running?.port ?? port;
    console.log(
      `From another computer: ssh -L ${shownPort}:localhost:${shownPort} <this server>, then open the link there.`,
    );
  }
}

async function cmdDown(args: string[]): Promise<void> {
  const flags = parseFlags(args, ["all"]);
  const paths = resolvePaths();
  const server = readServerState(paths);
  if (server) {
    process.kill(server.pid, "SIGTERM");
    await waitFor(async () => !isAlive(server.pid), 5000);
    console.log("server  stopped");
  } else {
    console.log("server  not running");
  }
  if (!flag(flags, "all")) return;
  const hello = await daemonHello(paths);
  if (!hello) {
    console.log("daemon  not running");
    return;
  }
  process.kill(hello.pid, "SIGTERM");
  await waitFor(async () => !isAlive(hello.pid), 5000);
  console.log("daemon  stopped (all sessions ended)");
}

async function cmdStatus(): Promise<void> {
  const paths = resolvePaths();
  const hello = await daemonHello(paths);
  if (hello) {
    const list = await daemonCall<SessionInfo[]>(paths, { op: "list" });
    console.log(`daemon  running  pid ${hello.pid}  v${hello.version}  ${list.length} session(s)`);
  } else {
    console.log("daemon  not running");
  }
  const server = readServerState(paths);
  if (server) console.log(`server  running  pid ${server.pid}  ${serverUrl(server.host, server.port)}`);
  else console.log("server  not running");
}

async function cmdToken(): Promise<void> {
  const paths = resolvePaths();
  const server = readServerState(paths);
  const url = server ? serverUrl(server.host, server.port) : serverUrl(DEFAULT_HOST, DEFAULT_PORT);
  const link = await loginLink(paths, url);
  console.log(link.slice(link.indexOf("#token=") + 7));
  console.log(`\nLogin link: ${link}`);
}

async function cmdNew(args: string[]): Promise<void> {
  const flags = parseFlags(args, ["size", "cwd"]);
  const match = /^(\d+)x(\d+)$/i.exec(flag(flags, "size") ?? "120x36");
  if (!match) fail("--size must look like 120x36");
  const session = await daemonCall<SessionInfo>(resolvePaths(), {
    op: "create",
    cols: Number(match[1]),
    rows: Number(match[2]),
    cwd: flag(flags, "cwd") ?? process.cwd(),
    cmd: flags.rest.length ? flags.rest.join(" ") : undefined,
  });
  console.log(session.id);
}

async function cmdList(): Promise<void> {
  const list = await daemonCall<SessionInfo[]>(resolvePaths(), { op: "list" });
  if (list.length === 0) {
    console.log("no sessions");
    return;
  }
  for (const session of list) {
    const state = session.exited ? `exited ${session.exited.code ?? session.exited.signal}` : `pid ${session.pid}`;
    const label = session.title || session.cmd || session.cwd;
    console.log(`${session.id}  ${`${session.cols}x${session.rows}`.padEnd(8)} ${state.padEnd(12)} ${label}`);
  }
}

async function cmdDaemon(): Promise<void> {
  const paths = resolvePaths();
  const { startDaemon } = await import("./daemon/daemon.ts");
  const handle = await startDaemon({ paths }).catch((error: Error) => fail(error.message));
  writeFileSync(paths.daemonPidFile, `${process.pid}\n`, { mode: 0o600 });
  const shutdown = async () => {
    await handle.stop();
    rmSync(paths.daemonPidFile, { force: true });
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

async function cmdServer(args: string[]): Promise<void> {
  const flags = parseFlags(args, ["port", "host", "allow-host"]);
  const paths = resolvePaths();
  const host = flag(flags, "host") ?? DEFAULT_HOST;
  const { startServer } = await import("./server/server.ts");
  const handle = await startServer({
    paths,
    host,
    port: Number(flag(flags, "port") ?? DEFAULT_PORT),
    allowHosts: flags.values.get("allow-host") ?? [],
    development: process.env.WORKSTREAMS_DEV === "1",
  }).catch((error: Error) => fail(error.message));
  const stateFile = join(paths.stateDir, "server.json");
  const state: ServerState = { pid: process.pid, host, port: handle.port };
  writeFileSync(stateFile, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  const shutdown = async () => {
    await handle.stop();
    rmSync(stateFile, { force: true });
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

const [command, ...args] = process.argv.slice(2);
try {
  switch (command) {
    case "up":
      await cmdUp(args);
      break;
    case "down":
      await cmdDown(args);
      break;
    case "status":
      await cmdStatus();
      break;
    case "token":
      await cmdToken();
      break;
    case "new":
      await cmdNew(args);
      break;
    case "ls":
      await cmdList();
      break;
    case "daemon":
      await cmdDaemon();
      break;
    case "server":
      await cmdServer(args);
      break;
    case "version":
    case "--version":
    case "-v":
      console.log(VERSION);
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      break;
    default:
      fail(`unknown command: ${command}\n\n${USAGE}`);
  }
} catch (error) {
  fail((error as Error).message);
}
