// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { expect, test } from "bun:test";
import { AGENTS, carriedFlags, detectAgent, programIndex, resumeCommand } from "../src/server/agents.ts";

const claude = AGENTS.find((agent) => agent.name === "claude")!;
const codex = AGENTS.find((agent) => agent.name === "codex")!;

test("agents are recognised however they were installed, and nothing else is", () => {
  expect(detectAgent(["claude", "--model", "opus"])?.name).toBe("claude");
  expect(detectAgent(["/home/me/.local/bin/claude"])?.name).toBe("claude");
  expect(detectAgent(["node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"])?.name).toBe("claude");
  expect(detectAgent(["codex", "--yolo"])?.name).toBe("codex");
  expect(detectAgent(["node", "/usr/lib/node_modules/@openai/codex/bin/codex.js", "resume", "x"])?.name).toBe("codex");
  expect(programIndex(["node", "/x/cli.js", "-c"])).toBe(1);

  expect(detectAgent(["vim", "claude"])).toBeNull(); // an argument, not the program
  expect(detectAgent(["bash"])).toBeNull();
  expect(detectAgent([])).toBeNull();
});

test("resuming keeps the flags that matter and drops prompts and old resume options", () => {
  expect(
    carriedFlags(claude, ["--dangerously-skip-permissions", "--model", "opus", "fix the login bug"]),
  ).toEqual(["--dangerously-skip-permissions", "--model", "opus"]);
  expect(carriedFlags(claude, ["--resume", "old-id", "--permission-mode=plan", "--add-dir", "a", "b", "--verbose"])).toEqual([
    "--permission-mode=plan",
    "--add-dir",
    "a",
    "b",
  ]);
  expect(carriedFlags(codex, ["resume", "old-id", "--yolo", "-m", "gpt-5", "-c", "model_reasoning_effort=high"])).toEqual([
    "--yolo",
    "-m",
    "gpt-5",
    "-c",
    "model_reasoning_effort=high",
  ]);
});

test("the resume command is the documented one plus the kept flags, quoted for the shell", () => {
  const id = "3f2a9c1e-0b7d-4e1a-9c2f-5d6e7f8a9b0c";
  expect(resumeCommand(claude, id, ["--model", "opus"])).toBe(`claude --resume ${id} --model opus`);
  expect(resumeCommand(codex, id, ["--add-dir", "/my dir"])).toBe(`codex resume ${id} --add-dir '/my dir'`);
  // Without a known conversation, the latest one in the directory.
  expect(resumeCommand(claude, null, [])).toBe("claude --continue");
  expect(resumeCommand(codex, null, ["--yolo"])).toBe("codex resume --last --yolo");
});

test("a conversation named on the command line is recognised", () => {
  const id = "3f2a9c1e-0b7d-4e1a-9c2f-5d6e7f8a9b0c";
  expect(claude.conversationInArgs(["--model", "opus", "--resume", id])).toBe(id);
  expect(claude.conversationInArgs([`--resume=${id}`])).toBe(id);
  expect(claude.conversationInArgs(["-r", id])).toBe(id);
  expect(claude.conversationInArgs(["--session-id", id])).toBe(id);
  expect(claude.conversationInArgs(["--resume", id, "--fork-session"])).toBeNull(); // a new id
  expect(claude.conversationInArgs(["--resume", "auth refactor"])).toBeNull();
  expect(claude.conversationInArgs(["fix the bug"])).toBeNull();
  expect(codex.conversationInArgs(["--yolo", "resume", id])).toBe(id);
  expect(codex.conversationInArgs(["resume", "--last"])).toBeNull();
  expect(codex.conversationInArgs([id])).toBeNull(); // a prompt, not a resume
});
