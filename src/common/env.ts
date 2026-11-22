// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { VERSION } from "./version.ts";

// The daemon is often started from inside another terminal: VS Code, tmux, or a Claude Code
// session. Their identity and session variables must not leak into SpectraWeaver sessions:
// CLAUDECODE, for example, makes `claude` think it is nested inside another Claude session, and
// Claude Code sets a dozen more of its own (CLAUDE_CODE_SESSION_ID, CLAUDE_PID, ...), new ones
// with new versions; hence prefixes. What the user exports in their shell's startup files
// comes back in the session's interactive shell.
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
// Configuration, not identity: where Claude Code keeps its settings and conversations, and which
// SpectraWeaver instance this is (so `spectraweaver ls` in a session finds the daemon it runs in).
const KEEP = new Set(["CLAUDE_CONFIG_DIR", "SPECTRAWEAVER_HOME", "SPECTRAWEAVER_CONFIG_DIR", "SPECTRAWEAVER_STATE_DIR"]);
// Which provider Claude Code uses (CLAUDE_CODE_USE_BEDROCK, _VERTEX, ...): configuration too.
const KEEP_PREFIXES = ["CLAUDE_CODE_USE_"];
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
    const kept = KEEP.has(key) || KEEP_PREFIXES.some((prefix) => key.startsWith(prefix));
    if (!kept && DROP_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
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
