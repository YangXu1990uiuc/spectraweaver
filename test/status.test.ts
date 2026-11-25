// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { describe, expect, test } from "bun:test";
import type { ScreenText } from "../src/common/protocol.ts";
import {
  backgroundShells,
  claudeModel,
  claudeReply,
  claudeStatus,
  claudeStop,
  codexModel,
  codexReply,
  codexStatus,
  codexTurn,
  dialogText,
  limitResets,
  screenSignals,
} from "../src/server/status.ts";

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
    expect(claudeStatus({ status: "idle" }, [], trust, NOW)).toEqual({
      activity: "waiting",
      reason: "needs you",
      detail: "Quick safety check: Is this a project you created or one you trust?",
    });
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
    expect(codexStatus([started], approval, NOW)).toEqual({
      activity: "waiting",
      reason: "needs approval",
      detail: "Would you like to run the following command? · $ rm -rf build",
    });
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

describe("a shell in the background", () => {
  // As Claude Code 2.1.330 shows it: its registry says "shell", its status line counts them.
  const footer = (part: string) => screen(["● started", "─".repeat(100), "❯", "─".repeat(100), `  ⏸ manual mode on · ${part} · ↓ to manage`]);

  test("an agent idle with a shell still running counts as working: it carries on by itself", () => {
    expect(claudeStatus({ status: "shell" }, [], footer("1 shell"), NOW)).toEqual({ activity: "working", reason: "a shell in background" });
    expect(claudeStatus({ status: "shell" }, [], footer("5 shells"), NOW)).toEqual({ activity: "working", reason: "5 shells in background" });
    expect(claudeStatus({ status: "shell" }, [], null, NOW)).toEqual({ activity: "working", reason: "a shell in background" });
    // A version whose registry says only idle: the status line still tells.
    expect(claudeStatus({ status: "idle" }, [], footer("2 shells"), NOW)?.reason).toBe("2 shells in background");
    expect(claudeStatus({ status: "idle" }, [], footer("? for shortcuts"), NOW)).toEqual({ activity: "idle" });
  });

  test("only the status line counts, not words in the conversation", () => {
    expect(backgroundShells(["● I started 3 shells for the tests", "─".repeat(100), "❯", "  ⏸ manual mode on · ? for shortcuts"])).toBe(0);
    expect(backgroundShells(["  ⏵⏵ auto mode on · 1 shell · esc to interrupt · ↓ to manage", "", ""])).toBe(1);
  });
});

describe("what a waiting agent asks", () => {
  // As Claude Code 2.1.330 draws them, below the conversation.
  const rule = "─".repeat(110);
  const dashes = "╌".repeat(110);
  const permission = [
    "❯ Use the Bash tool to run exactly this command: touch /tmp/x . Do nothing else.",
    "● Creating empty test file at /tmp/x",
    "  ⎿  $ touch /tmp/x",
    rule,
    " Bash command",
    ' Tip: auto mode handles these prompts for you — choose "switch to auto mode" below',
    " Create empty test file at /tmp/x",
    dashes,
    " touch /tmp/x",
    dashes,
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and always allow access to /tmp from this project",
    "   3. Yes, and switch to auto mode · auto mode handles these prompts for you",
    "   4. No",
    " Esc to cancel · Tab to amend",
  ];

  test("a permission prompt: the tool, what it is for, the command, the question", () => {
    expect(dialogText("claude", permission)).toBe("Bash command · Create empty test file at /tmp/x · touch /tmp/x · Do you want to proceed?");
    // The registry says it waits; the screen says for what.
    expect(claudeStatus({ status: "waiting", waitingFor: "permission prompt" }, [], screen(permission), NOW)).toEqual({
      activity: "waiting",
      reason: "needs approval",
      detail: "Bash command · Create empty test file at /tmp/x · touch /tmp/x · Do you want to proceed?",
    });
  });

  test("the folder trust dialog, joined again where it wrapped its own lines", () => {
    const trust = [
      "bash-5.2$ claude",
      rule,
      " Accessing workspace:",
      " /tmp/work",
      " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open",
      " source project, or work from your team).",
      " Security guide",
      " ❯ No, exit",
      "   Yes, I trust this folder",
      " Enter to confirm · Esc to cancel",
    ];
    expect(dialogText("claude", trust)).toBe(
      "Accessing workspace: /tmp/work · Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team).",
    );
  });

  test("Codex's approval: its question and the command", () => {
    const lines = ["you: clean up", "Reason: stale files", "Would you like to run the following command?", "  $ rm -rf build", "› 1. Yes, proceed (y)", "  3. No (esc)"];
    expect(dialogText("codex", lines)).toBe("Would you like to run the following command? · $ rm -rf build");
  });

  test("a tall screen's blank lines below the dialog do not hide it", () => {
    expect(dialogText("claude", [...permission, ...Array.from({ length: 40 }, () => "")])).toContain("touch /tmp/x");
  });

  test("without options there is no dialog to read", () => {
    expect(dialogText("claude", ["● Done.", rule, "❯", rule])).toBeUndefined();
  });
});

describe("when a limit lifts", () => {
  // 20:05 in Los Angeles on Sunday 22 November 2026.
  const at = Date.parse("2026-11-22T20:05:00-08:00");

  test("Claude Code's clock time, in the zone it names, the next time that comes", () => {
    expect(limitResets("You've hit your 5-hour limit · resets 10:30pm (America/Los_Angeles)", at)).toBe(Date.parse("2026-11-22T22:30:00-08:00"));
    expect(limitResets("resets 7pm (America/Los_Angeles)", at)).toBe(Date.parse("2026-11-23T19:00:00-08:00"));
    expect(limitResets("resets 3am (Asia/Tokyo)", at)).toBe(Date.parse("2026-11-24T03:00:00+09:00"));
    // A date: this year, or the next once it has passed.
    expect(limitResets("You've hit your weekly limit · resets Nov 28, 9am (America/Los_Angeles)", at)).toBe(Date.parse("2026-11-28T09:00:00-08:00"));
    expect(limitResets("resets Jan 3, 9am (America/Los_Angeles)", at)).toBe(Date.parse("2027-01-03T09:00:00-08:00"));
    // Across the change to summer time.
    expect(limitResets("resets 10am (America/Los_Angeles)", Date.parse("2026-03-07T20:00:00-08:00"))).toBe(Date.parse("2026-03-08T10:00:00-07:00"));
  });

  test("Codex's: a while from when it was written, or a time on this machine's clock", () => {
    expect(limitResets("You've hit your usage limit. Try again in 2 hours 13 minutes.", at)).toBe(at + (2 * 60 + 13) * 60_000);
    expect(limitResets("try again in 3 days", at)).toBe(at + 3 * 86_400_000);
    const local = new Date(at);
    local.setHours(21, 15, 0, 0);
    if (local.getTime() < at - 60_000) local.setDate(local.getDate() + 1);
    expect(limitResets("You've hit your usage limit. Upgrade to Pro or try again at 9:15 PM.", at)).toBe(local.getTime());
  });

  test("words without a time say nothing", () => {
    expect(limitResets("resets 5 things", at)).toBeUndefined();
    expect(limitResets("You've hit your usage limit.", at)).toBeUndefined();
  });

  test("a plan's limit, which Claude Code reports as rate_limit, is a usage limit, and says when it lifts", () => {
    const line = {
      ...apiError("rate_limit", "You've hit your 5-hour limit · resets 10:30pm (America/Los_Angeles)"),
      timestamp: "2026-11-23T04:05:00.000Z",
    };
    expect(claudeStop([user("go"), line])).toEqual({
      reason: "usage limit",
      detail: "You've hit your 5-hour limit · resets 10:30pm (America/Los_Angeles)",
      resetsAt: Date.parse("2026-11-22T22:30:00-08:00"),
    });
  });
});

describe("the model, and the latest reply", () => {
  const part = (id: string, content: object, extra: object = {}) => ({
    type: "assistant",
    message: { id, role: "assistant", model: "claude-opus-5-5", content: [content] },
    ...extra,
  });
  const toolResult = { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } };

  test("Claude Code's model is its latest real reply's: its error messages name none", () => {
    const synthetic = { ...apiError("overloaded", "API Error"), message: { role: "assistant", model: "<synthetic>", content: [] } };
    expect(claudeModel([part("m1", { type: "text", text: "hi" }), synthetic])).toBe("claude-opus-5-5");
    expect(claudeModel([part("m1", { type: "text", text: "hi" }, { isSidechain: true })])).toBeUndefined();
    expect(codexModel([{ type: "turn_context", payload: { model: "gpt-5.5-codex" } }, { type: "event_msg", payload: {} }])).toBe("gpt-5.5-codex");
  });

  test("Claude Code's reply: the text of its latest message, which is several lines sharing an id", () => {
    const finished = [
      part("m0", { type: "text", text: "Looking." }),
      toolResult,
      part("m1", { type: "thinking", thinking: "…" }),
      part("m1", { type: "text", text: "All 54 kernels pass." }, { timestamp: "2026-11-23T04:00:00.000Z" }),
      part("m1", { type: "text", text: "See REPORT.md." }),
    ];
    expect(claudeReply(finished)).toEqual({ text: "All 54 kernels pass.\n\nSee REPORT.md.", at: Date.parse("2026-11-23T04:00:00.000Z") });
    // A turn still running: what it said last before its tool call.
    const running = [...finished, user("next"), part("m2", { type: "text", text: "Checking the runner." }), part("m2", { type: "tool_use", name: "Bash" }), toolResult];
    expect(claudeReply(running)?.text).toBe("Checking the runner.");
    expect(claudeReply([user("hi")])).toBeNull();
  });

  test("Codex's reply: its latest message, however it was recorded", () => {
    const message = (text: string) => ({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
    expect(codexReply([message("first"), { type: "event_msg", payload: { type: "agent_message", message: "second" } }])?.text).toBe("second");
    expect(codexReply([{ type: "event_msg", payload: { type: "agent_message", message: "second" } }, message("third")])?.text).toBe("third");
    expect(codexReply([{ type: "event_msg", payload: { type: "task_complete", last_agent_message: "done" } }])?.text).toBe("done");
    expect(codexReply([{ type: "session_meta", payload: {} }])).toBeNull();
  });
});
