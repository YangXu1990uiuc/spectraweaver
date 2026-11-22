// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

// The command line's usage text and option parsing.

import { VERSION } from "./common/version.ts";

export const FIRST_PORT = 7777;
const BOOLEAN_FLAGS = new Set(["all", "clear", "rotate", "reset", "allow-remote", "json", "no-enter", "show"]);

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
  spectraweaver ls [--json] [--tab NAME]
                        list terminals: tab, banner, and what each one's coding agent is doing
                        (working, idle, waiting for an answer, or stopped and why)
  spectraweaver new [--tab NAME] [--banner TEXT] [--size 120x36] [--cwd DIR] [--show] [-- COMMAND...]
                        create a terminal and print its id; COMMAND is typed into its shell.
                        It lands in the tab of the terminal the command runs in, or the first
                        tab; a tab name that no tab has yet makes a new tab. In a tab with a
                        board it starts put away in the taskbar, unless --show
  spectraweaver read ID [--lines N]
                        print a terminal's screen as text; --lines N prints its last N lines,
                        scrollback included
  spectraweaver send ID TEXT... [--no-enter]
                        type TEXT into a terminal and press Enter; TEXT "-" reads standard input,
                        and text of several lines goes in as one paste
  spectraweaver send ID --key NAME [--key NAME]...
                        press keys: enter, esc, tab, shift-tab, up, down, left, right, backspace,
                        ctrl-c, ctrl-d, or a single character
  spectraweaver banner ID TEXT
                        set a terminal's banner
  spectraweaver resize ID COLSxROWS
                        change a terminal's size; the program is told and redraws
  spectraweaver show ID   bring a terminal's window out of the taskbar, in front
  spectraweaver hide ID   put a terminal's window away in the taskbar; it keeps running
  spectraweaver close ID  close a terminal, ending its program

Task boards (for an agent coordinating others; \`spectraweaver board --help\` explains them):
  spectraweaver board set [FILE | -] [--tab NAME]
                        show a tab's tasks and what each waits for as a graph, with the live
                        state of the terminal working on each
  spectraweaver board show | clear [--tab NAME]

In the foreground (for debugging, or under a service manager):
  spectraweaver daemon    run the daemon in the foreground
  spectraweaver server [--port N] [--host ADDR --allow-remote] [--allow-host NAME]...
                        run the server in the foreground
`;

export interface Flags {
  values: Map<string, string[]>;
  rest: string[];
}

export function parseFlags(args: string[], known: string[]): Flags {
  const values = new Map<string, string[]>();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      rest.push(...args.slice(i + 1));
      break;
    }
    const [name, inline] = arg.startsWith("--") ? arg.slice(2).split("=", 2) : [undefined, undefined];
    if (name === undefined) {
      rest.push(arg);
      continue;
    }
    if (!known.includes(name)) fail(`unknown option --${name}\n\n${USAGE}`);
    const value = BOOLEAN_FLAGS.has(name) ? "true" : (inline ?? args[++i]);
    if (value === undefined) fail(`--${name} needs a value`);
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  return { values, rest };
}

export function flag(flags: Flags, name: string): string | undefined {
  return flags.values.get(name)?.at(-1);
}

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
