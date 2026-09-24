// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { VERSION } from "./version.ts";

// The daemon is often started from inside another terminal: VS Code, tmux, or a Claude Code
// session. Their identity and session variables must not leak into SpectraWeaver sessions:
// CLAUDECODE, for example, makes `claude` think it is nested inside another Claude session.
// User configuration comes back because sessions start login shells.
const DROP_PREFIXES = [
  "CLAUDE",
  "VSCODE_",
  "TERM_PROGRAM",
  "TMUX",
  "ZELLIJ",
  "KITTY_",
  "WEZTERM_",
  "ITERM_",
  "GHOSTTY_",
  "ALACRITTY_",
  "KONSOLE_",
  "WT_",
  "SPECTRAWEAVER_",
];
const DROP_EXACT = new Set([
  "STY",
  "WINDOW",
  "TERM",
  "COLORTERM",
  "VTE_VERSION",
  "LC_TERMINAL",
  "LC_TERMINAL_VERSION",
  "PWD",
  "OLDPWD",
  "SHLVL",
  "_",
  "LINES",
  "COLUMNS",
]);

export function sessionEnv(
  base: Record<string, string | undefined>,
  sessionId: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || DROP_EXACT.has(key)) continue;
    if (DROP_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    env[key] = value;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.TERM_PROGRAM = "spectraweaver";
  env.TERM_PROGRAM_VERSION = VERSION;
  env.SPECTRAWEAVER_SESSION_ID = sessionId;
  if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = "C.UTF-8";
  return env;
}
