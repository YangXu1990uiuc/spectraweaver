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
  resetsAt?: number;
}

/** An agent's latest reply, for `spectraweaver read --reply`. */
export interface Reply {
  text: string;
  /** When it was written, ms since the epoch, if the agent recorded it. */
  at?: number;
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
// A reply can sit behind large tool results: a longer look at the transcript, then a longer one.
const REPLY_TAILS = [256 * 1024, 4 * 1024 * 1024];
const REPLY_MAX = 64 * 1024;

/** Reads agents' statuses, rereading a transcript only when it changed. */
export class AgentStatusReader {
  private tails = new Map<string, { mtimeMs: number; size: number; lines: Line[]; usedAt: number }>();
  private missing = new Map<string, number>();
  /** The model each conversation last showed, for a look whose tail of the transcript has none. */
  private models = new Map<string, string>();

  constructor(
    private readonly conversations: Conversations,
    private readonly dirs: AgentDirs,
    /** How long a program must print nothing to be taken as no longer working (screen fallback). */
    private readonly quietMs = QUIET_MS,
  ) {}

  /**
   * `conversation` is the conversation the agent is known to be on (Codex's rollout is found
   * through it); `screen` is null when the daemon cannot show text.
   */
  status(agent: Agent, pid: number, conversation: string | undefined, screen: ScreenText | null, now = Date.now()): AgentStatus {
    let status: Found | null;
    let model: string | undefined;
    let id = conversation;
    if (agent.name === "claude") {
      const registry = claudeRegistry(pid, this.dirs);
      if (typeof registry?.sessionId === "string") id = registry.sessionId;
      const transcript = this.transcript("claude", id);
      status = claudeStatus(registry, transcript, screen, now, this.quietMs);
      model = transcript ? claudeModel(transcript) : undefined;
    } else {
      const rollout = this.transcript("codex", id);
      status = codexStatus(rollout, screen, now, this.quietMs);
      model = rollout ? codexModel(rollout) : undefined;
    }
    if (id) {
      const key = `${agent.name}:${id}`;
      if (model) this.models.set(key, model);
      else model = this.models.get(key);
    }
    if (this.models.size > 1000) this.models.clear();
    return { name: agent.name, ...(status ?? { activity: "unknown" }), ...(model ? { model } : {}) };
  }

  /**
   * The latest reply of an agent, from its transcript: the one running as `pid` (Claude Code's
   * registry names its conversation), else the conversation recorded for the terminal.
   */
  reply(agent: AgentName, pid: number | undefined, conversation: string | undefined): Reply | null {
    let id = conversation;
    if (agent === "claude" && pid !== undefined) {
      const registry = claudeRegistry(pid, this.dirs);
      if (typeof registry?.sessionId === "string") id = registry.sessionId;
    }
    const file = id ? this.conversations.find(agent, id) : undefined;
    if (!file) return null;
    for (const size of REPLY_TAILS) {
      const found = (agent === "claude" ? claudeReply : codexReply)(tailLines(file.path, size));
      if (found) return found.text.length > REPLY_MAX ? { ...found, text: `${found.text.slice(0, REPLY_MAX)}\n…` } : found;
    }
    return null;
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
  quietMs = QUIET_MS,
): Found | null {
  const status = registry?.status;
  const warning = transcript ? claudeWarning(transcript) : undefined;
  if (status === "busy") return withWarning({ activity: "working" }, warning);
  // Its turn is over but a shell it started in the background still runs; it carries on by itself
  // when that ends, so it is not done: working, as far as anyone watching it is concerned.
  const shells = screen ? backgroundShells(screen.lines) : 0;
  if (status === "shell" || (status === "idle" && shells > 0)) {
    return withWarning({ activity: "working", reason: shells > 1 ? `${shells} shells in background` : "a shell in background" }, warning);
  }
  const asks = screen ? dialogText("claude", screen.lines) : undefined;
  if (status === "waiting") return withDetail({ activity: "waiting", reason: waitingLabel(registry?.waitingFor) }, asks);
  const dialog = screen ? screenSignals("claude", screen.lines).waiting : undefined;
  if (dialog) return withDetail({ activity: "waiting", reason: dialog }, asks);
  const stop = transcript ? claudeStop(transcript, now) : null;
  if (stop) return { activity: "stopped", ...stop };
  // Some versions classify a turn's ending themselves.
  if (registry?.tempo === "blocked" && typeof registry.needs === "string") {
    return { activity: "stopped", reason: short(registry.needs), detail: text(registry.detail) };
  }
  if (status === "idle") return withWarning({ activity: "idle" }, warning);
  // Versions that write no status.
  return screenStatus("claude", screen, now, quietMs);
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

/**
 * The error that ended the last turn, if one did: the turn's last message is an API error. A
 * limit's end is read from its words, from when they were written (`now` if not recorded).
 */
export function claudeStop(transcript: Line[], now = Date.now()): Stop | null {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const line = transcript[i]!;
    if ((line.type !== "user" && line.type !== "assistant") || line.isMeta === true || line.isSidechain === true) continue;
    if (line.type !== "assistant" || line.isApiErrorMessage !== true) return null;
    // A reply cut off at its length limit is not a stop: Claude Code carries on.
    if (line.error === "max_output_tokens") return null;
    const message = messageText(line);
    const stop: Stop = { reason: claudeErrorReason(typeof line.error === "string" ? line.error : "", message), detail: message || undefined };
    const resetsAt = message ? limitResets(message, writtenAt(line) ?? now) : undefined;
    if (resetsAt !== undefined) stop.resetsAt = resetsAt;
    return stop;
  }
  return null;
}

function claudeErrorReason(error: string, message: string): string {
  if (/safeguards|usage policy|cyber/i.test(message)) return "safety block";
  // A plan's limits come as rate_limit errors: "You've hit your 5-hour limit · resets 10:30pm (…)".
  if (screenStop(message)?.reason === "usage limit") return "usage limit";
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
  resetsAt?: number;
  /** The turn ended without a reply and without saying why (versions that record no errors). */
  silent?: boolean;
}

export function codexStatus(rollout: Line[] | null, screen: ScreenText | null, now: number, quietMs = QUIET_MS): Found | null {
  const signals = screen ? screenSignals("codex", screen.lines) : {};
  // Approval prompts come up in the middle of a turn and are not recorded.
  if (signals.waiting) return withDetail({ activity: "waiting", reason: signals.waiting }, dialogText("codex", screen!.lines));
  const turn = rollout ? codexTurn(rollout, now) : null;
  const warning = signals.warning;
  if (turn?.activity === "working") return withWarning({ activity: "working" }, warning);
  if (turn?.activity === "stopped") {
    const stop: Found = { activity: "stopped", reason: turn.reason, detail: turn.detail };
    if (turn.resetsAt !== undefined) stop.resetsAt = turn.resetsAt;
    return stop;
  }
  if (turn?.activity === "idle" && !turn.silent) return withWarning({ activity: "idle", reason: turn.reason }, warning);
  return screenStatus("codex", screen, now, quietMs) ?? (turn ? { activity: turn.activity } : null);
}

/** Where the last turn in a rollout stands; `now` stands in for when an error was written, if not recorded. */
export function codexTurn(rollout: Line[], now = Date.now()): CodexTurn | null {
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
        if (payload.error) return { activity: "stopped", ...codexError(payload.error, writtenAt(line) ?? now) };
        return { activity: "idle", silent: !("error" in payload) && payload.last_agent_message == null };
      case "turn_aborted":
        if (payload.error) return { activity: "stopped", ...codexError(payload.error, writtenAt(line) ?? now) };
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

function codexError(error: unknown, at: number): Stop {
  const event = (typeof error === "object" && error !== null ? error : {}) as Line;
  const message = detail(text(event.message) ?? "");
  // A unit variant is a string, one with fields an object with a single key.
  const info = event.codex_error_info;
  const kind = typeof info === "string" ? info : typeof info === "object" && info !== null ? Object.keys(info)[0] : undefined;
  const reason = (kind && CODEX_ERRORS[kind]) ?? screenStop(message)?.reason ?? "error";
  const stop: Stop = { reason, detail: message || undefined };
  const resetsAt = message ? limitResets(message, at) : undefined;
  if (resetsAt !== undefined) stop.resetsAt = resetsAt;
  return stop;
}

// ---- the screen -------------------------------------------------------------------------

const STOPS: Array<[RegExp, string]> = [
  [/high-risk cyber activity|safeguards flagged|limited access to this content for safety|violates? .{0,20}usage policy/i, "safety block"],
  [/usage limit|hit your (?:[\w-]+ ){0,2}limit|out of (usage )?credits|spend (cap|limit)|quota exceeded/i, "usage limit"],
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
function screenStatus(agent: AgentName, screen: ScreenText | null, now: number, quietMs: number): Found | null {
  if (!screen) return null;
  const signals = screenSignals(agent, screen.lines);
  if (signals.waiting) return withDetail({ activity: "waiting", reason: signals.waiting }, dialogText(agent, screen.lines));
  const quiet = screen.lastOutputAt === null || now - screen.lastOutputAt >= quietMs;
  if (!quiet) return withWarning({ activity: "working" }, signals.warning);
  if (signals.stop) {
    const stop: Found = { activity: "stopped", ...signals.stop };
    // Printed when the program last printed anything, near enough.
    const resetsAt = signals.stop.detail ? limitResets(signals.stop.detail, screen.lastOutputAt ?? now) : undefined;
    if (resetsAt !== undefined) stop.resetsAt = resetsAt;
    return stop;
  }
  return withWarning({ activity: "idle" }, signals.warning);
}

// ---- helpers ----------------------------------------------------------------------------

function withWarning(status: Found, warning: string | undefined): Found {
  return warning ? { ...status, warning } : status;
}

function withDetail(status: Found, words: string | undefined): Found {
  return words ? { ...status, detail: words } : status;
}

/** When a transcript or rollout line was written, if it says. */
function writtenAt(line: Line): number | undefined {
  const at = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : Number.NaN;
  return Number.isFinite(at) ? at : undefined;
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

/**
 * The shells Claude Code runs in the background, from its status line ("⏸ manual mode on · 1 shell
 * · ↓ to manage"): the last lines only, and only as one of its parts, so prose does not count.
 */
export function backgroundShells(lines: string[]): number {
  const bottom = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-2);
  for (const line of bottom) {
    const match = /(?:^|·)\s*(\d+) (?:background )?shells?\s*(?:·|$)/.exec(line);
    if (match) return Number(match[1]);
  }
  return 0;
}

// ---- what a dialog asks -----------------------------------------------------------------

/** The line Claude Code draws above its prompt box, and above a dialog in its place. */
const RULE = /^[─━]{20,}$/;
/** The dashed lines around the command a permission prompt shows. */
const DASHES = /^[╌┄┈]{20,}$/;
/** An option of a dialog: numbered, or the one the cursor is on. */
const OPTION = /^(?:[❯›]\s*)?\d+\.\s|^[❯›]\s*\S/;
/** Lines of a dialog that say nothing about what it asks. */
const DIALOG_NOISE = /^(?:Tip:|Security guide$|Esc to |Enter to confirm|Press enter)/i;

/**
 * What a dialog at the bottom of the screen asks, in one line: for Claude Code, from the rule
 * above it to its options ("Bash command · Create the build directory · mkdir build · Do you
 * want to proceed?"); for Codex, from its question to its options. Tips and key hints are left
 * out, and lines the dialog wrapped itself are joined back.
 */
export function dialogText(agent: AgentName, lines: string[]): string | undefined {
  // Blank lines do not count, as for screenSignals: a tall screen ends in many.
  const near = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-DIALOG_LINES);
  // The options are the lowest run of option lines; what the dialog asks is above them.
  let first = -1;
  for (let i = near.length - 1; i >= 0; i--) {
    if (OPTION.test(near[i]!)) first = i;
    else if (first >= 0) break;
  }
  if (first < 0) return undefined;
  let start = -1;
  if (agent === "claude") {
    for (let i = first - 1; i >= 0 && start < 0; i--) if (RULE.test(near[i]!)) start = i + 1;
    if (start < 0) start = Math.max(0, first - 6);
  } else {
    for (let i = first - 1; i >= 0 && start < 0; i--) if (DIALOGS.codex.question.test(near[i]!)) start = i;
    if (start < 0) start = Math.max(0, first - 4);
  }
  let words = "";
  let apart = false;
  for (const line of near.slice(start, first)) {
    if (DASHES.test(line) || RULE.test(line) || DIALOG_NOISE.test(line)) {
      apart ||= DASHES.test(line);
      continue;
    }
    // A line the dialog wrapped goes on in lower case; the dashed lines set a command apart.
    const goesOn = !apart && (/^[a-z(]/.test(line) || words.endsWith(":"));
    words += !words ? line : goesOn ? ` ${line}` : ` · ${line}`;
    apart = false;
  }
  return words ? detail(words) : undefined;
}

// ---- when a limit lifts -----------------------------------------------------------------

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const UNITS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };

/**
 * When a limit lifts, in ms since the epoch, from the agent's words written at `at`: Claude
 * Code's "resets 10:30pm (America/Los_Angeles)" or "resets Nov 28, 9am (…)", Codex's "try again
 * at 3:05 PM" or "try again in 2 hours 13 minutes". A time without a zone is this machine's.
 */
export function limitResets(words: string, at: number): number | undefined {
  const after = /(?:resets|try again)\s+in\s+((?:\d+\s*(?:days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|[dhms])\b[\s,]*(?:and\s+)?)+)/i.exec(words);
  if (after) {
    let ms = 0;
    for (const [, count, unit] of after[1]!.matchAll(/(\d+)\s*([a-z])/gi)) ms += Number(count) * (UNITS[unit!.toLowerCase()] ?? 0);
    return ms > 0 ? at + ms : undefined;
  }
  const clock =
    /(?:resets|try again)(?:\s+at)?\s+(?:([A-Za-z]{3})[a-z]*\.?\s+(?:(\d{1,2})(?:st|nd|rd|th)?,?\s+)?(?:(\d{4}),?\s+)?(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?m?\.?(?![\w:])(?:\s*\(([^)]+)\))?/i.exec(
      words,
    );
  if (!clock) return undefined;
  const [, name, day, year, hours, minutes, half, zone] = clock;
  // A bare number is no time ("resets 5"); a time has minutes, or am / pm.
  if (minutes === undefined && half === undefined) return undefined;
  let hour = Number(hours);
  if (half) hour = (hour % 12) + (half.toLowerCase() === "p" ? 12 : 0);
  const minute = Number(minutes ?? 0);
  if (hour > 23 || minute > 59) return undefined;
  for (const timeZone of zone ? [zone.trim(), undefined] : [undefined]) {
    try {
      return nextTime(at, timeZone, hour, minute, name?.toLowerCase().slice(0, 3), day, year);
    } catch {
      // not a zone this machine knows: its own, then
    }
  }
  return undefined;
}

/** The first moment after `at` (less a minute) that the clock in `timeZone` shows the time asked for. */
function nextTime(at: number, timeZone: string | undefined, hour: number, minute: number, name?: string, day?: string, year?: string): number | undefined {
  const today = wallClock(at, timeZone);
  const month = name ? MONTHS.indexOf(name) : -1;
  const weekday = name ? WEEKDAYS.indexOf(name) : -1;
  const at24 = (y: number, m: number, d: number) => zoned(y, m, d, hour, minute, timeZone);
  if (month >= 0 && day) {
    const y = year ? Number(year) : today.year;
    const when = at24(y, month, Number(day));
    return when < at - 86_400_000 && !year ? at24(y + 1, month, Number(day)) : when;
  }
  const ahead = weekday >= 0 ? (weekday - today.weekday + 7) % 7 : 0;
  let when = at24(today.year, today.month, today.day + ahead);
  if (when < at - 60_000) when = at24(today.year, today.month, today.day + ahead + (weekday >= 0 ? 7 : 1));
  return when;
}

/** What the clock in `timeZone` (this machine's when undefined) shows at an instant. */
function wallClock(instant: number, timeZone: string | undefined) {
  const parts: Record<string, string> = {};
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    weekday: "short",
  });
  for (const part of format.formatToParts(instant)) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month) - 1,
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS.indexOf((parts.weekday ?? "").toLowerCase().slice(0, 3)),
  };
}

/** The instant the clock in `timeZone` shows a date and time; days past a month's end roll over. */
function zoned(year: number, month: number, day: number, hour: number, minute: number, timeZone: string | undefined): number {
  const wanted = Date.UTC(year, month, day, hour, minute);
  const offset = (instant: number) => {
    const shown = wallClock(instant, timeZone);
    return Date.UTC(shown.year, shown.month, shown.day, shown.hour, shown.minute, shown.second) - Math.floor(instant / 1000) * 1000;
  };
  // Twice, for a time near a change of the clocks.
  const first = wanted - offset(wanted);
  return wanted - offset(first);
}

// ---- the model, and the latest reply ----------------------------------------------------

/** The model of Claude Code's latest reply; its error messages name no real model. */
export function claudeModel(transcript: Line[]): string | undefined {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const line = transcript[i]!;
    if (line.type !== "assistant" || line.isSidechain === true) continue;
    const model = (line.message as Line | undefined)?.model;
    if (typeof model === "string" && model && !model.startsWith("<")) return model;
  }
  return undefined;
}

/** The model of Codex's latest turn, from the context it records for each. */
export function codexModel(rollout: Line[]): string | undefined {
  for (let i = rollout.length - 1; i >= 0; i--) {
    const line = rollout[i]!;
    if (line.type !== "turn_context") continue;
    const model = (line.payload as Line | undefined)?.model;
    if (typeof model === "string" && model) return model;
  }
  return undefined;
}

/**
 * Claude Code's latest words: the text of its latest message that has any (a message is several
 * lines, one per part, sharing an id), so a turn still running shows what it last said.
 */
export function claudeReply(transcript: Line[]): Reply | null {
  const parts: string[] = [];
  let id: unknown;
  let at: number | undefined;
  for (let i = transcript.length - 1; i >= 0; i--) {
    const line = transcript[i]!;
    if (line.isSidechain === true || line.isApiErrorMessage === true) continue;
    if (line.type !== "assistant") {
      if (parts.length > 0 && line.type === "user") break;
      continue;
    }
    const message = (line.message ?? {}) as Line;
    const content = Array.isArray(message.content) ? (message.content as Line[]) : [];
    const words = content.flatMap((part) => (part?.type === "text" && typeof part.text === "string" && part.text.trim() ? [part.text] : []));
    if (parts.length > 0 && message.id !== id) break;
    if (words.length === 0) continue;
    id = message.id;
    parts.unshift(...words);
    at ??= writtenAt(line);
  }
  return parts.length > 0 ? { text: parts.join("\n\n").trim(), ...(at !== undefined ? { at } : {}) } : null;
}

/** Codex's latest words: its latest message, as recorded for the person or as the turn's last. */
export function codexReply(rollout: Line[]): Reply | null {
  for (let i = rollout.length - 1; i >= 0; i--) {
    const line = rollout[i]!;
    const payload = (line.payload ?? {}) as Line;
    let words: string | undefined;
    if (line.type === "event_msg" && payload.type === "agent_message") words = text(payload.message);
    else if (line.type === "event_msg" && (payload.type === "task_complete" || payload.type === "turn_complete")) words = text(payload.last_agent_message);
    else if (line.type === "response_item" && payload.type === "message" && payload.role === "assistant" && Array.isArray(payload.content)) {
      words = text((payload.content as Line[]).map((part) => (part?.type === "output_text" && typeof part.text === "string" ? part.text : "")).join(""));
    }
    if (words) {
      const at = writtenAt(line);
      return { text: words.trim(), ...(at !== undefined ? { at } : {}) };
    }
  }
  return null;
}
