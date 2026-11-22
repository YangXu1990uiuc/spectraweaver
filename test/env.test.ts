// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { expect, test } from "bun:test";
import { sessionEnv } from "../src/common/env.ts";

test("sessions lose the starting terminal's identity but keep the user's configuration", () => {
  const env = sessionEnv(
    { HOME: "/home/me", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CONFIG_DIR: "/home/me/.claude-work", TMUX: "x" },
    "s1",
  );
  expect(env.CLAUDECODE).toBeUndefined();
  expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
  expect(env.TMUX).toBeUndefined();
  expect(env.CLAUDE_CONFIG_DIR).toBe("/home/me/.claude-work");
  expect(env).toMatchObject({ HOME: "/home/me", SPECTRAWEAVER_SESSION_ID: "s1", TERM: "xterm-256color" });
});

test("what says which SpectraWeaver and which model provider is configuration, and stays", () => {
  const env = sessionEnv(
    {
      SPECTRAWEAVER_HOME: "/work/sw",
      SPECTRAWEAVER_STATE_DIR: "/local/sw",
      SPECTRAWEAVER_SESSION_ID: "outer",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_SESSION_ID: "abc",
      CLAUDE_PID: "42",
    },
    "s2",
  );
  expect(env).toMatchObject({ SPECTRAWEAVER_HOME: "/work/sw", SPECTRAWEAVER_STATE_DIR: "/local/sw", CLAUDE_CODE_USE_BEDROCK: "1" });
  expect(env.SPECTRAWEAVER_SESSION_ID).toBe("s2");
  expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
  expect(env.CLAUDE_PID).toBeUndefined();
});
