// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

// `spectraweaver board`: the task board a coordinating agent keeps for a tab (DESIGN.md §8.7).
// Its help is written for that agent, who reads it to learn the format.

import { readFileSync } from "node:fs";
import { fail, flag, parseFlags } from "./cli-args.ts";
import { serverCall } from "./client.ts";
import { type Paths, resolvePaths } from "./common/paths.ts";
import { type Board, type SessionView, TASK_STATUSES, type TabView, type TaskStatus } from "./common/protocol.ts";
import type { BoardResult } from "./server/control-api.ts";

export const BOARD_HELP = `spectraweaver board: the task board of a tab

A coordinating agent keeps it; SpectraWeaver only shows it. The board is a window in the tab:
the tasks and what each waits for as a graph, coloured by status, and on each task the live
state of the terminal working on it (working, idle, waiting for approval, stopped and why). The
person double-clicks a task to open its terminal. How tasks are split, where they are tracked
and how often the board is pushed are up to the agent and its prompt.

  spectraweaver board set [FILE | -] [--tab NAME]
                        replace the board with FILE, or with standard input
  spectraweaver board show [--tab NAME]
                        print the board as JSON
  spectraweaver board clear [--tab NAME]
                        remove the board

Without --tab: the tab of the terminal the command runs in. A tab name no tab has makes a tab.

The board is JSON:

  {
    "title": "Login refactor, week 2",
    "tasks": [
      {"id": "T1", "title": "Map the login flow", "status": "done"},
      {"id": "T2", "title": "Refresh API", "status": "wip", "after": ["T1"],
       "session": "3f2a9c1d", "note": "fixing the expiry check"},
      {"id": "T3", "title": "Login page", "status": "blocked", "after": ["T2"],
       "note": "waits for the API", "link": "https://github.com/acme/login/pull/12"}
    ]
  }

  id       short and unique, such as "T1"
  title    a few words
  status   ${TASK_STATUSES.join(", ")}; say more in note ("waiting for review")
  after    ids of the tasks it waits for
  session  the terminal working on it (the id \`spectraweaver new\` prints); its state shows live,
           and a task in progress whose terminal is gone or idle at its shell is marked
  note     one line on what is going on
  link     an http(s) link: a pull request, the task's folder

Push the whole board each time; tasks left out are gone. The first board of a tab puts the
board on the left and the pushing terminal on the right.

Workers' terminals (run from a terminal in the tab, they land in it):
  spectraweaver new --banner "T2: refresh API" --cwd DIR -- claude
                        prints the new terminal's id; in a tab with a board it starts put
                        away in the taskbar (--show to show it)
  spectraweaver send ID "the task, and where to report back"
  spectraweaver ls --json            what every terminal's agent is doing
  spectraweaver read ID              a terminal's screen
  spectraweaver show ID              bring a terminal in front of the person
`;

export async function cmdBoard(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    console.log(BOARD_HELP);
    return;
  }
  if (!["set", "show", "clear"].includes(command)) fail(`unknown board command: ${command}\n\n${BOARD_HELP}`);
  const flags = parseFlags(rest, ["tab"]);
  const paths = resolvePaths();
  const tab = await boardTab(paths, flag(flags, "tab"));
  const query = `/api/v1/board?tab=${encodeURIComponent(tab)}`;
  switch (command) {
    case "set": {
      const [file, extra] = flags.rest;
      if (extra !== undefined) fail("usage: spectraweaver board set [FILE | -] [--tab NAME]");
      const board = parse(await boardText(file), file);
      const lead = process.env.SPECTRAWEAVER_SESSION_ID || undefined;
      const result = needServer(await serverCall<BoardResult>(paths, "PUT", query, { board, lead }));
      for (const warning of result.warnings) console.error(`warning: ${warning}`);
      console.log(`board of “${result.tab.name}”: ${summary(result.tab.board!)}`);
      return;
    }
    case "show": {
      const found = needServer(await serverCall<{ tab: TabView }>(paths, "GET", query));
      if (!found.tab.board) fail(`“${found.tab.name}” has no board (\`spectraweaver board set\` makes one)`);
      const { title, tasks, updatedAt } = found.tab.board;
      console.log(JSON.stringify({ title, tasks, updatedAt: new Date(updatedAt).toISOString() }, null, 2));
      return;
    }
    case "clear": {
      const cleared = needServer(await serverCall<{ tab: TabView }>(paths, "DELETE", query));
      console.log(`“${cleared.tab.name}” has no board now`);
      return;
    }
    default:
      fail(`unknown board command: ${command}\n\n${BOARD_HELP}`);
  }
}

/** The tab named, or the one the command runs in. */
async function boardTab(paths: Paths, named: string | undefined): Promise<string> {
  if (named?.trim()) return named.trim();
  const own = await ownTab(paths);
  if (!own) fail("say which tab: --tab NAME (in a SpectraWeaver terminal, its own tab is the default)");
  return own;
}

/** The tab of the terminal this command runs in, if it runs in one and the server knows it. */
export async function ownTab(paths: Paths): Promise<string | undefined> {
  const own = process.env.SPECTRAWEAVER_SESSION_ID;
  if (!own) return undefined;
  const listed = await serverCall<{ sessions: SessionView[] }>(paths, "GET", "/api/v1/sessions");
  return listed?.sessions.find((session) => session.id === own)?.tab;
}

async function boardText(file: string | undefined): Promise<string> {
  if (file && file !== "-") {
    try {
      return readFileSync(file, "utf8");
    } catch (error) {
      fail(`cannot read ${file}: ${(error as Error).message}`);
    }
  }
  if (process.stdin.isTTY) fail("give the board as a FILE, or on standard input (`spectraweaver board --help` shows the format)");
  return Bun.stdin.text();
}

function parse(text: string, file: string | undefined): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    fail(`${file && file !== "-" ? file : "the board"} is not valid JSON: ${(error as Error).message}`);
  }
}

function needServer<T>(result: T | null): T {
  if (result === null) fail("boards are kept by the server; start it with `spectraweaver up`");
  return result;
}

/** "11 tasks: 2 done, 5 wip, 1 blocked, 3 todo". */
function summary(board: Board): string {
  const order: TaskStatus[] = ["done", "wip", "blocked", "todo"];
  const counts = order.map((status) => [status, board.tasks.filter((task) => task.status === status).length] as const);
  const parts = counts.filter(([, count]) => count > 0).map(([status, count]) => `${count} ${status}`);
  const total = `${board.tasks.length} task${board.tasks.length === 1 ? "" : "s"}`;
  return parts.length > 0 ? `${total}: ${parts.join(", ")}` : total;
}
