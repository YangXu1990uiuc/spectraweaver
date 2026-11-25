// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

// Commands that work with terminals: list, create, read, type into, label and close them. They
// are for scripts and coding agents as much as for people: a coordinating agent can open
// terminals for others, see what each is doing, read their screens and answer them.

import { resolve } from "node:path";
import { ownTab } from "./board-cli.ts";
import { duration, elapsed, fail, flag, parseFlags } from "./cli-args.ts";
import { shellQuote } from "./server/agents.ts";
import type { AgentReply } from "./server/control-api.ts";
import { daemonCall, daemonHello, serverCall } from "./client.ts";
import { type Paths, resolvePaths } from "./common/paths.ts";
import {
  type AgentStatus,
  type BoardTask,
  NEW_TERMINAL_SIZE,
  type ScreenText,
  type SessionInfo,
  type SessionView,
  type TabView,
} from "./common/protocol.ts";
import { sameTask } from "./server/board.ts";

interface Listing {
  sessions: SessionView[];
  tabs: TabView[];
}

/** The pause between typed text and the Enter after it, so the program takes the Enter as a key press. */
const ENTER_DELAY_MS = 200;
const KEY_DELAY_MS = 50;

const KEYS: Record<string, string> = {
  enter: "\r",
  esc: "\x1b",
  escape: "\x1b",
  tab: "\t",
  "shift-tab": "\x1b[Z",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  backspace: "\x7f",
  space: " ",
  "ctrl-c": "\x03",
  "ctrl-d": "\x04",
};

/**
 * `ls`: the terminals of one tab, or of all. Run in a SpectraWeaver terminal it lists that
 * terminal's tab unless told otherwise (--tab, --all): a coordinating agent sees its workers,
 * not the work of other tabs, and hears how many it does not see.
 */
export async function cmdList(args: string[]): Promise<void> {
  const flags = parseFlags(args, ["json", "tab", "all"]);
  if (flag(flags, "tab") !== undefined && flag(flags, "all") !== undefined) fail("--tab or --all, not both");
  const paths = resolvePaths();
  const listed = await serverCall<Listing>(paths, "GET", "/api/v1/sessions");
  if (!listed) {
    // Without the server there are no tabs, banners or agents: only what the daemon knows.
    const sessions = await daemonCall<SessionInfo[]>(paths, { op: "list" });
    if (flag(flags, "json")) {
      console.log(JSON.stringify({ sessions, tabs: [] }, null, 2));
      return;
    }
    for (const session of sessions) console.log(`${session.id}  ${stateOf(session)}  ${session.title || session.cmd || session.cwd}`);
    console.error(
      flag(flags, "tab")
        ? "(the server is not running: these are all the terminals, as tabs, banners and agents are the server's)"
        : "(the server is not running, so tabs, banners and agents are not shown)",
    );
    return;
  }
  const wanted = flag(flags, "tab")?.trim().toLowerCase();
  const tabs = new Map(listed.tabs.map((tab) => [tab.id, tab]));
  const own = process.env.SPECTRAWEAVER_SESSION_ID;
  const ownTab = own && flag(flags, "all") === undefined ? listed.sessions.find((session) => session.id === own)?.tab : undefined;
  const inScope = (tab: TabView) => (wanted ? [tab.id, tab.name.toLowerCase()].includes(wanted) : ownTab ? tab.id === ownTab : true);
  const shownTabs = listed.tabs.filter(inScope);
  const sessions = listed.sessions.filter((session) => shownTabs.some((tab) => tab.id === session.tab));
  // Only when the tab was not asked for: the terminals left out, so their being there is no surprise.
  const elsewhere = !wanted && ownTab ? listed.sessions.length - sessions.length : 0;
  if (flag(flags, "json")) {
    console.log(JSON.stringify({ sessions, tabs: shownTabs, ...(ownTab && !wanted ? { elsewhere } : {}) }, null, 2));
    return;
  }
  if (sessions.length === 0) console.log(wanted || ownTab ? "no terminals in that tab" : "no terminals");
  else printSessions(sessions, tabs);
  if (elsewhere > 0) console.log(`(this tab only; ${elsewhere} more terminal${elsewhere === 1 ? " is" : "s are"} in other tabs: --all lists them)`);
}

/** One line per terminal, in columns: id, tab, what its agent is doing, banner. */
function printSessions(sessions: readonly SessionView[], tabs: ReadonlyMap<string, TabView>): void {
  if (sessions.length === 0) return;
  const own = process.env.SPECTRAWEAVER_SESSION_ID;
  const rows = sessions.map((session) => [
    `${session.id}${session.id === own ? "*" : " "}`,
    tabs.get(session.tab)?.name ?? "",
    session.agent ? agentText(session.agent) : stateOf(session),
    session.banner || session.title || session.cwd,
  ]);
  const widths = [0, 1, 2].map((column) => Math.max(...rows.map((row) => row[column]!.length)));
  for (const row of rows) console.log(row.map((cell, column) => (column < 3 ? cell.padEnd(widths[column]!) : cell)).join("  "));
  if (own && sessions.some((session) => session.id === own)) console.log("(* is this terminal)");
}

/** What `wait --until` takes: the ways a terminal stops working, and a limit that has lifted. */
const WAIT_STATES = ["idle", "waiting", "stopped", "exited", "lifted"] as const;
type WaitState = (typeof WAIT_STATES)[number];
/** By default, any way of no longer working (a lifted limit is a stop, so it counts already). */
const DEFAULT_UNTIL: readonly WaitState[] = ["idle", "waiting", "stopped", "exited"];
const WAIT_POLL_MS = 1000;
/**
 * A wait wakes up after this long even if nothing happened, for its agent to look in on
 * everything: a job that hangs keeps its terminal working, and nothing else would wake it.
 */
const WAIT_DEFAULT_TIMEOUT = "30m";
/** The exit status of a wait that timed out, as timeout(1) has it. */
export const WAIT_TIMED_OUT = 124;

/**
 * The states a terminal is in, for `wait`: its agent's activity (one not known yet, or idle with
 * a shell in the background, counts as working, as the server reports it); a stop whose limit
 * has lifted is "lifted" too; without an agent, whether its shell is at a prompt.
 */
function waitStates(session: SessionView | undefined, now: number): Set<WaitState | "working"> {
  if (!session || session.exited) return new Set(["exited"]);
  const agent = session.agent;
  if (!agent) return new Set([session.atPrompt ? "idle" : "working"]);
  if (agent.activity === "unknown") return new Set(["working"]);
  if (agent.activity === "stopped" && agent.resetsAt !== undefined && agent.resetsAt <= now) return new Set(["stopped", "lifted"]);
  return new Set([agent.activity]);
}

/**
 * `wait ID...` returns once one of the terminals stops working (`--all`: once all have), and
 * prints them; `--until` narrows the states that count, `--changed` counts only a state entered
 * after the wait began (after a send, say, before the agent has picked it up), and `--timeout`
 * gives up with status 124. `--board` returns as well once a task of the board changes (any but
 * this terminal's own changes), and says what changed and from which terminal. It asks the
 * server once a second.
 */
export async function cmdWait(args: string[]): Promise<void> {
  const flags = parseFlags(args, ["until", "timeout", "all", "changed", "board", "tab"]);
  const ids = [...new Set(flags.rest)];
  const watchBoard = flag(flags, "board") !== undefined;
  if (ids.length === 0 && !watchBoard) {
    fail("usage: spectraweaver wait [ID...] [--board [--tab NAME]] [--until idle,waiting,stopped,exited,lifted] [--all] [--changed] [--timeout 30m]");
  }
  if (flag(flags, "tab") !== undefined && !watchBoard) fail("--tab says which board to watch: give --board too");
  const until = new Set<WaitState>();
  const asked = flag(flags, "until");
  for (const word of asked === undefined ? DEFAULT_UNTIL : asked.split(",")) {
    const state = word.trim().toLowerCase();
    if (!WAIT_STATES.includes(state as WaitState)) fail(`--until takes ${WAIT_STATES.join(", ")}, not ${JSON.stringify(word)}`);
    until.add(state as WaitState);
  }
  // "none" waits for ever, which has to be asked for.
  const timeout = flag(flags, "timeout") ?? WAIT_DEFAULT_TIMEOUT;
  const deadline = timeout.trim().toLowerCase() === "none" ? Infinity : Date.now() + duration(timeout, "--timeout");
  const all = flag(flags, "all") !== undefined;
  const changed = flag(flags, "changed") !== undefined;
  const paths = resolvePaths();
  let boardQuery: string | undefined;
  if (watchBoard) {
    const tab = flag(flags, "tab")?.trim() || (await ownTab(paths));
    if (!tab) fail("--board: say which tab's board with --tab NAME (in a SpectraWeaver terminal, its own tab is the default)");
    boardQuery = `/api/v1/board?tab=${encodeURIComponent(tab)}`;
  }
  /** With --changed: the terminals seen outside the states waited for since the wait began. */
  const moved = new Set<string>();
  /** The board's tasks when the wait began, and its tab. */
  let before: Map<string, BoardTask> | undefined;
  let boardTab: string | undefined;
  for (let first = true; ; first = false) {
    const listed = await serverCall<Listing>(paths, "GET", "/api/v1/sessions");
    if (!listed) fail("wait asks the server what the agents are doing; start it with `spectraweaver up`");
    const sessions = new Map(listed.sessions.map((session) => [session.id, session]));
    if (first) {
      const unknown = ids.filter((id) => !sessions.has(id));
      if (unknown.length > 0) fail(`no such terminal: ${unknown.join(", ")} (\`spectraweaver ls\` lists them)`);
    }
    const now = Date.now();
    const reached = ids.filter((id) => {
      const states = waitStates(sessions.get(id), now);
      const counts = [...states].some((state) => until.has(state as WaitState));
      if (!counts) moved.add(id);
      return counts && (!changed || moved.has(id));
    });
    let boardChanges: string[] = [];
    if (boardQuery) {
      const found = (await serverCall<{ tab: TabView }>(paths, "GET", boardQuery))!.tab;
      const board = found.board;
      boardTab = found.id;
      const tasks = new Map((board?.tasks ?? []).map((task) => [task.id, task]));
      if (before) boardChanges = taskChanges(before, tasks, board?.lead, sessions);
      else before = tasks;
    }
    const tabs = new Map(listed.tabs.map((tab) => [tab.id, tab]));
    // A terminal closed meanwhile is gone from the list: it is named by its id.
    const show = (list: string[]) => {
      printSessions(list.flatMap((id) => sessions.get(id) ?? []), tabs);
      for (const id of list) if (!sessions.has(id)) console.log(`${id}   closed`);
    };
    const terminalsDone = ids.length > 0 && (all ? reached.length === ids.length : reached.length > 0);
    if (boardChanges.length > 0 || terminalsDone) {
      for (const line of boardChanges) console.log(line);
      if (terminalsDone) show(reached);
      return;
    }
    if (Date.now() >= deadline) {
      // Time to look in: each terminal waited on (with --board alone, those of the board's tab) and
      // how long it has been doing what it does, for the agent to judge what is taking too long.
      const watched = ids.length > 0 ? ids : listed.sessions.filter((session) => session.tab === boardTab).map((session) => session.id);
      console.log(
        `${timeout} passed and nothing happened. Look in on them: one doing the same thing far longer than it should (a job that hangs keeps its terminal working) may be stuck. As they are now:`,
      );
      show(watched);
      process.exit(WAIT_TIMED_OUT);
    }
    await Bun.sleep(Math.min(WAIT_POLL_MS, Math.max(0, deadline - Date.now())));
  }
}

/**
 * What changed on a board, one line a task: "T13 wip → done · by 1444054a (T13: analysis) ·
 * note: …", "T24 added (todo): …", "T7 removed". Changes this terminal made are left out: a
 * coordinator waiting on its board is not woken by its own pushes.
 */
function taskChanges(
  before: ReadonlyMap<string, BoardTask>,
  after: ReadonlyMap<string, BoardTask>,
  lead: string | undefined,
  sessions: ReadonlyMap<string, SessionView>,
): string[] {
  const self = process.env.SPECTRAWEAVER_SESSION_ID;
  const by = (task: BoardTask) => {
    if (!task.updatedBy) return "";
    const banner = sessions.get(task.updatedBy)?.banner;
    return ` · by ${task.updatedBy}${banner ? ` (${banner})` : ""}`;
  };
  const lines: string[] = [];
  for (const task of after.values()) {
    if (self && task.updatedBy === self) continue;
    const old = before.get(task.id);
    if (!old) {
      lines.push(`${task.id} added (${task.status}): ${task.title}${by(task)}`);
      continue;
    }
    if (sameTask(old, task)) continue;
    const status = old.status === task.status ? task.status : `${old.status} → ${task.status}`;
    const note = task.note !== old.note ? (task.note ? ` · note: ${task.note}` : " · note removed") : "";
    const others = (["title", "after", "session", "link"] as const).filter((field) => JSON.stringify(old[field]) !== JSON.stringify(task[field]));
    lines.push(`${task.id} ${status}${by(task)}${note}${others.length > 0 ? ` · changed: ${others.join(", ")}` : ""}`);
  }
  // A task goes only with a whole board pushed, from the lead.
  if (!(self && lead === self)) for (const id of before.keys()) if (!after.has(id)) lines.push(`${id} removed`);
  return lines;
}

/** "claude/opus-5-5 working 6h50m: a shell in background", "… stopped 2h: usage limit, resets 22:30 (cyber flag)". */
function agentText(agent: AgentStatus, now = Date.now()): string {
  const model = agent.model ? `/${agent.model.replace(/^claude-/, "")}` : "";
  // How long it has been doing it, from when the server first saw it so: a minute or more.
  const age = agent.since !== undefined && now - agent.since >= 60_000 ? ` ${elapsed(now - agent.since)}` : "";
  const reason = agent.reason ? `: ${agent.reason}` : "";
  const resets =
    agent.resetsAt === undefined ? "" : `, ${agent.resetsAt > now ? "resets" : "lifted"} ${localTime(agent.resetsAt, now)}`;
  const warning = agent.warning ? ` (${agent.warning})` : "";
  return `${agent.name}${model} ${agent.activity}${age}${reason}${resets}${warning}`;
}

/** "22:30" today, "2026-11-24 22:30" another day, in this machine's time. */
function localTime(at: number, now: number): string {
  const when = new Date(at);
  const two = (value: number) => String(value).padStart(2, "0");
  const clock = `${two(when.getHours())}:${two(when.getMinutes())}`;
  return when.toDateString() === new Date(now).toDateString()
    ? clock
    : `${when.getFullYear()}-${two(when.getMonth() + 1)}-${two(when.getDate())} ${clock}`;
}

function stateOf(session: SessionInfo): string {
  if (!session.exited) return "shell";
  return `exited ${session.exited.signal ?? session.exited.code ?? ""}`.trim();
}

export async function cmdNew(args: string[]): Promise<void> {
  const flags = parseFlags(args, ["size", "cwd", "tab", "banner", "show"], { freeText: true });
  const match = /^(\d+)x(\d+)$/i.exec(flag(flags, "size") ?? `${NEW_TERMINAL_SIZE.cols}x${NEW_TERMINAL_SIZE.rows}`);
  if (!match) fail("--size must look like 120x36");
  const paths = resolvePaths();
  const request = {
    // From a terminal, a new one lands in the same tab: a coordinating agent's workers sit by it.
    tab: flag(flags, "tab") ?? (await ownTab(paths)),
    banner: flag(flags, "banner"),
    show: flag(flags, "show") !== undefined,
    // Relative to where the command runs, as a path given to any command is.
    cwd: resolve(flag(flags, "cwd") ?? process.cwd()),
    // One argument is a command line as written ("claude --model opus"); several are words, each
    // kept whole as the shell that runs them would see it (claude "fix the bug").
    cmd: flags.rest.length === 0 ? undefined : flags.rest.length === 1 ? flags.rest[0] : flags.rest.map(shellQuote).join(" "),
    cols: Number(match[1]),
    rows: Number(match[2]),
  };
  const created = await serverCall<{ session: SessionView }>(paths, "POST", "/api/v1/sessions", request);
  if (created) {
    console.log(created.session.id);
    return;
  }
  if (flag(flags, "tab") || request.banner) fail("--tab and --banner need the server; start it with `spectraweaver up`");
  const session = await daemonCall<SessionInfo>(paths, {
    op: "create",
    cols: request.cols,
    rows: request.rows,
    cwd: request.cwd,
    cmd: request.cmd,
  });
  console.log(session.id);
}

export async function cmdRead(args: string[]): Promise<void> {
  const flags = parseFlags(args, ["lines", "reply"]);
  const [id, extra] = flags.rest;
  if (!id || extra !== undefined) fail("usage: spectraweaver read ID [--lines N | --reply]");
  const lines = flag(flags, "lines");
  if (lines !== undefined && !/^[1-9]\d*$/.test(lines)) fail("--lines must be a positive number");
  const paths = resolvePaths();
  if (flag(flags, "reply") !== undefined) {
    if (lines !== undefined) fail("--reply prints the agent's latest reply, not lines of the screen: give one or the other");
    const reply = await serverCall<AgentReply>(paths, "GET", `/api/v1/sessions/${encodeURIComponent(id)}/reply`);
    if (!reply) fail("read --reply finds the agent's conversation through the server; start it with `spectraweaver up`");
    console.log(reply.text);
    return;
  }
  await needText(paths);
  await existing(paths, id);
  const text = await daemonCall<ScreenText>(paths, { op: "text", session: id, lines: lines ? Number(lines) : undefined });
  const shown = [...text.lines];
  while (shown.length > 0 && shown.at(-1) === "") shown.pop();
  console.log(shown.join("\n"));
}

export async function cmdSend(args: string[]): Promise<void> {
  const flags = parseFlags(args, ["key", "no-enter"], { freeText: true });
  const [id, ...words] = flags.rest;
  const keys = flags.values.get("key") ?? [];
  if (!id || (words.length === 0 && keys.length === 0)) {
    fail("usage: spectraweaver send ID TEXT... [--no-enter]   or   spectraweaver send ID --key NAME...");
  }
  const presses = keys.map((name) => {
    const key = KEYS[name.toLowerCase()] ?? (name.length === 1 ? name : undefined);
    if (key === undefined) fail(`unknown key: ${name} (known: ${Object.keys(KEYS).join(", ")}, or a single character)`);
    return key;
  });
  let text = words.length === 1 && words[0] === "-" ? (await Bun.stdin.text()).replace(/\r?\n$/, "") : words.join(" ");
  const paths = resolvePaths();
  await existing(paths, id);
  // Input is not answered; the list request after it is, once the input is in the terminal.
  const input = (data: string) => daemonCall<SessionInfo[]>(paths, { op: "list" }, [{ op: "input", session: id, data }]);
  if (text) {
    // Newlines as a terminal sends them. Several lines go in as one paste where the program asked
    // for bracketed paste (agents' prompts do); otherwise each line would be sent as it is typed.
    text = text.replace(/\r?\n/g, "\r");
    if (text.includes("\r") && (await screen(paths, id))?.bracketedPaste) text = `\x1b[200~${text}\x1b[201~`;
    await input(text);
    if (!flag(flags, "no-enter") && presses.length === 0) presses.push("\r");
  }
  for (const [index, key] of presses.entries()) {
    // Apart, so a program reading keys one at a time sees each.
    if (text || index > 0) await Bun.sleep(text && index === 0 ? ENTER_DELAY_MS : KEY_DELAY_MS);
    await input(key);
  }
}

export async function cmdBanner(args: string[]): Promise<void> {
  const [id, ...words] = parseFlags(args, []).rest;
  if (!id) fail("usage: spectraweaver banner ID TEXT");
  const updated = await serverCall<{ session: SessionView }>(resolvePaths(), "POST", `/api/v1/sessions/${encodeURIComponent(id)}`, {
    banner: words.join(" "),
  });
  if (!updated) fail("banners are kept by the server; start it with `spectraweaver up`");
}

/** `show ID` brings a terminal's window out and in front; `hide ID` puts it away (in a tab with a board). */
export async function cmdShowHide(args: string[], hidden: boolean): Promise<void> {
  const [id, extra] = parseFlags(args, []).rest;
  const name = hidden ? "hide" : "show";
  if (!id || extra !== undefined) fail(`usage: spectraweaver ${name} ID`);
  const updated = await serverCall<{ session: SessionView }>(resolvePaths(), "POST", `/api/v1/sessions/${encodeURIComponent(id)}`, {
    hidden,
  });
  if (!updated) fail("windows are kept by the server; start it with `spectraweaver up`");
}

export async function cmdClose(args: string[]): Promise<void> {
  const [id, extra] = parseFlags(args, []).rest;
  if (!id || extra !== undefined) fail("usage: spectraweaver close ID");
  const paths = resolvePaths();
  await existing(paths, id);
  await daemonCall<null>(paths, { op: "close", session: id });
}

/** Fails unless the daemon has a terminal with this id. */
async function existing(paths: Paths, id: string): Promise<SessionInfo> {
  const session = (await daemonCall<SessionInfo[]>(paths, { op: "list" })).find((candidate) => candidate.id === id);
  if (!session) fail(`no such terminal: ${id} (\`spectraweaver ls\` lists them)`);
  return session;
}

/** Fails, with what to do, if the daemon cannot show a terminal's text. */
async function needText(paths: Paths): Promise<void> {
  const hello = await daemonHello(paths);
  if (hello && !hello.features?.includes("text")) {
    fail(
      "this daemon predates reading terminals; restart it with `spectraweaver down --all` and `spectraweaver up`,\n" +
        "then click Restore in the browser to bring the terminals back",
    );
  }
}

/** The terminal's screen as text; null if the daemon cannot show it. */
async function screen(paths: Paths, id: string): Promise<ScreenText | null> {
  const hello = await daemonHello(paths);
  if (!hello?.features?.includes("text")) return null;
  return daemonCall<ScreenText>(paths, { op: "text", session: id, lines: 1 });
}
