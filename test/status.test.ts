// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { describe, expect, test } from "bun:test";
import type { ScreenText } from "../src/common/protocol.ts";
import { claudeStatus, claudeStop, codexStatus, codexTurn, screenSignals } from "../src/server/status.ts";

const NOW = 1_800_000_000_000;

function screen(lines: string[], quietMs = 10_000): ScreenText {
  return { session: "s", cols: 100, rows: 30, lines, altScreen: true, bracketedPaste: true, lastOutputAt: NOW - quietMs };
}

const user = (content: unknown) => ({ type: "user", message: { role: "user", content } });
const reply = (text: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const apiError = (error: string, text: string) => ({ ...reply(text), isApiErrorMessage: true, error });

describe("Claude Code", () => {
  test("its registry says whether it works, idles or waits", () => {
    expect(claudeStatus({ status: "busy" }, [], null, NOW)).toEqual({ activity: "working" });
    expect(claudeStatus({ status: "idle" }, [user("hi"), reply("hello")], null, NOW)).toEqual({ activity: "idle" });
    expect(claudeStatus({ status: "waiting", waitingFor: "dialog open" }, [], null, NOW)).toEqual({
      activity: "waiting",
      reason: "needs you",
    });
    expect(claudeStatus({ status: "waiting", waitingFor: "input needed" }, [], null, NOW)?.reason).toBe("needs input");
    // As Claude Code 2.1.330 reports a permission prompt.
    expect(claudeStatus({ status: "waiting", waitingFor: "permission prompt" }, [], null, NOW)?.reason).toBe("needs approval");
  });

  test("a turn an API error ended is a stop, with the kind of error", () => {
    const cases: Array<[string, string, string]> = [
      ["overloaded", "API Error: Repeated 529 Overloaded errors. The API is at capacity", "at capacity"],
      ["rate_limit", "API Error: Rate limited", "rate limited"],
      ["billing_error", "Claude usage limit reached", "usage limit"],
      ["server_error", "API Error: 500", "API unavailable"],
      ["authentication_failed", "Please run /login", "login needed"],
      ["invalid_request", "API Error: prompt is too long: 210000 tokens", "context full"],
      ["invalid_request", "API Error: Claude Opus's safeguards flagged this message", "safety block"],
      ["unknown", "API Error: something new", "API error"],
    ];
    for (const [error, text, reason] of cases) {
      expect(claudeStatus({ status: "idle" }, [user("go"), apiError(error, text)], null, NOW)).toEqual({
        activity: "stopped",
        reason,
        detail: text,
      });
    }
  });

  test("the error must end the turn: a prompt typed after it, or a cut-off reply, is no stop", () => {
    expect(claudeStop([apiError("overloaded", "API Error"), user("try again")])).toBeNull();
    expect(claudeStop([user("go"), apiError("max_output_tokens", "API Error: max tokens")])).toBeNull();
    // Lines that are not turns (titles, summaries) do not hide the error.
    expect(claudeStop([user("go"), apiError("rate_limit", "x"), { type: "ai-title", aiTitle: "t" }])?.reason).toBe(
      "rate limited",
    );
  });

  test("waiting and working come before an old error; idle comes after it", () => {
    const stopped = [user("go"), apiError("overloaded", "API Error: overloaded")];
    expect(claudeStatus({ status: "busy" }, stopped, null, NOW)?.activity).toBe("working");
    expect(claudeStatus({ status: "waiting" }, stopped, null, NOW)?.activity).toBe("waiting");
    expect(claudeStatus({ status: "idle" }, stopped, null, NOW)?.activity).toBe("stopped");
  });

  test("its own classification of a blocked turn counts as a stop", () => {
    expect(claudeStatus({ status: "idle", tempo: "blocked", needs: "rate limited — wait and retry" }, [], null, NOW)).toEqual({
      activity: "stopped",
      reason: "rate limited — wait and retry",
      detail: undefined,
    });
  });

  test("a version that writes no status is read from the screen", () => {
    expect(claudeStatus({}, [], screen(["> fix it", "API Error: 529 overloaded"]), NOW)).toEqual({
      activity: "stopped",
      reason: "at capacity",
      detail: "API Error: 529 overloaded",
    });
    expect(claudeStatus(null, null, screen(["working…"], 100), NOW)?.activity).toBe("working");
    expect(claudeStatus(null, null, screen(["Do you want to proceed?", "❯ 1. Yes", "  2. No"]), NOW)?.activity).toBe(
      "waiting",
    );
    // A dialog shown before its prompt starts, which its registry does not report.
    const trust = screen([" Quick safety check: Is this a project you created or one you trust?", " ❯ No, exit", "   Yes, I trust this folder", " Enter to confirm · Esc to cancel"]);
    expect(claudeStatus({ status: "idle" }, [], trust, NOW)).toEqual({ activity: "waiting", reason: "needs you" });
    expect(claudeStatus(null, null, null, NOW)).toBeNull();
  });
});

describe("Codex", () => {
  const started = { type: "event_msg", payload: { type: "task_started", turn_id: "1" } };
  const complete = (extra: object = {}) => ({
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "1", last_agent_message: "done", ...extra },
  });

  test("its rollout says whether a turn runs, ended, or ended in an error", () => {
    expect(codexTurn([started])).toEqual({ activity: "working" });
    expect(codexTurn([started, complete()])).toEqual({ activity: "idle", silent: false });
    expect(codexTurn([started, complete({ last_agent_message: null, error: { message: "Selected model is at capacity.", codex_error_info: "server_overloaded" } })])).toEqual({
      activity: "stopped",
      reason: "at capacity",
      detail: "Selected model is at capacity.",
    });
    const kinds: Array<[unknown, string]> = [
      ["usage_limit_exceeded", "usage limit"],
      ["cyber_policy", "safety block"],
      ["context_window_exceeded", "context full"],
      [{ response_too_many_failed_attempts: { http_status_code: 502 } }, "connection failed"],
      ["something_new", "error"],
    ];
    for (const [info, reason] of kinds) {
      expect(codexTurn([complete({ error: { message: "m", codex_error_info: info } })])?.reason).toBe(reason);
    }
    expect(codexTurn([{ type: "event_msg", payload: { type: "turn_aborted", reason: "interrupted" } }])).toEqual({
      activity: "idle",
      reason: "interrupted",
    });
    expect(codexTurn([{ type: "session_meta", payload: {} }])).toBeNull();
  });

  test("approval prompts and warnings, which it does not record, come from the screen", () => {
    const approval = screen([
      "Would you like to run the following command?",
      "  $ rm -rf build",
      "› 1. Yes, proceed (y)",
      "  3. No, and tell Codex what to do differently (esc)",
    ]);
    expect(codexStatus([started], approval, NOW)).toEqual({ activity: "waiting", reason: "needs approval" });
    const warned = screen(["⚠ Warning: Your account was flagged for potentially high-risk cyber activity"], 100);
    expect(codexStatus([started], warned, NOW)).toEqual({ activity: "working", warning: "cyber flag" });
    // The question alone, quoted in a reply, is no dialog.
    expect(codexStatus([started, complete()], screen(["He asked: Would you like to run the following command?"]), NOW)).toEqual({
      activity: "idle",
    });
  });

  test("a rollout that records no errors falls back on the screen for a turn that ended without a reply", () => {
    const silent = [started, { type: "event_msg", payload: { type: "task_complete", last_agent_message: null } }];
    expect(codexStatus(silent, screen(["■ You've hit your usage limit. Upgrade to Pro"]), NOW)).toEqual({
      activity: "stopped",
      reason: "usage limit",
      detail: "■ You've hit your usage limit. Upgrade to Pro",
    });
    expect(codexStatus(silent, null, NOW)).toEqual({ activity: "idle" });
  });
});

describe("the screen", () => {
  test("only its bottom counts, so an error long scrolled up is not a stop", () => {
    const lines = ["API Error: overloaded", ...Array.from({ length: 20 }, (_, i) => `line ${i}`)];
    expect(screenSignals("claude", lines).stop).toBeUndefined();
    expect(screenSignals("claude", lines.slice(-3).concat("API Error: overloaded")).stop?.reason).toBe("at capacity");
  });

  test("blank lines do not count towards the bottom", () => {
    expect(screenSignals("codex", ["Selected model is at capacity.", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "›"]).stop?.reason).toBe(
      "at capacity",
    );
  });
});
