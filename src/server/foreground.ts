// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { readFileSync, readlinkSync } from "node:fs";

/** The program in the foreground of a terminal: the job the shell runs, or the shell itself. */
export interface ForegroundProcess {
  pid: number;
  argv: string[];
  /** The shell is in the foreground: it waits at a prompt. */
  isShell: boolean;
}

/**
 * Finds the foreground process group of the terminal whose shell is `shellPid`, from /proc on
 * Linux and from ps elsewhere (macOS). Returns null if it cannot tell, for example because the
 * shell has exited.
 */
export function foregroundProcess(shellPid: number): ForegroundProcess | null {
  try {
    return process.platform === "linux" ? fromProc(shellPid) : fromPs(shellPid);
  } catch {
    return null;
  }
}

/** A process's current directory: /proc on Linux, lsof elsewhere (macOS). Null if it cannot tell. */
export function processCwd(pid: number): string | null {
  try {
    if (process.platform === "linux") return readlinkSync(`/proc/${pid}/cwd`);
    const out = Bun.spawnSync(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"]).stdout.toString();
    return out.split("\n").find((line) => line.startsWith("n"))?.slice(1) || null;
  } catch {
    return null;
  }
}

function fromProc(shellPid: number): ForegroundProcess | null {
  const stat = readFileSync(`/proc/${shellPid}/stat`, "utf8");
  // The command name is in parentheses and may contain spaces; fields follow the last ")":
  // state, ppid, pgrp, session, tty_nr, tpgid, ...
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const pgrp = Number(fields[2]);
  const tpgid = Number(fields[5]);
  if (!(tpgid > 0)) return null;
  const pid = tpgid === pgrp ? shellPid : tpgid;
  const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  return argv.length > 0 ? { pid, argv, isShell: pid === shellPid } : null;
}

function fromPs(shellPid: number): ForegroundProcess | null {
  const ps = (...args: string[]) => Bun.spawnSync(["ps", ...args]).stdout.toString().trim();
  const [pgid, tpgid] = ps("-o", "pgid=,tpgid=", "-p", String(shellPid)).split(/\s+/).map(Number);
  if (!(tpgid! > 0)) return null;
  const pid = tpgid === pgid ? shellPid : tpgid!;
  // ps joins the arguments with spaces, which is close enough for recognising agents.
  const command = ps("-ww", "-o", "command=", "-p", String(pid));
  return command ? { pid, argv: command.split(/\s+/), isShell: pid === shellPid } : null;
}
