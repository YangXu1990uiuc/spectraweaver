// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

// The terminal commands as a coordinating agent uses them, against a real daemon and server,
// with fake Claude Code and Codex programs that act out working, waiting and stopping.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentActivity, AgentStatus, Board, SessionView, TabView } from "../src/common/protocol.ts";
import { STALL_SETTLE_MS, stoppedWorking } from "../src/control.ts";
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
    // Run from a SpectraWeaver terminal, the tests must not look for that terminal here.
    SPECTRAWEAVER_SESSION_ID: undefined,
  };
  daemon = await startDaemon({ paths: temp.paths, shellArgv: TEST_SHELL, env, log: () => {} });
  server = await startServer({
    paths: temp.paths,
    host: "127.0.0.1",
    port: 0,
    log: () => {},
    revivalEveryMs: 200,
    statusEveryMs: 100,
    statusQuietMs: 300,
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

async function run(
  args: string[],
  stdin?: string,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; out: string; err: string }> {
  const child = Bun.spawn(["bun", CLI, ...args], {
    env: { ...env, ...extraEnv },
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

test("a command given as several words keeps each word whole", async () => {
  const id = (await cli("new", "--cwd", project, "--", "echo", "two  spaces", "it's")).trim();
  expect((await session(id))?.cmd).toBe("echo 'two  spaces' 'it'\\''s'");
  await cli("close", id);
});

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
  expect(stopped).toEqual({
    name: "claude",
    activity: "stopped",
    reason: "at capacity",
    detail: "API Error: fake overloaded",
    since: expect.any(Number),
  });
  expect(await cli("ls")).toContain("claude stopped: at capacity");
  await cli("send", id, "carry on");
  await eventually(() => agentOf(id), (agent) => expectAgent(agent, { activity: "idle", model: "claude-fake-1" }), "claude idle again, its model known");
  expect(await cli("ls")).toMatch(/Workers\s+claude\/fake-1 idle/);
  // Its latest reply alone: both parts of the message, without the rest of the screen.
  expect(await cli("read", id, "--reply")).toBe("done\n\n(you said: carry on)\n");

  // A shell left running in the background: still working, so a wait does not return.
  await cli("send", id, "/background");
  await eventually(() => agentOf(id), (agent) => expectAgent(agent, { activity: "working", reason: "a shell in background" }), "a background shell");
  expect((await run(["wait", id, "--timeout", "1s"])).code).toBe(124);
  // A usage limit that has lifted: ls says so, and wait --until lifted returns.
  await cli("send", id, "/limit");
  await eventually(
    () => agentOf(id),
    (agent) => expectAgent(agent, { activity: "stopped", reason: "usage limit" }) && (agent?.resetsAt ?? Infinity) < Date.now(),
    "a limit that has lifted",
  );
  expect(await cli("ls")).toMatch(/claude\S* stopped: usage limit, lifted (\d{4}-\d\d-\d\d )?\d\d:\d\d/);
  expect(await cli("wait", id, "--until", "lifted", "--timeout", "5s")).toContain("usage limit");
  await cli("send", id, "continue");
  await eventually(() => agentOf(id), (agent) => expectAgent(agent, { activity: "idle" }), "claude going on");

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

test("wait returns once a terminal stops working, or gives up", async () => {
  const id = (await cli("new", "--tab", "Waits", "--cwd", project, "--", "claude")).trim();
  await eventually(() => agentOf(id), (agent) => expectAgent(agent, { activity: "idle" }), "claude idle");
  // Idle already: at once.
  expect(await cli("wait", id)).toMatch(new RegExp(`${id}\\s+Waits\\s+claude idle`));
  // Waiting for ever has to be asked for; idle already, it returns at once all the same.
  expect((await run(["wait", id, "--timeout", "none"])).code).toBe(0);
  expect((await run(["wait", id, "--timeout", "soon"])).err).toContain("--timeout takes a duration");
  const unknown = await run(["wait", "ffffffff"]);
  expect(unknown.code).toBe(1);
  expect(unknown.err).toContain("no such terminal: ffffffff");

  await cli("send", id, "/busy");
  await eventually(() => agentOf(id), (agent) => expectAgent(agent, { activity: "working" }), "claude working");
  const timedOut = await run(["wait", id, "--timeout", "1s"]);
  expect(timedOut.code).toBe(124);
  expect(timedOut.out).toContain("1s passed and nothing happened. Look in on them");
  expect(timedOut.out).toContain("claude working");

  // A wait running when the agent stops returns then; --until picks the states that count.
  const waiting = run(["wait", id, "--until", "waiting", "--timeout", "20s"]);
  await Bun.sleep(1500);
  await cli("send", id, "/wait");
  const answered = await waiting;
  expect(answered.code).toBe(0);
  expect(answered.out).toContain("claude waiting");

  // --changed: a state the terminal was already in does not count until it has left it.
  await cli("send", id, "carry on");
  await eventually(() => agentOf(id), (agent) => expectAgent(agent, { activity: "idle" }), "claude idle again");
  expect((await run(["wait", id, "--changed", "--timeout", "1500ms"])).code).toBe(1); // not a duration
  expect((await run(["wait", id, "--changed", "--timeout", "2s"])).code).toBe(124);
  const next = run(["wait", id, "--changed", "--timeout", "20s"]);
  await cli("send", id, "/busy");
  await eventually(() => agentOf(id), (agent) => expectAgent(agent, { activity: "working" }), "claude working again");
  await Bun.sleep(1500); // the wait asks once a second
  await cli("send", id, "the next task");
  expect((await next).out).toMatch(/claude\S* idle/);

  // A terminal that closes is gone, which counts as exited.
  const gone = run(["wait", id, "--until", "exited", "--timeout", "20s"]);
  await Bun.sleep(1500);
  await cli("close", id);
  expect((await gone).out).toContain(`${id}   closed`);
}, 90_000);

test("Codex's approval prompts, warnings and errors show", async () => {
  const id = (await cli("new", "--tab", "Workers", "--cwd", project, "--", "codex")).trim();
  await eventually(() => agentOf(id), (agent) => expectAgent(agent, { name: "codex", activity: "idle" }), "codex idle");
  await cli("send", id, "/approve");
  await eventually(() => agentOf(id), (agent) => expectAgent(agent, { activity: "waiting", reason: "needs approval" }), "codex asking");
  expect((await agentOf(id))?.detail).toBe("Would you like to run the following command? · $ rm -rf build");
  await cli("send", id, "go ahead");
  await eventually(() => agentOf(id), (agent) => expectAgent(agent, { activity: "idle", warning: undefined, model: "gpt-fake-1" }), "codex idle again");
  expect(await cli("read", id, "--reply")).toBe("done (you said: go ahead)\n");
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

test("a coordinating agent's board: pushed from its terminal, with its workers put away", async () => {
  const lead = (await cli("new", "--tab", "Project", "--banner", "lead", "--cwd", project)).trim();
  const worker = (await cli("new", "--tab", "Project", "--banner", "w1", "--cwd", project)).trim();
  // Only a board brings a window back, so a tab without one puts none away.
  const nowhereToGo = await run(["hide", worker]);
  expect(nowhereToGo.code).toBe(1);
  expect(nowhereToGo.err).toContain("in a tab without a board");
  expect((await session(worker))?.hidden).toBeUndefined();
  // As the lead runs them: from its own terminal, so the tab is its tab.
  const asLead = { SPECTRAWEAVER_SESSION_ID: lead };
  const board = {
    title: "Login refactor",
    tasks: [
      { id: "T1", title: "Map the flow", status: "done" },
      { id: "T2", title: "Refresh API", status: "wip", after: ["T1"], session: worker },
      { id: "T3", title: "Login page", status: "blocked", after: ["T2"], note: "waits for the API" },
      { id: "T4", title: "Migration", status: "wip", after: ["T1"], session: "ffffffff" },
    ],
  };
  const set = await run(["board", "set", "-"], JSON.stringify(board), asLead);
  expect(set.code).toBe(0);
  expect(set.out.trim()).toBe("board of “Project”: 4 tasks: 1 done, 2 wip, 1 blocked");
  expect(set.err).toContain('warning: task "T4": there is no terminal ffffffff');

  const listed = await listing();
  const tab = listed.tabs.find((candidate) => candidate.name === "Project")!;
  expect(tab.board).toMatchObject({ title: "Login refactor", lead, tasks: board.tasks });
  // The first board: the board on the left, its lead on the right, the workers put away.
  expect(tab.boardWindow).toEqual({ open: true, frame: { x: 0, y: 0, w: 0.6, h: 1, z: expect.any(Number) } });
  expect((await session(lead))?.frame).toMatchObject({ x: 0.6, y: 0, w: 0.4, h: 1 });
  expect((await session(lead))?.hidden).toBeUndefined();
  expect((await session(worker))?.hidden).toBe(true);
  // A shell waiting at its prompt says so, for the board to mark a task no one works on.
  await eventually(() => session(worker), (found) => found?.atPrompt === true, "the worker's shell at its prompt");

  // New terminals from the lead land in its tab, put away unless shown.
  const quiet = (await run(["new", "--banner", "w2"], undefined, asLead)).out.trim();
  const shown = (await run(["new", "--banner", "w3", "--show"], undefined, asLead)).out.trim();
  expect((await session(quiet))?.tab).toBe(tab.id);
  expect((await session(quiet))?.hidden).toBe(true);
  expect((await session(shown))?.hidden).toBeUndefined();
  await cli("show", quiet);
  expect((await session(quiet))?.hidden).toBeUndefined();
  await cli("hide", quiet);
  expect((await session(quiet))?.hidden).toBe(true);

  // One task at a time, from any terminal of the tab (a worker marking its own task, say).
  const asWorker = { SPECTRAWEAVER_SESSION_ID: worker };
  const beforeUpdates = new Date().toISOString();
  const updated = await run(["board", "update", "T3", "--status", "wip", "--note", "API merged, starting the page"], undefined, asWorker);
  expect(updated.out.trim()).toBe("T3 wip; board of “Project”: 4 tasks: 1 done, 3 wip");
  const taskOf = async (id: string) => (await listing()).tabs.find((candidate) => candidate.id === tab.id)?.board?.tasks.find((task) => task.id === id);
  expect(await taskOf("T3")).toEqual({
    id: "T3",
    title: "Login page",
    status: "wip",
    after: ["T2"],
    note: "API merged, starting the page",
    updatedAt: expect.any(Number),
    updatedBy: worker,
  });
  // The lead stays the lead, whoever changed a task.
  expect((await listing()).tabs.find((candidate) => candidate.id === tab.id)?.board?.lead).toBe(lead);
  await run(["board", "update", "T3", "--note", ""], undefined, asWorker);
  expect((await taskOf("T3"))?.note).toBeUndefined();
  // A task the board does not have is added, given its status.
  expect((await run(["board", "update", "T5", "--status", "todo", "--title", "Docs", "--after", "T3,T4"], undefined, asLead)).out).toContain("5 tasks");
  expect(await taskOf("T5")).toEqual({ id: "T5", title: "Docs", status: "todo", after: ["T3", "T4"], updatedAt: expect.any(Number), updatedBy: lead });
  const unknown = await run(["board", "update", "T9", "--note", "x"], undefined, asLead);
  expect(unknown.code).toBe(1);
  expect(unknown.err).toContain('there is no task "T9" on the board; give its status to add it');
  const circle = await run(["board", "update", "T1", "--after", "T5"], undefined, asLead);
  expect(circle.err).toContain("the task was not changed: these tasks wait for each other in a circle");
  expect((await run(["board", "update", "T5"], undefined, asLead)).err).toContain("say what to change");

  // Each task says when it changed and from which terminal; --since shows only those changed since.
  type Shown = { tasks: Array<{ id: string; updatedAt?: string; updatedBy?: string }> };
  const stamped = (JSON.parse(await cli("board", "show", "--tab", "Project")) as Shown).tasks.find((task) => task.id === "T3")!;
  expect(stamped.updatedBy).toBe(worker);
  expect(stamped.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  const since = JSON.parse(await cli("board", "show", "--tab", "Project", "--since", beforeUpdates)) as Shown;
  expect(since.tasks.map((task) => task.id)).toEqual(["T3", "T5"]);
  expect((await run(["board", "show", "--tab", "Project", "--since", "soon"])).err).toContain("--since takes");

  // wait --board wakes the lead when a worker changes a task, not when it changes one itself.
  const watching = run(["wait", "--board", "--timeout", "20s"], undefined, asLead);
  await Bun.sleep(1500);
  await run(["board", "update", "T5", "--note", "the lead's own"], undefined, asLead);
  await Bun.sleep(1500);
  await run(["board", "update", "T2", "--status", "done", "--note", "refresh API merged"], undefined, asWorker);
  const woken = await watching;
  expect(woken.code).toBe(0);
  expect(woken.out.trim()).toBe(`T2 wip → done · by ${worker} (w1) · note: refresh API merged`);
  // Nothing happening: it wakes anyway, listing the tab's terminals for a look.
  const nothing = await run(["wait", "--board", "--timeout", "1s"], undefined, asLead);
  expect(nothing.code).toBe(124);
  expect(nothing.out).toContain(lead);
  expect(nothing.out).toContain(worker);

  // The board names the terminals it gives tasks: ls (and their windows) show that, not banners.
  // A plain shell no longer working on its task in progress is marked.
  // T2 is done: the worker is named by it, ticked, and nothing is marked.
  expect((await run(["ls"], undefined, asLead)).out).toMatch(new RegExp(`${worker}\\s+Project\\s+shell\\s+✓ T2 Refresh API`));
  await run(["board", "update", "T2", "--status", "wip"], undefined, asLead);
  const named = (await run(["ls"], undefined, asLead)).out;
  expect(named).toMatch(new RegExp(`${worker}\\s+Project\\s+shell, T2 in progress ⚠\\s+T2 Refresh API`));
  expect(named).toMatch(new RegExp(`${lead}\\*?\\s+Project\\s+\\S+.*lead · Login refactor`));
  const listedTasks = (JSON.parse((await run(["ls", "--json"], undefined, asLead)).out) as { sessions: Array<SessionView & { tasks?: unknown }> }).sessions;
  expect(listedTasks.find((session) => session.id === worker)?.tasks).toEqual([{ id: "T2", status: "wip" }]);
  const noted = await run(["banner", worker, "w1 again"], undefined, asLead);
  expect(noted.err).toContain("the board names this terminal");

  // An agent on a task in progress that stops working wakes a wait on the board.
  const agentWorker = (await run(["new", "--cwd", project, "--", "claude"], undefined, asLead)).out.trim();
  await eventually(() => agentOf(agentWorker), (agent) => expectAgent(agent, { activity: "idle" }), "the agent worker idle");
  await run(["board", "update", "T6", "--status", "wip", "--title", "Agent work", "--session", agentWorker], undefined, asLead);
  const stalledWait = run(["wait", "--board", "--timeout", "30s"], undefined, asLead);
  await cli("send", agentWorker, "/busy");
  await eventually(() => agentOf(agentWorker), (agent) => expectAgent(agent, { activity: "working" }), "the agent worker working");
  await Bun.sleep(1500); // the wait asks once a second
  await cli("send", agentWorker, "all done, but the task is left in progress");
  const stalledOut = await stalledWait;
  expect(stalledOut.code).toBe(0);
  expect(stalledOut.out).toContain(`T6 in progress, but its terminal ${agentWorker} is no longer working: claude/fake-1 idle`);
  await run(["board", "update", "T6", "--status", "done"], undefined, asLead);
  await cli("close", agentWorker);

  // A shell has no reply to read.
  const noAgent = await run(["read", worker, "--reply"]);
  expect(noAgent.code).toBe(1);
  expect(noAgent.err).toContain(`no coding agent runs in terminal ${worker}`);

  // Mistakes are refused with what to write instead, and the board stays as it was.
  const wrong = await run(["board", "set", "-"], JSON.stringify([{ id: "T9", status: "review" }]), asLead);
  expect(wrong.code).toBe(1);
  expect(wrong.err).toContain('the board was not set: task "T9": "status" must be one of todo, wip, done, blocked');
  const shownBoard = JSON.parse(await cli("board", "show", "--tab", "project")) as { tasks: unknown[] };
  expect(shownBoard.tasks).toHaveLength(6);
  const nowhere = await run(["board", "show"]);
  expect(nowhere.code).toBe(1);
  expect(nowhere.err).toContain("say which tab");

  expect((await cli("board", "clear", "--tab", "Project")).trim()).toBe("“Project” has no board now");
  const cleared = (await listing()).tabs.find((candidate) => candidate.id === tab.id)!;
  expect(cleared.board).toBeUndefined();
  expect(cleared.boardWindow?.open).toBe(false);
  // Without the board, the windows it would have brought back come out.
  expect((await session(worker))?.hidden).toBeUndefined();
  expect((await session(quiet))?.hidden).toBeUndefined();
  for (const id of [lead, worker, quiet, shown]) await cli("close", id);
}, 60_000);

test("a wait on the board is told once a task's terminal stops working, not while it stays stopped", () => {
  const board: Board = { tasks: [{ id: "T1", title: "Train", status: "wip", session: "w1" }], updatedAt: 0 };
  const doing = (activity: AgentActivity) => new Map([["w1", { id: "w1", agent: { name: "claude", activity } } as SessionView]]);
  const busy = new Map<string, number | null>();
  const told = "T1 in progress, but its terminal w1 is no longer working: claude idle";
  // Stopped already when the wait began: a wait in a loop is not woken again and again.
  expect(stoppedWorking(board, doing("idle"), busy, 0)).toEqual([]);
  expect(stoppedWorking(board, doing("idle"), busy, 60_000)).toEqual([]);
  // Between two turns for a moment: not stopped.
  expect(stoppedWorking(board, doing("working"), busy, 61_000)).toEqual([]);
  expect(stoppedWorking(board, doing("idle"), busy, 62_000)).toEqual([]);
  expect(stoppedWorking(board, doing("working"), busy, 63_000)).toEqual([]);
  // Stopped, and staying so: told once.
  expect(stoppedWorking(board, doing("idle"), busy, 64_000)).toEqual([]);
  expect(stoppedWorking(board, doing("idle"), busy, 64_000 + STALL_SETTLE_MS)).toEqual([told]);
  expect(stoppedWorking(board, doing("idle"), busy, 70_000 + STALL_SETTLE_MS)).toEqual([]);
  // Closed: told at once.
  expect(stoppedWorking(board, doing("working"), busy, 80_000)).toEqual([]);
  expect(stoppedWorking(board, new Map(), busy, 81_000)).toEqual(["T1 in progress, but its terminal w1 is no longer working: it closed"]);
});

test("ls from a terminal lists its own tab, and says how many it leaves out; --all lists every tab", async () => {
  const here = (await cli("new", "--tab", "Here", "--cwd", project)).trim();
  const there = (await cli("new", "--tab", "There", "--cwd", project)).trim();
  const fromHere = { SPECTRAWEAVER_SESSION_ID: here };
  const scoped = (await run(["ls"], undefined, fromHere)).out;
  expect(scoped).toContain(here);
  expect(scoped).not.toContain(there);
  expect(scoped).toMatch(/\(this tab only; \d+ more terminals? (is|are) in other tabs: --all lists them\)/);
  const json = JSON.parse((await run(["ls", "--json"], undefined, fromHere)).out) as { sessions: SessionView[]; tabs: TabView[]; elsewhere: number };
  expect(json.sessions.map((session) => session.id)).toEqual([here]);
  expect(json.tabs.map((tab) => tab.name)).toEqual(["Here"]);
  expect(json.elsewhere).toBeGreaterThan(0);
  expect((await run(["ls", "--all"], undefined, fromHere)).out).toContain(there);
  expect((await run(["ls", "--tab", "there"], undefined, fromHere)).out).toContain(there);
  expect((await run(["ls", "--tab", "There", "--all"], undefined, fromHere)).err).toContain("--tab or --all, not both");
  // Outside SpectraWeaver's terminals: every tab, as before.
  expect(await cli("ls")).toContain(there);
  for (const id of [here, there]) await cli("close", id);
});

test("commands say plainly what is wrong", async () => {
  const missing = await run(["read", "ffffffff"]);
  expect(missing.code).toBe(1);
  expect(missing.err).toContain("no such terminal: ffffffff");
  const send = await run(["send", "ffffffff", "hello"]);
  expect(send.code).toBe(1);
  expect(send.err).toContain("no such terminal: ffffffff");
  const key = await run(["send", "ffffffff", "--key", "hyperspace"]);
  expect(key.err).toContain("unknown key: hyperspace");
  const dashes = await run(["send", "ffffffff", "git", "push", "--force"]);
  expect(dashes.err).toContain("unknown option --force; to pass text that starts with --, put -- before the text");
  // Asking for help runs nothing; an argument a command does not take is refused.
  const help = await run(["down", "-h"]);
  expect(help.code).toBe(0);
  expect(help.out).toContain("Usage:");
  expect((await run(["board", "set", "--help"])).out).toContain("spectraweaver board: the task board of a tab");
  const extra = await run(["token", "extra"]);
  expect(extra.code).toBe(1);
  expect(extra.err).toContain('spectraweaver token takes no argument "extra"');
  expect((await run(["board", "sett"])).err).toContain("unknown board command: sett");
}, 30_000);
