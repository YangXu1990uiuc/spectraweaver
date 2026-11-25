// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

// `spectraweaver board`: the task board a coordinating agent keeps for a tab (DESIGN.md §8.7).
// Its help is written for that agent, who reads it to learn the format.

import { readFileSync } from "node:fs";
import { duration, fail, flag, parseFlags } from "./cli-args.ts";
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
  spectraweaver board update ID [--status S] [--note TEXT] [--title TEXT] [--after IDS]
                             [--session ID] [--link URL] [--tab NAME]
                        change one task, or add it (with --status) if the board has no
                        task ID; "" removes a field, IDS is comma-separated
  spectraweaver board show [--since 30m | --since TIME] [--tab NAME]
                        print the board as JSON; each task says when it last changed and
                        from which terminal (updatedAt, updatedBy); --since: only those changed
                        since then
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
           and a task in progress whose terminal is gone or idle at its shell is marked. The
           terminal is then called by its task on its window and in ls ("T2 Refresh API"), so
           there is no banner to keep up; banners are for terminals no task names
  note     one line on what is going on
  link     an http(s) link: a pull request, the task's folder

Push the whole board with set when the plan changes: tasks left out are gone. For one task's
status or note, board update is enough, and a worker can mark its own task with it (from the
worker's terminal, it finds the tab itself); a set afterwards still replaces everything. The
first board of a tab puts the board on the left and the pushing terminal on the right.

Workers' terminals (run from a terminal in the tab, they land in it):
  spectraweaver new --cwd DIR -- claude "read tasks/T2/BRIEF.md ..."
                        prints the new terminal's id. The words after the agent's name are its
                        first prompt: it starts on the task as soon as it is up, with no need
                        to wait and send it (Codex the same: -- codex "..."). In a tab with a
                        board it starts put away, and the person opens it from its task
                        (--show to show it)
  spectraweaver ls [--json] [--all]  what the agents in this tab are doing (--all: every tab's):
                                     its model, for one waiting what its dialog asks
                                     ("detail"), for one stopped by a usage limit when it lifts
                                     ("resetsAt"; "lifted" once it has); "T26 in progress ⚠"
                                     on one no longer working while its task is in progress;
                                     --json gives each terminal's shell "pid" too
  spectraweaver read ID --reply      the agent's latest reply, without the rest of the screen
  spectraweaver read ID [--lines N]  a terminal's screen as text (N: its last N lines)
  spectraweaver wait [ID...] [--board] [--until STATES] [--timeout 30m]
                        returns once one of the terminals stops working (idle, waiting,
                        stopped, exited), or with --board once a task of this tab's board
                        changes (not by you) or a task's terminal stops working while the
                        task is in progress (when it stops: one stopped already when the wait
                        begins does not end it), and says what happened; after 30 minutes
                        (--timeout) anyway, with status 124: time to look in
  spectraweaver send ID TEXT         type into a terminal (see below)
  spectraweaver show ID              bring a terminal in front of the person

Pass work and results through files, not send: a folder per task with its brief and a
REPORT.md the worker writes, say. Text sent to a terminal is typed into its input box, in the
middle of whatever a person is typing there, and goes off with the person's half-written
message. So send a worker its task once, and after that only to get an agent going again that
stopped (at capacity, rate limited, an error) and will not look at its files until told to go
on. Workers should not send their reports into your terminal: you read their files. A worker
stopped by a usage limit may not go on by itself once the limit lifts: when ls says "lifted"
(or wait --until lifted returns), send it "continue".

Have workers mark their own tasks (board update ID --status done --note "..."); then
wait --board wakes you when one does, and says which, and board show --since 30m shows what
changed while you were away.

Long jobs must close the loop: an agent that has gone idle wakes only when told to. Have
workers start long jobs with their own background run (Claude Code's run_in_background): the
agent counts as working meanwhile ("a shell in background") and is woken when the job ends. A
job that has to outlive the agent (setsid, nohup) is invisible to it: then the worker also
starts a watcher with its background run (while kill -0 PID; do sleep 60; done), which ends
with the job and wakes it, and puts the PID and the log's path in the task's note. A worker idle while
its task is in progress, with nothing to wake it, is marked in ls ("T26 in progress ⚠"), and
wait --board wakes you when one stops working: find out why and set it going again.

Which terminal started a process: every process started in a terminal, setsid and nohup ones
too, has SPECTRAWEAVER_SESSION_ID=<its id> in its environment (/proc/PID/environ); and those
still attached to it descend from its shell, whose PID ls --json gives ("pid").

Look in on the workers now and then (ls, their files, read --reply) to catch one going off
track, or one that needs news from another. wait blocks until something happens, for when
there is nothing else to do; run it in the background if your tools time out. It wakes you
after 30 minutes even if nothing happened, listing how long each worker has been doing what
it does ("working 6h50m: a shell in background"): a job that hangs keeps a worker working and
would never wake you, so check anything running far longer than it should (its screen, its
log), then wait again. Wait longer between looks with --timeout 2h, never with none.
`;

export async function cmdBoard(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    console.log(BOARD_HELP);
    return;
  }
  if (!["set", "update", "show", "clear"].includes(command)) fail(`unknown board command: ${command}\n\n${BOARD_HELP}`);
  const flags = parseFlags(rest, command === "update" ? ["tab", ...TASK_OPTIONS, "after"] : command === "show" ? ["tab", "since"] : ["tab"]);
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
    case "update": {
      const [id, extra] = flags.rest;
      if (!id || extra !== undefined) fail("usage: spectraweaver board update ID [--status S] [--note TEXT] [--title TEXT] [--after IDS] [--session ID] [--link URL]");
      const patch: Record<string, unknown> = {};
      for (const option of TASK_OPTIONS) {
        const value = flag(flags, option);
        if (value !== undefined) patch[option] = value;
      }
      const after = flag(flags, "after");
      if (after !== undefined) patch.after = after.split(",").map((word) => word.trim()).filter(Boolean);
      if (Object.keys(patch).length === 0) fail("say what to change: --status, --note, --title, --after, --session or --link");
      const path = `/api/v1/board/task?tab=${encodeURIComponent(tab)}&id=${encodeURIComponent(id)}`;
      const by = process.env.SPECTRAWEAVER_SESSION_ID || undefined;
      const result = needServer(await serverCall<BoardResult>(paths, "PATCH", path, { patch, by }));
      for (const warning of result.warnings) console.error(`warning: ${warning}`);
      const task = result.tab.board!.tasks.find((candidate) => candidate.id === id);
      console.log(`${id} ${task?.status ?? ""}; board of “${result.tab.name}”: ${summary(result.tab.board!)}`);
      return;
    }
    case "show": {
      const found = needServer(await serverCall<{ tab: TabView }>(paths, "GET", query));
      if (!found.tab.board) fail(`“${found.tab.name}” has no board (\`spectraweaver board set\` makes one)`);
      const { title, tasks, updatedAt } = found.tab.board;
      // --since 30m, or a time: only the tasks changed since.
      const since = flag(flags, "since");
      const from = since === undefined ? undefined : sinceTime(since);
      const shown = from === undefined ? tasks : tasks.filter((task) => (task.updatedAt ?? 0) >= from);
      const readable = shown.map((task) => (task.updatedAt === undefined ? task : { ...task, updatedAt: new Date(task.updatedAt).toISOString() }));
      console.log(JSON.stringify({ title, tasks: readable, updatedAt: new Date(updatedAt).toISOString() }, null, 2));
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

/** `--since`: a while back ("30m") or a time ("2026-11-23T04:00", as Date reads it). */
function sinceTime(text: string): number {
  if (/^\d+(?:\.\d+)?[smhd]?$/.test(text.trim())) return Date.now() - duration(text, "--since");
  const at = Date.parse(text);
  if (!Number.isFinite(at)) fail(`--since takes a while back such as 30m or 2h, or a time such as 2026-11-23T04:00, not ${JSON.stringify(text)}`);
  return at;
}

/** The options of `board update` that set a task's field of the same name, as given. */
const TASK_OPTIONS = ["status", "note", "title", "session", "link"] as const;

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
