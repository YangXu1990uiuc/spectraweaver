#!/usr/bin/env bun
// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, openSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir, hostname, networkInterfaces, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { autostartLine, findAutostart, readCrontab, withAutostart, writeCrontab } from "./autostart.ts";
import { loadInstance, loadSettings, migrateOlderState, saveInstance, saveSettings } from "./common/config.ts";
import { networkFilesystem, writeFileAtomic } from "./common/files.ts";
import { isLoopbackAddress, pickFreePort, portIsFree } from "./common/net.ts";
import { ensurePrivateDir, expandHome, hostKey, type Paths, requireSocket, resolvePaths, socketPathProblem } from "./common/paths.ts";
import { asksForHelp, fail, FIRST_PORT, flag, noArguments, parseFlags, USAGE } from "./cli-args.ts";
import { daemonCall, daemonHello, isAlive, readServerState, type ServerState, serverUrl } from "./client.ts";
import type { SessionInfo } from "./common/protocol.ts";
import { VERSION } from "./common/version.ts";
import { BOARD_HELP, cmdBoard } from "./board-cli.ts";
import { cmdBanner, cmdClose, cmdList, cmdNew, cmdRead, cmdSend, cmdShowHide, cmdWait } from "./control.ts";

const PORT_SEARCH = 100;
const DEFAULT_HOST = "127.0.0.1";
const MAX_LOG_BYTES = 5 * 1024 * 1024;

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


// ---- background processes --------------------------------------------------------------

/** Command line that re-runs this program, whether compiled or run from source with bun. */
function selfArgv(args: string[]): string[] {
  const compiled = Bun.main.startsWith("/$bunfs/");
  return compiled ? [process.execPath, ...args] : [process.execPath, Bun.main, ...args];
}

// The directory this checkout lives in (src/cli.ts -> ..). The web server must run from here: Bun's HTML
// import bundles src/web/index.html at startup and writes the chunk URLs into the page relative to the
// process's working directory, so a server started from a directory that is not an ancestor of the checkout
// (a home directory on another mount) serves a page whose script and stylesheet are 404 -- a blank screen.
// cmdServer moves there, however the server was started. A compiled binary has no checkout.
function checkoutDir(): string | undefined {
  const dir = resolve(import.meta.dir, "..");
  return existsSync(join(dir, "package.json")) ? dir : undefined;
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




/** The address to open in a browser. A wildcard bind is reached by this machine's name. */
function browserUrl(host: string, port: number): string {
  return host === "0.0.0.0" || host === "::" ? `http://${hostname()}:${port}` : serverUrl(host, port);
}

/** IPv4 addresses of real network interfaces (not container bridges), to offer instead of the name. */
function lanAddresses(): string[] {
  return Object.entries(networkInterfaces())
    .filter(([name]) => !/^(docker|br-|veth|virbr|cni|flannel|lxc)/.test(name))
    .flatMap(([, infos]) => infos ?? [])
    .filter((info) => info.family === "IPv4" && !info.internal)
    .map((info) => info.address);
}

/** The server's health report, or null if nothing (or not SpectraWeaver) answers there. */
async function probeServer(url: string): Promise<{ uid: number | null; pid: number | null } | null> {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
    const health = (await response.json()) as { ok?: boolean; uid?: number | null; pid?: number | null };
    return response.ok && health.ok === true ? { uid: health.uid ?? null, pid: health.pid ?? null } : null;
  } catch {
    return null;
  }
}

/**
 * The server server.json names, if that process is one: it answers on its port with its pid, or
 * (hung, or older than naming its pid) it runs `spectraweaver server`. After a crash or a power
 * cut the file can name a pid another program has since been given; then the file is removed,
 * and nothing is stopped.
 */
async function verifiedServer(paths: Paths): Promise<ServerState | null> {
  const server = readServerState(paths);
  if (!server) return null;
  const probe = await probeServer(serverUrl(server.host, server.port));
  if (probe?.pid != null ? probe.pid === server.pid : runsServer(server.pid)) return server;
  rmSync(paths.serverStateFile, { force: true });
  return null;
}

/** Whether a process runs `spectraweaver server` (the binary, or src/cli.ts under Bun). */
function runsServer(pid: number): boolean {
  try {
    const argv =
      process.platform === "linux"
        ? readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")
        : Bun.spawnSync(["ps", "-ww", "-o", "command=", "-p", String(pid)]).stdout.toString().trim().split(/\s+/);
    return argv.includes("server") && argv.some((part) => /spectraweaver|cli\.ts$/.test(part));
  } catch {
    return false;
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
  requireSocket(paths);
  ensurePrivateDir(paths.stateDir);
  const instance = loadInstance(paths);
  const requestedPort = flag(flags, "port");
  noArguments(flags, "up");
  const host = flag(flags, "host") ?? instance.host ?? DEFAULT_HOST;
  const allowHosts = flags.values.get("allow-host") ?? instance.allowHosts ?? [];

  if (await daemonHello(paths)) {
    console.log("daemon  already running");
  } else {
    spawnDetached(selfArgv(["daemon"]), paths.daemonLog);
    if (!(await waitFor(async () => (await daemonHello(paths)) !== null, 5000))) {
      fail(`the daemon did not start; see ${paths.daemonLog}`);
    }
    console.log("daemon  started");
  }

  let url: string; // for probing the server from here
  let link: string; // for opening in a browser
  const running = await verifiedServer(paths);
  if (running) {
    url = serverUrl(running.host, running.port);
    link = browserUrl(running.host, running.port);
    const change =
      requestedPort && Number(requestedPort) !== running.port
        ? `runs on port ${running.port}`
        : flag(flags, "host") && flag(flags, "host") !== running.host
          ? `listens on ${running.host}`
          : flags.values.has("allow-host")
            ? "has its allowed names"
            : null;
    if (change) fail(`the server already ${change}; run \`spectraweaver down\` first to change it`);
    if (!(await waitFor(() => isOwnServer(url), 5000))) {
      fail(`the server (pid ${running.pid}) is not responding; see ${paths.serverLog}`);
    }
    console.log(`server  already running at ${link}`);
  } else {
    checkRemoteExposure(host, flag(flags, "allow-remote") !== undefined || instance.host === host);
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
    link = browserUrl(host, port);
    const allow = allowHosts.flatMap((name) => ["--allow-host", name]);
    const remote = isLoopbackAddress(host) ? [] : ["--allow-remote"];
    spawnDetached(
      selfArgv(["server", "--port", String(port), "--host", host, ...remote, ...allow]),
      paths.serverLog,
    );
    if (!(await waitFor(() => isOwnServer(url), 10_000))) {
      fail(`the server did not start; see ${paths.serverLog}`);
    }
    saveInstance(paths, { ...instance, port, host, allowHosts: allowHosts.length > 0 ? allowHosts : undefined });
    console.log(`server  started at ${link}`);
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
    console.log(`\nBookmark ${link}/ and sign in with your password.`);
  } else {
    const { loadOrCreateToken } = await import("./server/auth.ts");
    console.log(`\nOpen ${link}/#token=${loadOrCreateToken(paths.tokenFile)}`);
    console.log(`Tip: run \`spectraweaver passwd\` to sign in with a password instead, then bookmark ${link}/`);
  }
  const port = new URL(url).port;
  const bound = running?.host ?? host;
  if (["127.0.0.1", "localhost", "::1"].includes(bound)) {
    console.log(`From another computer, run there: ssh -L ${port}:localhost:${port} <this server>`);
  } else if (bound === "0.0.0.0" || bound === "::") {
    const byAddress = lanAddresses().map((address) => `http://${address}:${port}/`);
    if (byAddress.length > 0) console.log(`If the name does not resolve there, use ${byAddress.join(" or ")}`);
  }
  if (process.platform === "linux" && autostartStatus(paths).startsWith("not started")) {
    console.log("Tip: `spectraweaver autostart on` starts it again when this host reboots.");
  }
}

async function cmdDown(args: string[]): Promise<void> {
  const flags = parseFlags(args, ["all"]);
  noArguments(flags, "down");
  const paths = resolvePaths();
  const server = await verifiedServer(paths);
  if (server) {
    process.kill(server.pid, "SIGTERM");
    if (!(await waitFor(async () => !isAlive(server.pid), 5000))) fail(`the server (pid ${server.pid}) did not stop`);
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
  if (!(await waitFor(async () => !isAlive(hello.pid), 5000))) fail(`the daemon (pid ${hello.pid}) did not stop`);
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
  const server = await verifiedServer(paths);
  if (server) console.log(`server  running  pid ${server.pid}  ${browserUrl(server.host, server.port)}`);
  else console.log("server  not running");
  console.log(`login   ${existsSync(paths.passwordFile) ? "password or token" : "token (no password set)"}`);
  console.log(`state   ${paths.stateDir}`);
  if (process.platform === "linux") console.log(`boot    ${autostartStatus(paths)}`);
}

/** What `spectraweaver autostart on` would put in the crontab for this checkout and Bun. */
function plannedAutostart(paths: Paths): string {
  const env: Record<string, string> = {};
  for (const name of ["SPECTRAWEAVER_HOME", "SPECTRAWEAVER_CONFIG_DIR", "SPECTRAWEAVER_STATE_DIR"]) {
    const value = process.env[name];
    if (value) env[name] = resolve(expandHome(value));
  }
  let shell = process.env.SHELL || "/bin/sh";
  try {
    shell = userInfo().shell || shell;
  } catch {
    // no passwd entry (containers)
  }
  return autostartLine({ argv: selfArgv(["up"]), shell, env, log: join(paths.stateDir, "autostart.log") });
}

function autostartStatus(paths: Paths): string {
  let installed: string | undefined;
  try {
    installed = findAutostart(readCrontab());
  } catch (error) {
    return `unknown: ${(error as Error).message}`;
  }
  if (!installed) return "not started at boot (`spectraweaver autostart on` does it)";
  if (installed !== plannedAutostart(paths)) {
    return "started at boot, but by a line written for another checkout or Bun; run `spectraweaver autostart on` again";
  }
  return "started at boot (crontab @reboot)";
}

async function cmdAutostart(args: string[]): Promise<void> {
  const [action, extra] = parseFlags(args, []).rest;
  if (extra !== undefined || (action !== undefined && action !== "on" && action !== "off")) {
    fail("usage: spectraweaver autostart [on | off]");
  }
  if (process.platform !== "linux") {
    fail("autostart uses cron's @reboot, which only Linux runs reliably; on macOS, use a launchd agent that runs `spectraweaver up`.");
  }
  const paths = resolvePaths();
  if (action === undefined) {
    console.log(`On ${hostname()}, SpectraWeaver is ${autostartStatus(paths)}.`);
    return;
  }
  const crontab = readCrontab();
  if (action === "off") {
    if (!findAutostart(crontab)) {
      console.log("autostart is already off");
      return;
    }
    writeCrontab(withAutostart(crontab, null));
    console.log(`autostart off: ${hostname()} no longer starts SpectraWeaver at boot`);
    return;
  }
  // The boot line logs into the state directory; at boot, a missing one means it is not mounted yet.
  ensurePrivateDir(paths.stateDir);
  writeCrontab(withAutostart(crontab, plannedAutostart(paths)));
  console.log(
    `autostart on: when ${hostname()} boots, cron runs \`spectraweaver up\` in your login shell, so terminals\n` +
      "get the same PATH as when you sign in. It retries for 5 minutes if the home directory or network is late.\n" +
      `Log: ${join(paths.stateDir, "autostart.log")}\n` +
      "After a reboot, open the page and press ↻ Restore to bring your terminals back.\n" +
      "If you move this checkout or Bun, run `spectraweaver autostart on` again. Other hosts are not affected.",
  );
}

async function cmdPasswd(args: string[]): Promise<void> {
  const flags = parseFlags(args, ["clear"]);
  noArguments(flags, "passwd");
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
  noArguments(flags, "token");
  const paths = resolvePaths();
  const { loadOrCreateToken, rotateToken } = await import("./server/auth.ts");
  const token = flag(flags, "rotate") ? rotateToken(paths.tokenFile) : loadOrCreateToken(paths.tokenFile);
  const server = readServerState(paths);
  const instance = loadInstance(paths);
  // As `up` prints it: a server on every interface is reached by this host's name.
  const url = server
    ? browserUrl(server.host, server.port)
    : browserUrl(instance.host ?? DEFAULT_HOST, instance.port ?? FIRST_PORT);
  console.log(token);
  console.log(`\nLogin link: ${url}/#token=${token}`);
  if (flag(flags, "rotate")) console.log("The old token and every browser login are no longer valid.");
}

async function cmdResize(args: string[]): Promise<void> {
  const [id, size] = args;
  const match = /^(\d+)x(\d+)$/i.exec(size ?? "");
  if (!id || !match) fail("usage: spectraweaver resize ID COLSxROWS, for example: spectraweaver resize 1a2b3c4d 132x40");
  const paths = resolvePaths();
  const hello = await daemonHello(paths);
  if (hello && !hello.features?.includes("resize")) {
    fail(
      "this daemon predates resizing; restart it with `spectraweaver down --all` (every session ends), then `spectraweaver up`",
    );
  }
  const session = await daemonCall<SessionInfo>(paths, {
    op: "resize",
    session: id,
    cols: Number(match[1]),
    rows: Number(match[2]),
  });
  console.log(`${session.id}  ${session.cols}x${session.rows}`);
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
    const problem = socketPathProblem(join(base, hostKey(), "daemon.sock"));
    if (problem) fail(`${base} is a path ${problem} for the daemon's socket; choose a shorter one.`);
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
  // Paths are resolved first, against the directory the command ran in.
  const checkout = checkoutDir();
  if (checkout) process.chdir(checkout);
  const instance = loadInstance(paths);
  const host = flag(flags, "host") ?? instance.host ?? DEFAULT_HOST;
  checkRemoteExposure(host, flag(flags, "allow-remote") !== undefined || instance.host === host);
  const { startServer } = await import("./server/server.ts");
  const handle = await startServer({
    paths,
    host,
    port: Number(flag(flags, "port") ?? instance.port ?? FIRST_PORT),
    allowHosts: flags.values.get("allow-host") ?? instance.allowHosts ?? [],
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
  // `spectraweaver down -h` asks how to use it; it must not stop anything.
  if (command !== undefined && asksForHelp(args)) {
    console.log(command === "board" ? BOARD_HELP : USAGE);
    process.exit(0);
  }
  switch (command) {
    case "up":
      await cmdUp(args);
      break;
    case "down":
      await cmdDown(args);
      break;
    case "status":
      noArguments(parseFlags(args, []), "status");
      await cmdStatus();
      break;
    case "autostart":
      await cmdAutostart(args);
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
    case "resize":
      await cmdResize(args);
      break;
    case "ls":
      await cmdList(args);
      break;
    case "read":
      await cmdRead(args);
      break;
    case "send":
      await cmdSend(args);
      break;
    case "wait":
      await cmdWait(args);
      break;
    case "banner":
      await cmdBanner(args);
      break;
    case "close":
      await cmdClose(args);
      break;
    case "show":
      await cmdShowHide(args, false);
      break;
    case "hide":
      await cmdShowHide(args, true);
      break;
    case "board":
      await cmdBoard(args);
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
