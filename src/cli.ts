#!/usr/bin/env bun
// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, openSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadInstance, loadSettings, migrateOlderState, saveInstance, saveSettings } from "./common/config.ts";
import { networkFilesystem, writeFileAtomic } from "./common/files.ts";
import { isLoopbackAddress, pickFreePort, portIsFree } from "./common/net.ts";
import { ensurePrivateDir, expandHome, hostKey, MAX_SOCKET_PATH, type Paths, resolvePaths } from "./common/paths.ts";
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

const FIRST_PORT = 7777;
const PORT_SEARCH = 100;
const DEFAULT_HOST = "127.0.0.1";
const BOOLEAN_FLAGS = new Set(["all", "clear", "rotate", "reset", "allow-remote"]);
const MAX_LOG_BYTES = 5 * 1024 * 1024;

const USAGE = `spectraweaver ${VERSION}: persistent terminals in the browser

Usage:
  spectraweaver up [--port N] [--host ADDR --allow-remote] [--allow-host NAME]...
                        start the daemon and the server in the background
                        (the first run picks a free port from ${FIRST_PORT} and remembers it;
                        listening beyond localhost needs --allow-remote: see SECURITY.md)
  spectraweaver down [--all]
                        stop the server; --all also stops the daemon, ending every session
  spectraweaver status    show what is running
  spectraweaver passwd [--clear]
                        set (or remove) the password for signing in from the browser
  spectraweaver token [--rotate]
                        print the login token and link; --rotate replaces it
  spectraweaver new [--size 120x36] [--cwd DIR] [-- COMMAND...]
                        create a session (COMMAND is typed into its shell)
  spectraweaver ls        list sessions
  spectraweaver config    show where config and state live
  spectraweaver config state-dir PATH | --reset
                        keep state (socket, logs, tabs) under PATH, e.g. on a local disk
                        when the home directory is small or on NFS
  spectraweaver daemon    run the daemon in the foreground
  spectraweaver server [--port N] [--host ADDR --allow-remote] [--allow-host NAME]...
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
    const value = BOOLEAN_FLAGS.has(name) ? "true" : (inline ?? args[++i]);
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

/**
 * SpectraWeaver is a shell in a web page, so listening beyond localhost needs an explicit
 * --allow-remote. A remembered non-loopback host counts as an earlier opt-in.
 */
function checkRemoteExposure(host: string, optedIn: boolean): void {
  if (isLoopbackAddress(host)) return;
  if (!optedIn) {
    fail(
      `Refusing to listen on ${host}. SpectraWeaver gives a shell to whoever signs in, and this would make it\n` +
        "reachable from the network over plain HTTP (passwords and terminal contents unencrypted).\n" +
        "Keep the default (127.0.0.1) and reach it through an SSH tunnel or a VPN. If you really mean it,\n" +
        "for example behind an HTTPS reverse proxy on a trusted network, add --allow-remote.\n" +
        "Never expose SpectraWeaver to the internet. See SECURITY.md.",
    );
  }
  console.error(
    `WARNING: listening on ${host} over plain HTTP. Anyone who can reach it can try to sign in, and traffic\n` +
      "is unencrypted. Never expose it to the internet; prefer an SSH tunnel, a VPN or an HTTPS reverse proxy.",
  );
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
      .catch(() => settle(() => reject(new Error("the daemon is not running (start it with `spectraweaver up`)"))));
  });
}

async function daemonHello(paths: Paths): Promise<HelloResult | null> {
  if (!existsSync(paths.daemonSocket)) return null;
  try {
    return await daemonCall<HelloResult>(paths, { op: "hello", protocol: 1, client: "spectraweaver-cli" });
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
  // Keep logs small: home directories are often tiny.
  if ((statSync(logFile, { throwIfNoEntry: false })?.size ?? 0) > MAX_LOG_BYTES) {
    renameSync(logFile, `${logFile}.1`);
  }
  const out = openSync(logFile, "a", 0o600);
  // A new session (setsid) and no controlling terminal: closing the terminal that ran
  // `spectraweaver up` must not take the daemon with it.
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
    const state = JSON.parse(readFileSync(paths.serverStateFile, "utf8")) as ServerState;
    return isAlive(state.pid) ? state : null;
  } catch {
    return null;
  }
}

function serverUrl(host: string, port: number): string {
  const shown = host === "0.0.0.0" || host === "::" ? "localhost" : host.includes(":") ? `[${host}]` : host;
  return `http://${shown}:${port}`;
}

/** The server's health report, or null if nothing (or not SpectraWeaver) answers there. */
async function probeServer(url: string): Promise<{ uid: number | null } | null> {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
    const health = (await response.json()) as { ok?: boolean; uid?: number | null };
    return response.ok && health.ok === true ? { uid: health.uid ?? null } : null;
  } catch {
    return null;
  }
}

async function isOwnServer(url: string): Promise<boolean> {
  const probe = await probeServer(url);
  return probe !== null && probe.uid === (process.getuid?.() ?? null);
}

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const text = await Bun.stdin.text();
    return text.split(/\r?\n/)[0] ?? "";
  }
  process.stdout.write(prompt);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve) => {
    let value = "";
    const finish = (result: string | null) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      if (result === null) process.exit(130);
      resolve(result);
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") return finish(value);
        if (char === "\x03") return finish(null);
        if (char === "\x7f" || char === "\b") value = [...value].slice(0, -1).join("");
        else if (char >= " ") value += char;
      }
    };
    stdin.on("data", onData);
  });
}

// ---- commands --------------------------------------------------------------------------

async function cmdUp(args: string[]): Promise<void> {
  const flags = parseFlags(args, ["port", "host", "allow-host", "allow-remote"]);
  for (const change of migrateOlderState(resolvePaths())) console.log(change);
  const paths = resolvePaths();
  ensurePrivateDir(paths.stateDir);
  const instance = loadInstance(paths);
  const requestedPort = flag(flags, "port");
  const host = flag(flags, "host") ?? instance.host ?? DEFAULT_HOST;
  const allowHosts = flags.values.get("allow-host") ?? [];
  checkRemoteExposure(host, flag(flags, "allow-remote") !== undefined || instance.host === host);

  if (await daemonHello(paths)) {
    console.log("daemon  already running");
  } else {
    spawnDetached(selfArgv(["daemon"]), paths.daemonLog);
    if (!(await waitFor(async () => (await daemonHello(paths)) !== null, 5000))) {
      fail(`the daemon did not start; see ${paths.daemonLog}`);
    }
    console.log("daemon  started");
  }

  let url: string;
  const running = readServerState(paths);
  if (running) {
    url = serverUrl(running.host, running.port);
    if (requestedPort && Number(requestedPort) !== running.port) {
      fail(`the server already runs on port ${running.port}; run \`spectraweaver down\` first to change it`);
    }
    if (!(await waitFor(() => isOwnServer(url), 5000))) {
      fail(`the server (pid ${running.pid}) is not responding; see ${paths.serverLog}`);
    }
    console.log(`server  already running at ${url}`);
  } else {
    let port = requestedPort ? Number(requestedPort) : instance.port;
    if (port === undefined) {
      port = pickFreePort(host, FIRST_PORT, PORT_SEARCH) ?? undefined;
      if (port === undefined) {
        fail(`no free port between ${FIRST_PORT} and ${FIRST_PORT + PORT_SEARCH - 1}; choose one with --port`);
      }
    } else if (!Number.isInteger(port) || port < 1 || port > 65535) {
      fail(`invalid port: ${requestedPort}`);
    } else if (!portIsFree(host, port)) {
      const other = await probeServer(serverUrl(host, port));
      const holder = !other
        ? "another program"
        : other.uid === (process.getuid?.() ?? null)
          ? "another SpectraWeaver instance of yours (a different state directory)"
          : "another user's SpectraWeaver";
      fail(`port ${port} is used by ${holder}; choose another with --port`);
    }
    url = serverUrl(host, port);
    const allow = allowHosts.flatMap((name) => ["--allow-host", name]);
    const remote = isLoopbackAddress(host) ? [] : ["--allow-remote"];
    spawnDetached(
      selfArgv(["server", "--port", String(port), "--host", host, ...remote, ...allow]),
      paths.serverLog,
    );
    if (!(await waitFor(() => isOwnServer(url), 10_000))) {
      fail(`the server did not start; see ${paths.serverLog}`);
    }
    saveInstance(paths, { ...instance, port, host });
    console.log(`server  started at ${url}`);
  }
  console.log(`state   ${paths.stateDir}`);
  const remote = networkFilesystem(paths.stateDir);
  if (remote) {
    console.log(
      `        (on ${remote}: this works, but a local disk is faster; see \`spectraweaver config state-dir\`)`,
    );
  }

  const passwordSet = existsSync(paths.passwordFile);
  if (passwordSet) {
    console.log(`\nBookmark ${url}/ and sign in with your password.`);
  } else {
    const { loadOrCreateToken } = await import("./server/auth.ts");
    console.log(`\nOpen ${url}/#token=${loadOrCreateToken(paths.tokenFile)}`);
    console.log(`Tip: run \`spectraweaver passwd\` to sign in with a password instead, then bookmark ${url}/`);
  }
  const port = new URL(url).port;
  if (["127.0.0.1", "localhost", "::1"].includes(running?.host ?? host)) {
    console.log(`From another computer: ssh -L ${port}:localhost:${port} <this server>`);
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
  console.log(`login   ${existsSync(paths.passwordFile) ? "password or token" : "token (no password set)"}`);
  console.log(`state   ${paths.stateDir}`);
}

async function cmdPasswd(args: string[]): Promise<void> {
  const flags = parseFlags(args, ["clear"]);
  const paths = resolvePaths();
  const { clearPassword, setPassword, validatePassword } = await import("./server/auth.ts");
  if (flag(flags, "clear")) {
    clearPassword(paths.passwordFile);
    console.log("Password removed. Sign in with the token link from `spectraweaver token`.");
    return;
  }
  const password = await readSecret("New password: ");
  const problem = validatePassword(password);
  if (problem) fail(`Password not set: ${problem}.`);
  if (process.stdin.isTTY && (await readSecret("Repeat it: ")) !== password) {
    fail("Password not set: the two entries differ.");
  }
  await setPassword(paths.passwordFile, password);
  console.log("Password set. Browsers that were signed in need to sign in again.");
}

async function cmdToken(args: string[]): Promise<void> {
  const flags = parseFlags(args, ["rotate"]);
  const paths = resolvePaths();
  const { loadOrCreateToken, rotateToken } = await import("./server/auth.ts");
  const token = flag(flags, "rotate") ? rotateToken(paths.tokenFile) : loadOrCreateToken(paths.tokenFile);
  const server = readServerState(paths);
  const instance = loadInstance(paths);
  const url = server
    ? serverUrl(server.host, server.port)
    : serverUrl(instance.host ?? DEFAULT_HOST, instance.port ?? FIRST_PORT);
  console.log(token);
  console.log(`\nLogin link: ${url}/#token=${token}`);
  if (flag(flags, "rotate")) console.log("The old token and every browser login are no longer valid.");
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

async function cmdConfig(args: string[]): Promise<void> {
  const paths = resolvePaths();
  const [key, ...rest] = args;
  if (key === undefined) {
    console.log(`config  ${paths.configDir}   (token, password hash, settings; shared by your hosts)`);
    if (paths.pendingConfigDir) console.log(`        the former name's; \`spectraweaver up\` copies it to ${paths.pendingConfigDir}`);
    console.log(`state   ${paths.stateDir}   (this host: socket, logs, tabs)`);
    console.log(`        from ${paths.stateSource}`);
    const remote = networkFilesystem(paths.stateDir);
    if (remote) console.log(`        on ${remote}; a local disk is faster`);
    return;
  }
  if (key !== "state-dir") fail(`unknown setting: ${key}\n\n${USAGE}`);
  const flags = parseFlags(rest, ["reset"]);
  if (process.env.SPECTRAWEAVER_STATE_DIR || process.env.SPECTRAWEAVER_HOME) {
    console.log("Note: $SPECTRAWEAVER_STATE_DIR / $SPECTRAWEAVER_HOME is set and takes precedence over this setting.");
  }
  // Moving state under a running daemon would lose track of it (and of its sessions).
  if ((await daemonHello(paths)) || readServerState(paths)) {
    fail(
      `SpectraWeaver is running with state in ${paths.stateDir}.\n` +
        "Stop it first with `spectraweaver down --all` (this ends every session), then run this again.",
    );
  }
  const settings = loadSettings(paths);
  if (flag(flags, "reset")) {
    delete settings.stateDir;
  } else {
    const target = flags.rest[0];
    if (!target) fail("usage: spectraweaver config state-dir PATH | --reset");
    const base = resolve(expandHome(target));
    const socket = join(base, hostKey(), "daemon.sock");
    if (socket.length > MAX_SOCKET_PATH) {
      fail(`${base} is too long a path for the daemon's socket (${socket.length} bytes, limit ${MAX_SOCKET_PATH}); choose a shorter one.`);
    }
    ensurePrivateDir(join(base, hostKey()));
    settings.stateDir = base;
  }
  saveSettings(paths, settings);
  const next = resolvePaths();
  // Bring this host's tabs and instance settings (port, login cookie name) along.
  for (const name of ["meta.json", "instance.json"]) {
    const from = join(paths.stateDir, name);
    const to = join(next.stateDir, name);
    if (from !== to && existsSync(from) && !existsSync(to)) {
      ensurePrivateDir(next.stateDir);
      copyFileSync(from, to);
      console.log(`copied  ${name}`);
    }
  }
  console.log(`state   ${next.stateDir}`);
  const remote = networkFilesystem(next.stateDir);
  if (remote) console.log(`        on ${remote}: this works, but a local disk is faster`);
}

async function cmdDaemon(): Promise<void> {
  migrateOlderState(resolvePaths());
  const paths = resolvePaths();
  const { startDaemon } = await import("./daemon/daemon.ts");
  const handle = await startDaemon({ paths }).catch((error: Error) => fail(error.message));
  writeFileAtomic(paths.daemonPidFile, `${process.pid}\n`);
  const shutdown = async () => {
    await handle.stop();
    rmSync(paths.daemonPidFile, { force: true });
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

async function cmdServer(args: string[]): Promise<void> {
  const flags = parseFlags(args, ["port", "host", "allow-host", "allow-remote"]);
  migrateOlderState(resolvePaths());
  const paths = resolvePaths();
  const instance = loadInstance(paths);
  const host = flag(flags, "host") ?? instance.host ?? DEFAULT_HOST;
  checkRemoteExposure(host, flag(flags, "allow-remote") !== undefined || instance.host === host);
  const { startServer } = await import("./server/server.ts");
  const handle = await startServer({
    paths,
    host,
    port: Number(flag(flags, "port") ?? instance.port ?? FIRST_PORT),
    allowHosts: flags.values.get("allow-host") ?? [],
    development: process.env.SPECTRAWEAVER_DEV === "1",
  }).catch((error: Error) => fail(error.message));
  const state: ServerState = { pid: process.pid, host, port: handle.port };
  writeFileAtomic(paths.serverStateFile, `${JSON.stringify(state)}\n`);
  const shutdown = async () => {
    await handle.stop();
    rmSync(paths.serverStateFile, { force: true });
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
    case "passwd":
      await cmdPasswd(args);
      break;
    case "token":
      await cmdToken(args);
      break;
    case "new":
      await cmdNew(args);
      break;
    case "ls":
      await cmdList();
      break;
    case "config":
      await cmdConfig(args);
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
