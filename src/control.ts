// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

// Commands that work with terminals: list, create, read, type into, label and close them. They
// are for scripts and coding agents as much as for people: a coordinating agent can open
// terminals for others, see what each is doing, read their screens and answer them.

import { resolve } from "node:path";
import { ownTab } from "./board-cli.ts";
import { fail, flag, parseFlags } from "./cli-args.ts";
import { daemonCall, daemonHello, serverCall } from "./client.ts";
import { type Paths, resolvePaths } from "./common/paths.ts";
import type { AgentStatus, ScreenText, SessionInfo, SessionView, TabView } from "./common/protocol.ts";

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
    console.error("(the server is not running, so tabs, banners and agents are not shown)");
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
  const flags = parseFlags(args, ["size", "cwd", "tab", "banner", "show"]);
  const match = /^(\d+)x(\d+)$/i.exec(flag(flags, "size") ?? "120x36");
  if (!match) fail("--size must look like 120x36");
  const paths = resolvePaths();
  const request = {
    // From a terminal, a new one lands in the same tab: a coordinating agent's workers sit by it.
    tab: flag(flags, "tab") ?? (await ownTab(paths)),
    banner: flag(flags, "banner"),
    show: flag(flags, "show") !== undefined,
    // Relative to where the command runs, as a path given to any command is.
    cwd: resolve(flag(flags, "cwd") ?? process.cwd()),
    cmd: flags.rest.length ? flags.rest.join(" ") : undefined,
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
  const text = await daemonCall<ScreenText>(paths, { op: "text", session: id, lines: lines ? Number(lines) : undefined });
  const shown = [...text.lines];
  while (shown.length > 0 && shown.at(-1) === "") shown.pop();
  console.log(shown.join("\n"));
}

export async function cmdSend(args: string[]): Promise<void> {
  const flags = parseFlags(args, ["key", "no-enter"]);
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

/** `show ID` brings a terminal's window out of the taskbar and in front; `hide ID` puts it away. */
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
