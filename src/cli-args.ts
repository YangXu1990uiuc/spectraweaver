// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

// The command line's usage text and option parsing.

import { VERSION } from "./common/version.ts";

export const FIRST_PORT = 7777;
const BOOLEAN_FLAGS = new Set(["all", "clear", "rotate", "reset", "allow-remote", "json", "no-enter", "show", "changed", "reply", "board"]);

export const USAGE = `spectraweaver ${VERSION}: persistent terminals in the browser

Usage:
  spectraweaver up [--port N] [--host ADDR --allow-remote] [--allow-host NAME]...
                        start the daemon and the server in the background
                        (the first run picks a free port from ${FIRST_PORT} and remembers it;
                        listening beyond localhost needs --allow-remote: see SECURITY.md)
  spectraweaver down [--all]
                        stop the server; --all also stops the daemon, ending every session
  spectraweaver status    show what is running
  spectraweaver autostart [on | off]
                        start SpectraWeaver when this host boots (a crontab @reboot line);
                        without on or off, say whether it does
  spectraweaver passwd [--clear]
                        set (or remove) the password for signing in from the browser
  spectraweaver token [--rotate]
                        print the login token and link; --rotate replaces it
  spectraweaver config    show where config and state live
  spectraweaver config state-dir PATH | --reset
                        keep state (socket, logs, tabs) under PATH, e.g. on a local disk
                        when the home directory is small or on NFS

Terminals (for scripts and coding agents too; ID is a terminal's id, from \`ls\` or \`new\`):
  spectraweaver ls [--json] [--tab NAME | --all]
                        list terminals (from a SpectraWeaver terminal: those of its own tab,
                        unless --tab or --all): tab, banner, and what each one's coding agent
                        is doing (working, idle, waiting for an answer, or stopped and why) and
                        its model; --json adds what a waiting agent's dialog asks, and when a
                        usage limit lifts
  spectraweaver new [--tab NAME] [--banner TEXT] [--size 160x48] [--cwd DIR] [--show] [-- COMMAND...]
                        create a terminal (160x48 unless --size) and print its id; COMMAND is
                        typed into its shell. It lands in the tab of the terminal the command
                        runs in, or the first tab; a tab name that no tab has yet makes a new
                        tab. In a tab with a board it starts put away (its task brings it
                        out), unless --show
  spectraweaver read ID [--lines N | --reply]
                        print a terminal's screen as text; --lines N prints its last N lines,
                        scrollback included; --reply prints only its agent's latest reply
  spectraweaver send ID [--no-enter] [--] TEXT...
                        type TEXT into a terminal and press Enter; TEXT "-" reads standard input,
                        and text of several lines goes in as one paste (-- before text that
                        starts with --). It lands in the terminal's input box, in the middle of
                        anything a person is typing there: pass results through files instead
  spectraweaver send ID --key NAME [--key NAME]...
                        press keys: enter, esc, tab, shift-tab, up, down, left, right, backspace,
                        ctrl-c, ctrl-d, or a single character
  spectraweaver wait [ID...] [--board [--tab NAME]] [--until STATES] [--all] [--changed]
                     [--timeout 30m]
                        wait until one of the terminals stops working (--all: all of them) and
                        print it; STATES, comma-separated: idle, waiting, stopped, exited (all
                        four by default), or lifted (a usage limit that has). --changed counts
                        only a state entered after the wait began, as after a send. --board:
                        return too once a task of the board changes, not by this terminal, or
                        a task's terminal stops working while the task is in progress (when
                        it stops, not while it stays stopped), and say what happened. After --timeout (30m by default; none waits for
                        ever) it returns anyway, with status 124 and how long each has been
                        doing what it does: time to look in
  spectraweaver banner ID TEXT
                        set a terminal's banner (a terminal a board's task names shows its task
                        instead, until no task names it)
  spectraweaver resize ID COLSxROWS
                        change a terminal's size; the program is told and redraws
  spectraweaver show ID   bring a terminal's window out, in front
  spectraweaver hide ID   put a terminal's window away (in a tab with a board); it keeps running
  spectraweaver close ID  close a terminal, ending its program

Task boards (for an agent coordinating others; \`spectraweaver board --help\` explains them):
  spectraweaver board set [FILE | -] [--tab NAME]
                        show a tab's tasks and what each waits for as a graph, with the live
                        state of the terminal working on each
  spectraweaver board update ID [--status S] [--note TEXT] [--tab NAME] ...
                        change one task, or add it
  spectraweaver board show [--since 30m] | clear [--tab NAME]

In the foreground (for debugging, or under a service manager):
  spectraweaver daemon    run the daemon in the foreground
  spectraweaver server [--port N] [--host ADDR --allow-remote] [--allow-host NAME]...
                        run the server in the foreground
`;

export interface Flags {
  values: Map<string, string[]>;
  rest: string[];
}

/**
 * Splits options from arguments. With `freeText`, the arguments are text to type or a command
 * to run, and an unknown option says how to pass text that looks like one.
 */
export function parseFlags(args: string[], known: string[], options: { freeText?: boolean } = {}): Flags {
  const values = new Map<string, string[]>();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      rest.push(arg);
      continue;
    }
    // At the first "=": the value may hold more ("--banner=a=b").
    const equals = arg.indexOf("=");
    const name = equals < 0 ? arg.slice(2) : arg.slice(2, equals);
    const inline = equals < 0 ? undefined : arg.slice(equals + 1);
    if (!known.includes(name)) {
      if (options.freeText) fail(`unknown option --${name}; to pass text that starts with --, put -- before the text`);
      fail(`unknown option --${name}\n\n${USAGE}`);
    }
    const value = BOOLEAN_FLAGS.has(name) ? "true" : (inline ?? args[++i]);
    if (value === undefined) fail(`--${name} needs a value`);
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  return { values, rest };
}

/** Fails if a command that takes no arguments (only options) was given some. */
export function noArguments(flags: Flags, command: string): void {
  if (flags.rest.length > 0) fail(`spectraweaver ${command} takes no argument "${flags.rest[0]}" (\`spectraweaver help\` lists the options)`);
}

/** Whether -h or --help comes before any "--": the person asks how to use the command. */
export function asksForHelp(args: string[]): boolean {
  const end = args.indexOf("--");
  return (end < 0 ? args : args.slice(0, end)).some((arg) => arg === "-h" || arg === "--help");
}

/** "90s", "30m", "2h", "1d", or seconds, in ms; `option` names it in the error. */
export function duration(text: string, option: string): number {
  const match = /^(\d+(?:\.\d+)?)(s|m|h|d)?$/.exec(text.trim());
  if (!match) fail(`${option} takes a duration such as 90s, 30m or 2h, not ${JSON.stringify(text)}`);
  return Number(match[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[(match[2] ?? "s") as "s" | "m" | "h" | "d"];
}

/** A while, briefly: "45s", "12m", "6h50m", "2d3h". */
export function elapsed(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 > 0 ? `${hours}h${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 > 0 ? `${days}d${hours % 24}h` : `${days}d`;
}

export function flag(flags: Flags, name: string): string | undefined {
  return flags.values.get(name)?.at(-1);
}

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
