// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

// The terminal commands as a coordinating agent uses them, against a real daemon and server,
// with fake Claude Code and Codex programs that act out working, waiting and stopping.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentStatus, SessionView, TabView } from "../src/common/protocol.ts";
import { type DaemonHandle, startDaemon } from "../src/daemon/daemon.ts";
import { type ServerHandle, startServer } from "../src/server/server.ts";
import { fixture, TEST_SHELL, tempPaths } from "./helpers.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

let temp: ReturnType<typeof tempPaths>;
let bin: string;
let log: string;
let project: string;
let env: Record<string, string | undefined>;
let daemon: DaemonHandle;
let server: ServerHandle;

beforeAll(async () => {
  temp = tempPaths();
  bin = realpathSync(mkdtempSync(join(tmpdir().length > 40 ? "/tmp" : tmpdir(), "sw-bin-")));
  for (const name of ["claude", "codex"]) {
    writeFileSync(join(bin, name), `#!/usr/bin/env bun\nimport ${JSON.stringify(fixture("fake-agent.ts"))};\n`);
    chmodSync(join(bin, name), 0o755);
  }
  log = join(bin, "log.jsonl");
  project = join(bin, "project");
  mkdirSync(project);
  const claudeDir = join(bin, "claude-home");
  const codexDir = join(bin, "codex-home");
  env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_AGENT_LOG: log,
    CLAUDE_CONFIG_DIR: claudeDir,
    CODEX_HOME: codexDir,
    SPECTRAWEAVER_CONFIG_DIR: temp.paths.configDir,
    SPECTRAWEAVER_STATE_DIR: temp.paths.stateBase,
  };
  daemon = await startDaemon({ paths: temp.paths, shellArgv: TEST_SHELL, env, log: () => {} });
  server = await startServer({
    paths: temp.paths,
    host: "127.0.0.1",
    port: 0,
    log: () => {},
    revivalEveryMs: 200,
    statusEveryMs: 100,
    agentDirs: { claude: claudeDir, codex: codexDir },
  });
  // What `spectraweaver server` writes, so the commands find this one.
  writeFileSync(temp.paths.serverStateFile, JSON.stringify({ pid: process.pid, host: "127.0.0.1", port: server.port }));
});

afterAll(async () => {
  await server.stop();
  await daemon.stop();
  temp.cleanup();
  rmSync(bin, { recursive: true, force: true });
});

async function run(args: string[], stdin?: string): Promise<{ code: number; out: string; err: string }> {
  const child = Bun.spawn(["bun", CLI, ...args], {
    env,
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out, err };
}

async function cli(...args: string[]): Promise<string> {
  const result = await run(args);
  if (result.code !== 0) throw new Error(`spectraweaver ${args.join(" ")} failed: ${result.err}`);
  return result.out;
}

async function listing(): Promise<{ sessions: SessionView[]; tabs: TabView[] }> {
  const token = readFileSync(temp.paths.tokenFile, "utf8").trim();
  const response = await fetch(`http://127.0.0.1:${server.port}/api/v1/sessions`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return (await response.json()) as { sessions: SessionView[]; tabs: TabView[] };
}

async function session(id: string): Promise<SessionView | undefined> {
  return (await listing()).sessions.find((candidate) => candidate.id === id);
}

async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(value)}`);
    await Bun.sleep(50);
  }
}

const agentOf = async (id: string) => (await session(id))?.agent;
const typedLines = () =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { line?: string })
        .flatMap((entry) => (entry.line === undefined ? [] : [entry.line]))
    : [];

function expectAgent(agent: AgentStatus | undefined, expected: Partial<AgentStatus>): boolean {
  return agent !== undefined && Object.entries(expected).every(([key, value]) => agent[key as keyof AgentStatus] === value);
}

test("terminals opened from the command line land in their tab, and their agents' states show", async () => {
  const id = (await cli("new", "--tab", "Workers", "--banner", "w1", "--cwd", project, "--", "claude")).trim();
  expect(id).toMatch(/^[0-9a-f]{8}$/);
  await eventually(() => agentOf(id), (agent) => expectAgent(agent, { name: "claude", activity: "idle" }), "claude idle");
  const listed = await listing();
  const created = listed.sessions.find((candidate) => candidate.id === id)!;
  expect(created.banner).toBe("w1");
  expect(listed.tabs.find((tab) => tab.id === created.tab)?.name).toBe("Workers");
  // A tab is found by name, whatever its case: no second "Workers".
  const second = (await cli("new", "--tab", "workers", "--", "true")).trim();
  expect((await session(second))?.tab).toBe(created.tab);
  await cli("close", second);

  expect(await cli("read", id)).toContain("claude (fake) working on");
  const table = await cli("ls");
  expect(table).toContain(id);
  expect(table).toMatch(/Workers\s+claude idle\s+w1/);

  await cli("send", id, "/busy");
  await eventually(() => agentOf(id), (agent) => expectAgent(agent, { activity: "working" }), "claude working");
  await cli("send", id, "/wait");
  await eventually(() => agentOf(id), (agent) => expectAgent(agent, { activity: "waiting", reason: "needs you" }), "claude waiting");
  await cli("send", id, "/error", "overloaded");
  const stopped = await eventually(() => agentOf(id), (agent) => agent?.activity === "stopped", "claude stopped");
  expect(stopped).toEqual({ name: "claude", activity: "stopped", reason: "at capacity", detail: "API Error: fake overloaded" });
  expect(await cli("ls")).toContain("claude stopped: at capacity");
  await cli("send", id, "carry on");
  await eventually(() => agentOf(id), (agent) => expectAgent(agent, { activity: "idle" }), "claude idle again");

  // Several lines go in as one paste, then Enter.
  await run(["send", id, "-"], "first line\nsecond line\n");
  await eventually(async () => typedLines(), (lines) => lines.includes("first line\nsecond line"), "the paste");

  await cli("banner", id, "w1: login bug");
  expect((await session(id))?.banner).toBe("w1: login bug");

  // Keys: Ctrl+C twice quits the agent, and its terminal shows no agent any more.
  await cli("send", id, "--key", "ctrl-c", "--key", "ctrl-c");
  await eventually(() => session(id), (found) => found !== undefined && found.agent === undefined, "claude gone");

  await cli("close", id);
  await eventually(() => session(id), (found) => found === undefined, "the terminal closed");
}, 90_000);

test("Codex's approval prompts, warnings and errors show", async () => {
  const id = (await cli("new", "--tab", "Workers", "--cwd", project, "--", "codex")).trim();
  await eventually(() => agentOf(id), (agent) => expectAgent(agent, { name: "codex", activity: "idle" }), "codex idle");
  await cli("send", id, "/approve");
  await eventually(() => agentOf(id), (agent) => expectAgent(agent, { activity: "waiting", reason: "needs approval" }), "codex asking");
  await cli("send", id, "go ahead");
  await eventually(() => agentOf(id), (agent) => expectAgent(agent, { activity: "idle", warning: undefined }), "codex idle again");
  await cli("send", id, "/warn");
  await eventually(() => agentOf(id), (agent) => expectAgent(agent, { activity: "idle", warning: "cyber flag" }), "the cyber warning");
  await cli("send", id, "/error", "usage_limit_exceeded");
  await eventually(
    () => agentOf(id),
    (agent) => expectAgent(agent, { activity: "stopped", reason: "usage limit", detail: "fake usage_limit_exceeded" }),
    "codex stopped",
  );
  await cli("close", id);
}, 60_000);

test("commands say plainly what is wrong", async () => {
  const missing = await run(["read", "ffffffff"]);
  expect(missing.code).toBe(1);
  expect(missing.err).toContain("no such session: ffffffff");
  const send = await run(["send", "ffffffff", "hello"]);
  expect(send.code).toBe(1);
  expect(send.err).toContain("no such terminal: ffffffff");
  const key = await run(["send", "ffffffff", "--key", "hyperspace"]);
  expect(key.err).toContain("unknown key: hyperspace");
}, 30_000);
