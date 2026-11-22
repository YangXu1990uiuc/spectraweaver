// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

// What the coding agent in a terminal is doing (AgentStatus): working, idle at its prompt,
// waiting for an answer, or stopped by an error it will not get past on its own. The agents'
// own files say it best, so they come first:
//
// - Claude Code writes `status` (busy, idle, waiting) and `waitingFor` into its session registry,
//   <config>/sessions/<pid>.json, and ends a turn an API error stopped with an entry marked
//   `isApiErrorMessage` (and an `error` type: rate_limit, overloaded, billing_error...) in its
//   transcript.
// - Codex records each turn's start and end in its rollout; a turn an error ended carries the
//   error and its kind (`codex_error_info`: usage_limit_exceeded, server_overloaded, cyber_policy...).
//
// The screen fills the gaps: Codex does not record approval prompts or warnings, and older
// versions of either agent record less. Text on the screen can be anything the agent printed,
// so it is read only near the bottom and only in those gaps.

import { statSync } from "node:fs";
import type { AgentActivity, AgentStatus, ScreenText } from "../common/protocol.ts";
import type { Agent, AgentName } from "./agents.ts";
import { type AgentDirs, type Conversations, type Line, tailLines } from "./conversations.ts";
import { claudeRegistry } from "./revival.ts";

type Found = Omit<AgentStatus, "name">;
interface Stop {
  reason: string;
  detail?: string;
}

/** A program quiet this long is not working, as far as its screen can tell. */
const QUIET_MS = 3000;
// The bottom of the screen, where an agent shows its latest message, prompt or dialog.
const BOTTOM_LINES = 15;
const DIALOG_LINES = 30;
// Most transcript lines are small; tool results can be large, so a second, longer look.
const TAIL_FIRST = 64 * 1024;
const TAIL_MORE = 1024 * 1024;
const DETAIL_MAX = 300;
// Claude Code writes no transcript until the first message: a missing one is looked for again
// after a while, not on every look (each search lists every conversation).
const MISSING_RETRY_MS = 5000;
// Transcripts no terminal has looked at for this long are dropped from memory.
const UNUSED_MS = 60_000;

/** Reads agents' statuses, rereading a transcript only when it changed. */
export class AgentStatusReader {
  private tails = new Map<string, { mtimeMs: number; size: number; lines: Line[]; usedAt: number }>();
  private missing = new Map<string, number>();

  constructor(
    private readonly conversations: Conversations,
    private readonly dirs: AgentDirs,
  ) {}

  /**
   * `conversation` is the conversation the agent is known to be on (Codex's rollout is found
   * through it); `screen` is null when the daemon cannot show text.
   */
  status(agent: Agent, pid: number, conversation: string | undefined, screen: ScreenText | null, now = Date.now()): AgentStatus {
    let status: Found | null;
    if (agent.name === "claude") {
      const registry = claudeRegistry(pid, this.dirs);
      const id = typeof registry?.sessionId === "string" ? registry.sessionId : conversation;
      status = claudeStatus(registry, this.transcript("claude", id), screen, now);
    } else {
      status = codexStatus(this.transcript("codex", conversation), screen, now);
    }
    return { name: agent.name, ...(status ?? { activity: "unknown" }) };
  }

  private transcript(agent: AgentName, id: string | undefined): Line[] | null {
    if (!id) return null;
    const now = Date.now();
    for (const [path, tail] of this.tails) if (now - tail.usedAt > UNUSED_MS) this.tails.delete(path);
    const key = `${agent}:${id}`;
    if (now - (this.missing.get(key) ?? 0) < MISSING_RETRY_MS) return null;
    const file = this.conversations.find(agent, id);
    if (!file) {
      this.missing.set(key, now);
      return null;
    }
    this.missing.delete(key);
    try {
      const { mtimeMs, size } = statSync(file.path);
      const cached = this.tails.get(file.path);
      if (cached?.mtimeMs === mtimeMs && cached.size === size) {
        cached.usedAt = now;
        return cached.lines;
      }
      let lines = tailLines(file.path, TAIL_FIRST);
      if (!lines.some(isTurnLine)) lines = tailLines(file.path, TAIL_MORE);
      this.tails.set(file.path, { mtimeMs, size, lines, usedAt: now });
      return lines;
    } catch {
      return null;
    }
  }
}

function isTurnLine(line: Line): boolean {
  return line.type === "user" || line.type === "assistant" || line.type === "event_msg";
}

// ---- Claude Code ------------------------------------------------------------------------

export function claudeStatus(
  registry: Record<string, unknown> | null,
  transcript: Line[] | null,
  screen: ScreenText | null,
  now: number,
): Found | null {
  const status = registry?.status;
  const warning = transcript ? claudeWarning(transcript) : undefined;
  if (status === "busy") return withWarning({ activity: "working" }, warning);
  if (status === "waiting") return { activity: "waiting", reason: waitingLabel(registry?.waitingFor) };
  const dialog = screen ? screenSignals("claude", screen.lines).waiting : undefined;
  if (dialog) return { activity: "waiting", reason: dialog };
  const stop = transcript ? claudeStop(transcript) : null;
  if (stop) return { activity: "stopped", ...stop };
  // Some versions classify a turn's ending themselves.
  if (registry?.tempo === "blocked" && typeof registry.needs === "string") {
    return { activity: "stopped", reason: short(registry.needs), detail: text(registry.detail) };
  }
  if (status === "idle") return withWarning({ activity: "idle" }, warning);
  // Versions that write no status.
  return screenStatus("claude", screen, now);
}

function waitingLabel(waitingFor: unknown): string {
  switch (waitingFor) {
    case undefined:
    case "dialog open":
      return "needs you";
    case "input needed":
      return "needs input";
    case "permission prompt":
    case "sandbox request":
    case "worker request":
      return "needs approval";
    default:
      return typeof waitingFor === "string" ? short(waitingFor) : "needs you";
  }
}

/** The error that ended the last turn, if one did: the turn's last message is an API error. */
export function claudeStop(transcript: Line[]): Stop | null {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const line = transcript[i]!;
    if ((line.type !== "user" && line.type !== "assistant") || line.isMeta === true || line.isSidechain === true) continue;
    if (line.type !== "assistant" || line.isApiErrorMessage !== true) return null;
    // A reply cut off at its length limit is not a stop: Claude Code carries on.
    if (line.error === "max_output_tokens") return null;
    const message = messageText(line);
    return { reason: claudeErrorReason(typeof line.error === "string" ? line.error : "", message), detail: message || undefined };
  }
  return null;
}

function claudeErrorReason(error: string, message: string): string {
  if (/safeguards|usage policy|cyber/i.test(message)) return "safety block";
  switch (error) {
    case "rate_limit":
      return "rate limited";
    case "billing_error":
      return "usage limit";
    case "overloaded":
      return "at capacity";
    case "server_error":
      return "API unavailable";
    case "authentication_failed":
    case "oauth_org_not_allowed":
      return "login needed";
    case "invalid_request":
      if (/too long|too large|exceeds|token limit/i.test(message)) return "context full";
  }
  return screenStop(message)?.reason ?? "API error";
}

/** Claude Code answered this turn with another model after a safety refusal. */
function claudeWarning(transcript: Line[]): string | undefined {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const line = transcript[i]!;
    if (line.type === "system" && line.subtype === "model_refusal_fallback") return "safety fallback";
    if (line.type === "user" && line.isMeta !== true && typedByPerson(line)) return undefined;
  }
  return undefined;
}

function typedByPerson(line: Line): boolean {
  const content = (line.message as Line | undefined)?.content;
  if (typeof content === "string") return true;
  return Array.isArray(content) && content.some((part) => (part as Line)?.type === "text");
}

function messageText(line: Line): string {
  const content = (line.message as Line | undefined)?.content;
  if (typeof content === "string") return detail(content);
  if (!Array.isArray(content)) return "";
  return detail(content.map((part) => ((part as Line)?.type === "text" ? String((part as Line).text ?? "") : "")).join(" "));
}

// ---- Codex ------------------------------------------------------------------------------

interface CodexTurn {
  activity: AgentActivity;
  reason?: string;
  detail?: string;
  /** The turn ended without a reply and without saying why (versions that record no errors). */
  silent?: boolean;
}

export function codexStatus(rollout: Line[] | null, screen: ScreenText | null, now: number): Found | null {
  const signals = screen ? screenSignals("codex", screen.lines) : {};
  // Approval prompts come up in the middle of a turn and are not recorded.
  if (signals.waiting) return { activity: "waiting", reason: signals.waiting };
  const turn = rollout ? codexTurn(rollout) : null;
  const warning = signals.warning;
  if (turn?.activity === "working") return withWarning({ activity: "working" }, warning);
  if (turn?.activity === "stopped") return { activity: "stopped", reason: turn.reason, detail: turn.detail };
  if (turn?.activity === "idle" && !turn.silent) return withWarning({ activity: "idle", reason: turn.reason }, warning);
  return screenStatus("codex", screen, now) ?? (turn ? { activity: turn.activity } : null);
}

/** Where the last turn in a rollout stands. */
export function codexTurn(rollout: Line[]): CodexTurn | null {
  for (let i = rollout.length - 1; i >= 0; i--) {
    const line = rollout[i]!;
    if (line.type !== "event_msg") continue;
    const payload = line.payload as Line | undefined;
    switch (payload?.type) {
      case "task_started":
      case "turn_started":
        return { activity: "working" };
      case "task_complete":
      case "turn_complete":
        if (payload.error) return { activity: "stopped", ...codexError(payload.error) };
        return { activity: "idle", silent: !("error" in payload) && payload.last_agent_message == null };
      case "turn_aborted":
        if (payload.error) return { activity: "stopped", ...codexError(payload.error) };
        if (payload.reason === "budget_limited") return { activity: "stopped", reason: "budget limit" };
        return { activity: "idle", reason: payload.reason === "interrupted" ? "interrupted" : undefined };
    }
  }
  return null;
}

const CODEX_ERRORS: Record<string, string> = {
  usage_limit_exceeded: "usage limit",
  session_budget_exceeded: "budget limit",
  rate_limit_exceeded: "rate limited",
  server_overloaded: "at capacity",
  flex_unavailable: "at capacity",
  policy_capacity_unavailable: "at capacity",
  cyber_policy: "safety block",
  bio_policy: "safety block",
  misalignment_policy_violation: "safety block",
  invalid_prompt: "safety block",
  inference_hook_denied: "blocked by a hook",
  context_window_exceeded: "context full",
  unauthorized: "login needed",
  http_connection_failed: "connection failed",
  response_stream_connection_failed: "connection failed",
  response_stream_disconnected: "connection failed",
  response_too_many_failed_attempts: "connection failed",
  internal_server_error: "API unavailable",
  too_many_denials: "too many denials",
  model_not_found: "model not found",
};

function codexError(error: unknown): Stop {
  const event = (typeof error === "object" && error !== null ? error : {}) as Line;
  const message = detail(text(event.message) ?? "");
  // A unit variant is a string, one with fields an object with a single key.
  const info = event.codex_error_info;
  const kind = typeof info === "string" ? info : typeof info === "object" && info !== null ? Object.keys(info)[0] : undefined;
  const reason = (kind && CODEX_ERRORS[kind]) ?? screenStop(message)?.reason ?? "error";
  return { reason, detail: message || undefined };
}

// ---- the screen -------------------------------------------------------------------------

const STOPS: Array<[RegExp, string]> = [
  [/high-risk cyber activity|safeguards flagged|limited access to this content for safety|violates? .{0,20}usage policy/i, "safety block"],
  [/usage limit|hit your (usage )?limit|out of (usage )?credits|spend (cap|limit)|quota exceeded/i, "usage limit"],
  [/rate.?limit/i, "rate limited"],
  [/at capacity|high (load|demand)|overloaded|capacity (is )?unavailable/i, "at capacity"],
  [/ran out of room in the model's context window|context limit reached|prompt is too long/i, "context full"],
  [/exceeded retry limit|stream disconnected before completion/i, "connection failed"],
  [/please run \/login|not logged in|oauth token has expired/i, "login needed"],
  [/^\W{0,4}API Error\b/, "API error"],
];

const WARNINGS: Array<[RegExp, string]> = [[/flagged for potentially high-risk cyber activity/i, "cyber flag"]];

// A dialog needs its question and its choices on the screen together.
const DIALOGS: Record<AgentName, { question: RegExp; choices: RegExp; reason: string }> = {
  codex: {
    question:
      /Would you like to (run the following command|make the following edits|grant these permissions|send input to)|Do you want to approve network access/,
    choices: /Yes, proceed|Yes, just this once|No, and tell Codex/,
    reason: "needs approval",
  },
  // Claude Code's dialogs end with this footer; its registry misses those shown before its prompt
  // starts (whether to trust a folder, for one).
  claude: {
    question: /Do you want to (proceed|make this edit|create|allow|run)|Enter to confirm · Esc to (cancel|exit)/,
    choices: /\b1\. Yes\b|❯ |Enter to confirm/,
    reason: "needs you",
  },
};

interface ScreenSignals {
  waiting?: string;
  stop?: Stop;
  warning?: string;
}

/** What the bottom of the screen shows: a dialog, an error, a warning. */
export function screenSignals(agent: AgentName, lines: string[]): ScreenSignals {
  const shown = lines.map((line) => line.trim()).filter(Boolean);
  const bottom = shown.slice(-BOTTOM_LINES);
  const signals: ScreenSignals = {};
  const dialog = DIALOGS[agent];
  const near = shown.slice(-DIALOG_LINES);
  if (near.some((line) => dialog.question.test(line)) && near.some((line) => dialog.choices.test(line))) {
    signals.waiting = dialog.reason;
  }
  for (let i = bottom.length - 1; i >= 0 && !signals.stop; i--) {
    const stop = screenStop(bottom[i]!);
    if (stop) signals.stop = stop;
  }
  for (const line of bottom) {
    for (const [pattern, warning] of WARNINGS) if (pattern.test(line)) signals.warning = warning;
  }
  return signals;
}

function screenStop(line: string): Stop | null {
  for (const [pattern, reason] of STOPS) if (pattern.test(line)) return { reason, detail: detail(line) };
  return null;
}

/** What the screen alone tells: a program printing is working; a quiet one shows why it stopped. */
function screenStatus(agent: AgentName, screen: ScreenText | null, now: number): Found | null {
  if (!screen) return null;
  const signals = screenSignals(agent, screen.lines);
  if (signals.waiting) return { activity: "waiting", reason: signals.waiting };
  const quiet = screen.lastOutputAt === null || now - screen.lastOutputAt >= QUIET_MS;
  if (!quiet) return withWarning({ activity: "working" }, signals.warning);
  if (signals.stop) return { activity: "stopped", ...signals.stop };
  return withWarning({ activity: "idle" }, signals.warning);
}

// ---- helpers ----------------------------------------------------------------------------

function withWarning(status: Found, warning: string | undefined): Found {
  return warning ? { ...status, warning } : status;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function detail(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX - 1)}…` : flat;
}

function short(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 40 ? `${flat.slice(0, 39)}…` : flat;
}
