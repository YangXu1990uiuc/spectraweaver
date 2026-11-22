// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

// Starting SpectraWeaver when the machine boots, with a line in the user's crontab. Cron's
// @reboot needs neither root nor linger, and a crontab belongs to one host, which matters when
// several hosts share an NFS home directory (a systemd user unit there would start everywhere).

import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { shellQuote as quote } from "./server/agents.ts";

/** Ends SpectraWeaver's line, so it can be found again; the shell cron runs it with ignores it. */
export const AUTOSTART_MARKER = "# spectraweaver autostart";

// The home directory may be on NFS and not mounted yet when cron starts at boot, and the network
// may not be up: `up` is tried every 10 s for 5 minutes.
const TRIES = 30;
const WAIT_S = 10;

export interface AutostartPlan {
  /** The command that starts SpectraWeaver: Bun, the CLI script, "up". */
  argv: string[];
  /** The user's login shell: `up` runs in it, so terminals get the PATH a login gives. */
  shell: string;
  /** Variables that locate SpectraWeaver's config and state (SPECTRAWEAVER_*), if set. */
  env: Record<string, string>;
  log: string;
}

/** The crontab line that runs `spectraweaver up` at boot. */
export function autostartLine(plan: AutostartPlan): string {
  const assignments = Object.entries(plan.env).map(([name, value]) => `${name}=${value}`);
  const inner = ["exec", ...(assignments.length > 0 ? ["env", ...assignments] : []), ...plan.argv].map(quote).join(" ");
  const start = `${quote(loginShell(plan.shell))} -lc ${quote(inner)} >>${quote(plan.log)} 2>&1`;
  const command = `n=0; until ${start}; do n=$((n+1)); [ $n -ge ${TRIES} ] && exit 1; sleep ${WAIT_S}; done`;
  // Cron turns an unescaped % into a newline.
  return `@reboot ${command.replaceAll("%", "\\%")} ${AUTOSTART_MARKER}`;
}

/** SpectraWeaver's line in a crontab, if it has one. */
export function findAutostart(crontab: string): string | undefined {
  return crontab.split("\n").find((line) => line.trimEnd().endsWith(AUTOSTART_MARKER));
}

/** The crontab with SpectraWeaver's line replaced by `line` (or removed), other lines untouched. */
export function withAutostart(crontab: string, line: string | null): string {
  const lines = crontab.split("\n").filter((entry) => !entry.trimEnd().endsWith(AUTOSTART_MARKER));
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  if (line) lines.push(line);
  // Cron ignores a last line without a newline.
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/** The user's crontab; empty if they have none. Throws if cron refuses them or is missing. */
export function readCrontab(): string {
  const result = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  if (result.error) throw new Error(`cannot run crontab (${result.error.message}); is cron installed?`);
  if (result.status === 0) return result.stdout;
  if (/no crontab/i.test(result.stderr)) return "";
  throw new Error(`crontab -l failed: ${result.stderr.trim() || `exit code ${result.status}`}`);
}

export function writeCrontab(text: string): void {
  const result = spawnSync("crontab", ["-"], { input: text, encoding: "utf8" });
  if (result.error) throw new Error(`cannot run crontab (${result.error.message})`);
  if (result.status !== 0) throw new Error(`crontab - failed: ${result.stderr.trim() || `exit code ${result.status}`}`);
}

/** csh and tcsh cannot combine -l with -c; anything unusual runs under sh, which reads ~/.profile. */
function loginShell(shell: string): string {
  return ["bash", "zsh", "ksh", "mksh", "dash", "sh", "fish"].includes(basename(shell)) ? shell : "/bin/sh";
}


