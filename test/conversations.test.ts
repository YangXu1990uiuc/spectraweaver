// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentDirs, Conversations } from "../src/server/conversations.ts";

const root = mkdtempSync(join(tmpdir(), "sw-conv-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ids = {
  titled: "11111111-1111-4111-8111-111111111111",
  prompted: "22222222-2222-4222-8222-222222222222",
  print: "33333333-3333-4333-8333-333333333333",
  codex: "019a0000-0000-7000-8000-000000000004",
  exec: "019a0000-0000-7000-8000-000000000005",
};
const lines = (...values: object[]) => values.map((value) => `${JSON.stringify(value)}\n`).join("");

function file(path: string, contents: string, minutesAgo: number): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
  const at = new Date(Date.now() - minutesAgo * 60_000);
  utimesSync(path, at, at);
}

const claude = join(root, "claude", "projects", "-work-repo");
const codex = join(root, "codex", "sessions", "2026", "11", "20");
// Claude Code, as 2.1 writes it: metadata lines without a directory first; a title and the last
// prompt as lines of their own, rewritten as the conversation goes on.
file(
  join(claude, `${ids.titled}.jsonl`),
  lines(
    { type: "session-owner", sessionId: ids.titled },
    { type: "user", cwd: "/work/repo", sessionId: ids.titled, entrypoint: "cli", message: { content: "fix it" } },
    { type: "ai-title", aiTitle: "Old title", sessionId: ids.titled },
    { type: "ai-title", aiTitle: "Fix the login bug", sessionId: ids.titled },
    { type: "last-prompt", lastPrompt: "and add a test", sessionId: ids.titled },
  ),
  5,
);
// An older format: only the messages.
file(
  join(claude, `${ids.prompted}.jsonl`),
  lines(
    { type: "user", cwd: "/work/repo", sessionId: ids.prompted, message: { content: "<command-name>/clear</command-name>" } },
    { type: "user", cwd: "/work/repo", sessionId: ids.prompted, message: { content: "rename the module" } },
  ),
  60,
);
// `claude -p`, and a subagent's transcript: not conversations to resume.
file(join(claude, `${ids.print}.jsonl`), lines({ type: "user", cwd: "/work/repo", entrypoint: "sdk-cli", message: { content: "x" } }), 1);
file(join(claude, ids.titled, "subagents", "agent-abc.jsonl"), lines({ type: "user", cwd: "/work/repo" }), 1);
// Codex: the first line is the session's metadata.
file(
  join(codex, `rollout-2026-11-20T10-00-00-${ids.codex}.jsonl`),
  lines(
    { type: "session_meta", payload: { id: ids.codex, cwd: "/work/other", source: "cli" } },
    { type: "event_msg", payload: { type: "user_message", message: "<environment_context>…</environment_context>" } },
    { type: "event_msg", payload: { type: "user_message", message: "speed up the build" } },
  ),
  30,
);
file(
  join(codex, `rollout-2026-11-20T09-00-00-${ids.exec}.jsonl`),
  lines({ type: "session_meta", payload: { id: ids.exec, cwd: "/work/other", source: "exec" } }),
  2,
);
// Three weeks old.
file(join(claude, "44444444-4444-4444-8444-444444444444.jsonl"), lines({ type: "user", cwd: "/work/repo" }), 21 * 24 * 60);

const conversations = new Conversations({ claude: join(root, "claude"), codex: join(root, "codex") });

test("recent conversations a person started, newest first, labelled by title or last prompt", () => {
  const found = conversations.recent(Date.now() - 14 * 24 * 3600_000, 10);
  expect(found.map(({ agent, id, cwd, label }) => ({ agent, id, cwd, label }))).toEqual([
    { agent: "claude", id: ids.titled, cwd: "/work/repo", label: "Fix the login bug" },
    { agent: "codex", id: ids.codex, cwd: "/work/other", label: "speed up the build" },
    { agent: "claude", id: ids.prompted, cwd: "/work/repo", label: "rename the module" },
  ]);
  expect(conversations.recent(Date.now() - 14 * 24 * 3600_000, 1)).toHaveLength(1);
});

test("a conversation is found by id, with its directory", () => {
  const found = conversations.find("codex", ids.codex.toUpperCase());
  expect(found?.path).toContain(ids.codex);
  expect(conversations.cwdOf(found!)).toBe("/work/other");
  expect(conversations.find("claude", ids.codex)).toBeUndefined();
});

test("the agents' directories come from the environment, or the home directory", () => {
  expect(agentDirs({ CLAUDE_CONFIG_DIR: "/c", CODEX_HOME: "/x" })).toEqual({ claude: "/c", codex: "/x" });
  expect(agentDirs({}).claude).toMatch(/\.claude$/);
});
