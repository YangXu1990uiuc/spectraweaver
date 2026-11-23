// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

// Commands that work with terminals: list, create, read, type into, label and close them. They
// are for scripts and coding agents as much as for people: a coordinating agent can open
// terminals for others, see what each is doing, read their screens and answer them.

import { resolve } from "node:path";
import { ownTab } from "./board-cli.ts";
import { fail, flag, parseFlags } from "./cli-args.ts";
import { shellQuote } from "./server/agents.ts";
import { daemonCall, daemonHello, serverCall } from "./client.ts";
import { type Paths, resolvePaths } from "./common/paths.ts";
import { type AgentStatus, NEW_TERMINAL_SIZE, type ScreenText, type SessionInfo, type SessionView, type TabView } from "./common/protocol.ts";

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

export async function cmdList(args: string[]): Promise<void> {
  const flags = parseFlags(args, ["json", "tab"]);
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
  const sessions = wanted
    ? listed.sessions.filter((session) => [session.tab, tabs.get(session.tab)?.name.toLowerCase()].includes(wanted))
    : listed.sessions;
  if (flag(flags, "json")) {
    console.log(JSON.stringify({ sessions, tabs: listed.tabs }, null, 2));
    return;
  }
  if (sessions.length === 0) {
    console.log(wanted ? "no terminals in that tab" : "no terminals");
    return;
  }
  printSessions(sessions, tabs);
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

/** What `wait` can wait for: the states a terminal leaves working for. */
const WAIT_STATES = ["idle", "waiting", "stopped", "exited"] as const;
type WaitState = (typeof WAIT_STATES)[number] | "working";
const WAIT_POLL_MS = 1000;
/** The exit status of a wait that timed out, as timeout(1) has it. */
export const WAIT_TIMED_OUT = 124;

/**
 * A terminal's state for `wait`: its agent's activity (one not known yet counts as working);
 * without an agent, whether its shell is at a prompt.
 */
function waitState(session: SessionView | undefined): WaitState {
  if (!session || session.exited) return "exited";
  if (session.agent) return session.agent.activity === "unknown" ? "working" : session.agent.activity;
  return session.atPrompt ? "idle" : "working";
}

/** "90s", "30m", "2h", or seconds. */
function duration(text: string): number {
  const match = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(text.trim());
  if (!match) fail(`--timeout takes a duration such as 90s, 30m or 2h, not ${JSON.stringify(text)}`);
  return Number(match[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[(match[2] ?? "s") as "s" | "m" | "h"];
}

/**
 * `wait ID...` returns once one of the terminals stops working (`--all`: once all have), and
 * prints them; `--until` narrows the states that count, `--changed` counts only a state entered
 * after the wait began (after a send, say, before the agent has picked it up), and `--timeout`
 * gives up with status 124. It asks the server once a second.
 */
export async function cmdWait(args: string[]): Promise<void> {
  const flags = parseFlags(args, ["until", "timeout", "all", "changed"]);
  const ids = [...new Set(flags.rest)];
  if (ids.length === 0) fail("usage: spectraweaver wait ID... [--until idle,waiting,stopped,exited] [--all] [--changed] [--timeout 30m]");
  const until = new Set<WaitState>();
  for (const word of (flag(flags, "until") ?? WAIT_STATES.join(",")).split(",")) {
    const state = word.trim().toLowerCase();
    if (!WAIT_STATES.includes(state as (typeof WAIT_STATES)[number])) fail(`--until takes ${WAIT_STATES.join(", ")}, not ${JSON.stringify(word)}`);
    until.add(state as WaitState);
  }
  const timeout = flag(flags, "timeout");
  const deadline = timeout === undefined ? Infinity : Date.now() + duration(timeout);
  const all = flag(flags, "all") !== undefined;
  const changed = flag(flags, "changed") !== undefined;
  const paths = resolvePaths();
  /** With --changed: the terminals seen outside the states waited for since the wait began. */
  const moved = new Set<string>();
  for (let first = true; ; first = false) {
    const listed = await serverCall<Listing>(paths, "GET", "/api/v1/sessions");
    if (!listed) fail("wait asks the server what the agents are doing; start it with `spectraweaver up`");
    const sessions = new Map(listed.sessions.map((session) => [session.id, session]));
    if (first) {
      const unknown = ids.filter((id) => !sessions.has(id));
      if (unknown.length > 0) fail(`no such terminal: ${unknown.join(", ")} (\`spectraweaver ls\` lists them)`);
    }
    const reached = ids.filter((id) => {
      const state = waitState(sessions.get(id));
      if (!until.has(state)) moved.add(id);
      return until.has(state) && (!changed || moved.has(id));
    });
    const tabs = new Map(listed.tabs.map((tab) => [tab.id, tab]));
    // A terminal closed meanwhile is gone from the list: it is named by its id.
    const show = (list: string[]) => {
      printSessions(list.flatMap((id) => sessions.get(id) ?? []), tabs);
      for (const id of list) if (!sessions.has(id)) console.log(`${id}   closed`);
    };
    if (all ? reached.length === ids.length : reached.length > 0) {
      show(reached);
      return;
    }
    if (Date.now() >= deadline) {
      console.error(`timed out after ${timeout}; as they are now:`);
      show(ids);
      process.exit(WAIT_TIMED_OUT);
    }
    await Bun.sleep(Math.min(WAIT_POLL_MS, Math.max(0, deadline - Date.now())));
  }
}

function agentText(agent: AgentStatus): string {
  const reason = agent.reason ? `: ${agent.reason}` : "";
  const warning = agent.warning ? ` (${agent.warning})` : "";
  return `${agent.name} ${agent.activity}${reason}${warning}`;
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
  const flags = parseFlags(args, ["lines"]);
  const [id, extra] = flags.rest;
  if (!id || extra !== undefined) fail("usage: spectraweaver read ID [--lines N]");
  const lines = flag(flags, "lines");
  if (lines !== undefined && !/^[1-9]\d*$/.test(lines)) fail("--lines must be a positive number");
  const paths = resolvePaths();
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
