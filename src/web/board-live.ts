// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

// What a board's task shows of the terminal working on it (DESIGN.md §8.7). The colour of a
// card is what the coordinating agent says; this is what SpectraWeaver sees for itself. Red and
// amber are alarms, as on the terminal's own window; the rest is information on the card.

import type { AgentStatus, BoardTask, SessionView } from "../common/protocol.ts";

export type LiveKind = "working" | "idle" | "waiting" | "stopped";

export interface TaskLive {
  /** The terminal's name on the card: its banner, else its id. */
  terminal: string;
  /** What it is doing, in a few words ("working", "idle 12m", "⚠ at capacity"); empty for nothing to say. */
  text: string;
  kind: LiveKind;
  /** "red": stopped, or a task in progress with no one working on it; "amber": waiting for an answer. */
  alarm: "red" | "amber" | null;
  /** More, for the tooltip: the agent's own words. */
  detail?: string;
}

/** A time to come, briefly in the viewer's own way: "22:30" today, "Sat 09:00" another day. */
export function clockTime(at: number, now: number): string {
  const when = new Date(at);
  const time = when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return when.toDateString() === new Date(now).toDateString()
    ? time
    : `${when.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/** How long ago, briefly: "now", "12m", "3h", "2d". */
export function shortAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/**
 * The live state of a task's terminal; null when the task names none. A missing or exited
 * terminal, or a shell with nothing running in it, is an alarm only while the task is in
 * progress: then no one is working on it. Agents that stopped or wait are alarms whatever the
 * task's status, as their windows are.
 */
export function taskLive(task: BoardTask, session: SessionView | undefined, now: number): TaskLive | null {
  if (!task.session) return null;
  const working = task.status === "wip";
  if (!session) {
    return working
      ? { terminal: task.session, text: "⚠ terminal closed", kind: "stopped", alarm: "red" }
      : { terminal: task.session, text: "closed", kind: "idle", alarm: null };
  }
  const terminal = session.banner || session.id;
  if (session.exited) {
    return working
      ? { terminal, text: "⚠ terminal exited", kind: "stopped", alarm: "red" }
      : { terminal, text: "exited", kind: "idle", alarm: null };
  }
  if (session.agent) return agentLive(terminal, session.agent, now);
  if (session.atPrompt) {
    return working
      ? { terminal, text: "⚠ not running", kind: "stopped", alarm: "red", detail: "Its shell waits at a prompt: nothing runs in it." }
      : { terminal, text: "shell", kind: "idle", alarm: null };
  }
  return { terminal, text: session.atPrompt === false ? "running" : "", kind: "idle", alarm: null };
}

/**
 * An agent's state in a few words, as every badge shows it (windows, the board), with how
 * long it has been idle unless `age` is false.
 */
export function agentLive(terminal: string, agent: AgentStatus, now: number, age = true): TaskLive {
  const detail = agent.detail;
  if (agent.activity === "stopped" || agent.warning) {
    const why = agent.activity === "stopped" ? (agent.reason ?? "stopped") : agent.warning;
    // A limit that lifts: when, and once it has, that the agent can be told to go on.
    const resets = agent.activity === "stopped" && agent.resetsAt !== undefined ? agent.resetsAt : undefined;
    const when = resets === undefined ? "" : now >= resets ? " · lifted" : ` · ${clockTime(resets, now)}`;
    return { terminal, text: `⚠ ${why}${when}`, kind: "stopped", alarm: "red", detail };
  }
  if (agent.activity === "waiting") {
    return { terminal, text: agent.reason ?? "needs you", kind: "waiting", alarm: "amber", detail };
  }
  if (agent.activity === "working") return { terminal, text: "working", kind: "working", alarm: null, detail };
  if (agent.activity === "idle") {
    const idle = age && agent.since !== undefined && now - agent.since >= 60_000 ? ` ${shortAge(now - agent.since)}` : "";
    return { terminal, text: `idle${idle}`, kind: "idle", alarm: null, detail };
  }
  return { terminal, text: agent.name, kind: "idle", alarm: null, detail };
}
