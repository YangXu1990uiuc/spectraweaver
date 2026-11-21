// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

// What it takes to bring a terminal back after its daemon stopped (a reboot, or
// `spectraweaver down --all`): its directory and size, and the coding agent running in it with
// the conversation it is on. The server notes this for every terminal every few seconds, while
// it can still ask the running processes.

import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import type { SessionInfo } from "../common/protocol.ts";
import { type Agent, carriedFlags, detectAgent, isConversationId, programIndex } from "./agents.ts";
import { type AgentDirs, agentDirs, CODEX_ROLLOUT_PATH, type Conversations } from "./conversations.ts";
import type { ForegroundProcess } from "./foreground.ts";

export interface Revival {
  cwd: string;
  cols: number;
  rows: number;
  agent?: {
    name: string;
    /** The conversation it is on; unknown, it resumes the directory's latest. */
    conversation?: string;
    flags: string[];
    /** The agent's process, so a conversation found once is kept while it runs. */
    pid: number;
  };
}

export interface RevivalDeps {
  foreground(shellPid: number): ForegroundProcess | null;
  processCwd(pid: number): string | null;
  conversations: Conversations;
  /** Where the agents keep their files, unless a process's environment says otherwise. */
  dirs: AgentDirs;
}

/**
 * What would bring this terminal back. `claimed` holds the conversations other terminals are
 * on, which this one cannot be on too.
 */
export function observe(
  session: SessionInfo,
  previous: Revival | undefined,
  claimed: Set<string>,
  deps: RevivalDeps,
): Revival {
  const shellCwd = deps.processCwd(session.pid) ?? session.cwd;
  const revival: Revival = { cwd: shellCwd, cols: session.cols, rows: session.rows };
  const running = deps.foreground(session.pid);
  const agent = running && !running.isShell ? detectAgent(running.argv) : null;
  if (!running || !agent) return revival;

  const args = running.argv.slice(programIndex(running.argv) + 1);
  const cwd = deps.processCwd(running.pid) ?? shellCwd;
  const kept = previous?.agent?.pid === running.pid ? previous.agent.conversation : undefined;
  const conversation =
    exactConversation(agent, running.pid, deps.dirs) ??
    kept ??
    fromArgs(agent, args, claimed) ??
    latestIn(agent, cwd, running.pid, claimed, deps.conversations);
  revival.cwd = cwd;
  revival.agent = { name: agent.name, flags: carriedFlags(agent, args), pid: running.pid };
  if (conversation) revival.agent.conversation = conversation;
  return revival;
}

/**
 * The agent's conversation from the agent itself: Claude Code lists its running sessions in
 * <config>/sessions/<pid>.json, and Codex keeps its rollout file open.
 */
function exactConversation(agent: Agent, pid: number, dirs: AgentDirs): string | null {
  const own = agentDirs({ ...pick(dirs), ...agentEnv(pid) });
  if (agent.name === "claude") {
    try {
      const entry = JSON.parse(readFileSync(`${own.claude}/sessions/${pid}.json`, "utf8")) as Record<string, unknown>;
      const id = entry.sessionId;
      if (entry.pid !== pid || typeof id !== "string" || !isConversationId(id)) return null;
      // A file left by an earlier process with the same pid predates this one.
      const started = processStartMs(pid);
      if (started && typeof entry.startedAt === "number" && entry.startedAt < started - 60_000) return null;
      return id.toLowerCase();
    } catch {
      return null;
    }
  }
  for (const proc of [pid, ...descendants(pid)]) {
    for (const path of openFiles(proc)) {
      const match = CODEX_ROLLOUT_PATH.exec(path);
      if (match) return match[1]!.toLowerCase();
    }
  }
  return null;
}

function fromArgs(agent: Agent, args: string[], claimed: Set<string>): string | null {
  const id = agent.conversationInArgs(args)?.toLowerCase() ?? null;
  return id && !claimed.has(id) ? id : null;
}

/** The conversation in this directory written to most recently since the agent started. */
function latestIn(agent: Agent, cwd: string, pid: number, claimed: Set<string>, conversations: Conversations): string | null {
  const since = (processStartMs(pid) ?? 0) - 2000;
  for (const file of conversations.files()) {
    if (file.mtimeMs < since) break;
    if (file.agent === agent.name && !claimed.has(file.id) && conversations.cwdOf(file) === cwd) return file.id;
  }
  return null;
}

function pick(dirs: AgentDirs): Record<string, string> {
  return { CLAUDE_CONFIG_DIR: dirs.claude, CODEX_HOME: dirs.codex };
}

/** The agent directories a process was given in its environment (Linux only). */
function agentEnv(pid: number): Record<string, string> {
  const found: Record<string, string> = {};
  try {
    for (const entry of readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
      const eq = entry.indexOf("=");
      const name = entry.slice(0, eq);
      if ((name === "CLAUDE_CONFIG_DIR" || name === "CODEX_HOME") && entry.length > eq + 1) found[name] = entry.slice(eq + 1);
    }
  } catch {
    // not Linux, or the process is gone
  }
  return found;
}

let bootMs: number | null | undefined;

/** When a process started, in ms since the epoch (Linux only; null elsewhere). */
function processStartMs(pid: number): number | null {
  try {
    if (bootMs === undefined) {
      const btime = /^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"));
      bootMs = btime ? Number(btime[1]) * 1000 : null;
    }
    if (bootMs === null) return null;
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 22, starttime, in clock ticks (100 a second on Linux) after boot.
    const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
    return Number.isFinite(ticks) ? bootMs + ticks * 10 : null;
  } catch {
    return null;
  }
}

/** Child processes, grandchildren and so on: npm's codex runs the real one as a child. */
function descendants(pid: number, depth = 3): number[] {
  if (depth === 0) return [];
  const children: number[] = [];
  try {
    if (process.platform === "linux") {
      for (const task of readdirSync(`/proc/${pid}/task`)) {
        for (const child of readFileSync(`/proc/${pid}/task/${task}/children`, "utf8").split(" ")) {
          if (child.trim()) children.push(Number(child));
        }
      }
    } else {
      const out = Bun.spawnSync(["pgrep", "-P", String(pid)]).stdout.toString();
      for (const child of out.split("\n")) if (child.trim()) children.push(Number(child));
    }
  } catch {
    return [];
  }
  return children.flatMap((child) => [child, ...descendants(child, depth - 1)]);
}

/** The paths of the files a process has open: /proc on Linux, lsof elsewhere (macOS). */
function openFiles(pid: number): string[] {
  try {
    if (process.platform !== "linux") {
      const out = Bun.spawnSync(["lsof", "-p", String(pid), "-Fn"]).stdout.toString();
      return out.split("\n").flatMap((line) => (line.startsWith("n/") ? [line.slice(1)] : []));
    }
    return readdirSync(`/proc/${pid}/fd`).flatMap((fd) => {
      try {
        return [readlinkSync(`/proc/${pid}/fd/${fd}`)];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}
