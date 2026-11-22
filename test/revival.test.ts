// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientMessage, Conversation, LostSession, ServerMessage, SessionView } from "../src/common/protocol.ts";
import { type DaemonHandle, startDaemon } from "../src/daemon/daemon.ts";
import { foregroundProcess } from "../src/server/foreground.ts";
import { type ServerHandle, startServer } from "../src/server/server.ts";
import { fixture, TEST_SHELL, tempPaths, until } from "./helpers.ts";

let cleanup: () => void;
let temp: ReturnType<typeof tempPaths>;
let bin: string;
let log: string;
let claudeDir: string;
let codexDir: string;
let project: string;
let env: Record<string, string | undefined>;
let daemon: DaemonHandle;
let server: ServerHandle;
let ws: WebSocket;
const messages: ServerMessage[] = [];
const sessions = new Map<string, SessionView>();
let lost: LostSession[] = [];
let conversations: Conversation[] | null = null;

beforeAll(async () => {
  temp = tempPaths();
  cleanup = temp.cleanup;
  // Fake `claude` and `codex` programs on the sessions' PATH, with their own home directories.
  // The real path: on macOS /tmp is a link to /private/tmp, which is what processes report as their directory.
  bin = realpathSync(mkdtempSync(join(tmpdir().length > 40 ? "/tmp" : tmpdir(), "sw-bin-")));
  for (const name of ["claude", "codex"]) {
    writeFileSync(join(bin, name), `#!/usr/bin/env bun\nimport ${JSON.stringify(fixture("fake-agent.ts"))};\n`);
    chmodSync(join(bin, name), 0o755);
  }
  log = join(bin, "log.jsonl");
  claudeDir = join(bin, "claude-home");
  codexDir = join(bin, "codex-home");
  project = join(bin, "my project");
  mkdirSync(project);
  env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_AGENT_LOG: log,
    CLAUDE_CONFIG_DIR: claudeDir,
    CODEX_HOME: codexDir,
    // Codex's rollout names another directory: only the file Codex holds open says it is this terminal's.
    FAKE_ROLLOUT_CWD: "/somewhere/else",
  };
  daemon = await startDaemon({ paths: temp.paths, shellArgv: TEST_SHELL, env, log: () => {} });
  server = await startServer({
    paths: temp.paths,
    host: "127.0.0.1",
    port: 0,
    log: () => {},
    revivalEveryMs: 100,
    agentDirs: { claude: claudeDir, codex: codexDir },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const login = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({ token: server.token }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  ws = new WebSocket(`${base.replace("http", "ws")}/ws`, { headers: { origin: base, cookie } } as never);
  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const message = JSON.parse(event.data) as ServerMessage;
    if (message.t === "sessions") {
      sessions.clear();
      for (const session of message.sessions) sessions.set(session.id, session);
    }
    if (message.t === "session") sessions.set(message.session.id, message.session);
    if (message.t === "removed") sessions.delete(message.session);
    if (message.t === "lost") lost = message.sessions;
    if (message.t === "conversations") conversations = message.conversations;
    messages.push(message);
  });
  await new Promise((resolve) => ws.addEventListener("open", resolve));
});

afterAll(async () => {
  ws.close();
  await server.stop();
  await daemon.stop();
  cleanup();
  rmSync(bin, { recursive: true, force: true });
});

function send(message: ClientMessage): void {
  ws.send(JSON.stringify(message));
}

async function createSession(options: { cmd?: string; cwd?: string } = {}): Promise<SessionView> {
  const known = new Set(sessions.keys());
  send({ t: "create", cols: 100, rows: 30, ...options });
  await until(() => [...sessions.keys()].some((id) => !known.has(id)), "a new session");
  return [...sessions.values()].find((session) => !known.has(session.id))!;
}

interface Launch {
  name: string;
  args: string[];
  id: string;
  cwd: string;
}
const launches = (): Launch[] =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Launch)
        .filter((entry) => "args" in entry)
    : [];
const meta = () =>
  JSON.parse(readFileSync(temp.paths.metaFile, "utf8")) as {
    sessions: Record<string, { revival?: { cwd: string; agent?: { name: string; conversation?: string } } }>;
  };

test("terminals lost with their daemon come back in place, resuming their agents' conversations", async () => {
  const claude = await createSession({ cmd: 'claude --dangerously-skip-permissions --model opus "fix the login bug"', cwd: project });
  const codex = await createSession({ cmd: "codex --yolo -m gpt-5" });
  const shell = await createSession({ cwd: project });
  send({ t: "banner", session: claude.id, banner: "login bug" });
  const frame = { x: 0.5, y: 0.25, w: 0.5, h: 0.5, z: 3 };
  send({ t: "session-frame", session: codex.id, frame });
  await until(() => launches().length === 2, "both agents", 15000);
  const claudeId = launches().find((launch) => launch.name === "claude")!.id;
  const codexId = launches().find((launch) => launch.name === "codex")!.id;

  // The server notes each agent's conversation from the agent's own files while it runs.
  await until(() => {
    const stored = meta().sessions;
    return (
      stored[claude.id]?.revival?.agent?.conversation === claudeId &&
      stored[codex.id]?.revival?.agent?.conversation === codexId &&
      stored[shell.id]?.revival?.cwd === project
    );
  }, "the agents' conversations to be noted");
  const colors = { claude: sessions.get(claude.id)!.color, codex: sessions.get(codex.id)!.color };

  // A new daemon (as after a reboot) has none of the terminals: they are lost, not forgotten.
  await daemon.stop();
  daemon = await startDaemon({ paths: temp.paths, shellArgv: TEST_SHELL, env, log: () => {} });
  await until(() => lost.length === 3, "three lost terminals", 15000);
  expect(sessions.size).toBe(0);
  const byId = new Map(lost.map((session) => [session.id, session]));
  expect(byId.get(claude.id)).toMatchObject({
    banner: "login bug",
    cwd: project,
    agent: {
      name: "claude",
      command: `claude --resume ${claudeId} --dangerously-skip-permissions --model opus`,
      conversation: "Fake work in my project",
    },
  });
  expect(byId.get(codex.id)).toMatchObject({ frame, agent: { command: `codex resume ${codexId} --yolo -m gpt-5` } });
  expect(byId.get(shell.id)?.agent).toBeUndefined();

  send({ t: "restore", ids: [claude.id, codex.id, shell.id] });
  await until(() => lost.length === 0 && sessions.size === 3, "the restored terminals", 15000);
  await until(() => launches().length === 4, "the agents to start again", 15000);
  const again = launches().slice(2);
  expect(again.find((launch) => launch.name === "claude")).toMatchObject({
    args: ["--resume", claudeId, "--dangerously-skip-permissions", "--model", "opus"],
    cwd: project,
  });
  expect(again.find((launch) => launch.name === "codex")?.args).toEqual(["resume", codexId, "--yolo", "-m", "gpt-5"]);

  const restored = [...sessions.values()];
  const claudeAgain = restored.find((session) => session.banner === "login bug")!;
  expect(claudeAgain.color).toBe(colors.claude);
  const codexAgain = restored.find((session) => session.frame?.x === frame.x)!;
  expect(codexAgain).toMatchObject({ frame, color: colors.codex, cols: 100, rows: 30 });
  await until(() => foregroundProcess(claudeAgain.pid)?.argv.join(" ").includes("claude") === true, "claude running again");
}, 60_000);

test("recent conversations no terminal is on can be resumed", async () => {
  // One written by hand, as Claude Code leaves it after an exit; the running ones are not offered.
  const id = "3f2a9c1e-0b7d-4e1a-9c2f-5d6e7f8a9b0c";
  const dir = join(claudeDir, "projects", "-elsewhere");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.jsonl`),
    `${JSON.stringify({ type: "user", cwd: "/elsewhere", sessionId: id, message: { content: "earlier work" } })}\n`,
  );
  await until(
    () => Object.values(meta().sessions).filter((stored) => stored.revival?.agent?.conversation).length === 2,
    "the restored agents' conversations to be noted",
  );
  conversations = null;
  send({ t: "conversations" });
  await until(() => conversations !== null, "the conversation list");
  expect(conversations!.map((found) => found.id)).toEqual([id]);
  expect(conversations![0]).toMatchObject({ agent: "claude", cwd: "/elsewhere", label: "earlier work", command: `claude --resume ${id}` });
  const flags = messages.findLast((message) => message.t === "conversations");
  expect(flags).toMatchObject({ flags: { claude: "--dangerously-skip-permissions --model opus", codex: "--yolo -m gpt-5" } });
}, 20_000);

test("an agent that quits is no longer restored; its terminal still is, in its directory", async () => {
  const session = await createSession({ cmd: "claude", cwd: project });
  await until(() => meta().sessions[session.id]?.revival?.agent?.conversation !== undefined, "the conversation to be noted");
  // Ctrl+C twice quits it; its shell stays.
  send({ t: "input", session: session.id, data: "\x03" });
  await Bun.sleep(50);
  send({ t: "input", session: session.id, data: "\x03" });
  // Forgotten once two notes in a row have seen it gone (one could be a reboot in progress).
  await until(() => {
    const revival = meta().sessions[session.id]?.revival;
    return revival !== undefined && revival.agent === undefined;
  }, "the agent to be forgotten");
  expect(meta().sessions[session.id]!.revival!.cwd).toBe(project);
  send({ t: "close", session: session.id });
}, 20_000);
