// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { expect, test } from "bun:test";
import { asksForHelp, flag, parseFlags } from "../src/cli-args.ts";

test("options take their value after a space or the first =, and -- ends them", () => {
  const flags = parseFlags(["--banner=a=b", "--size", "80x24", "--json", "word", "--", "--not-an-option"], ["banner", "size", "json"]);
  expect(flag(flags, "banner")).toBe("a=b");
  expect(flag(flags, "size")).toBe("80x24");
  expect(flag(flags, "json")).toBe("true");
  expect(flags.rest).toEqual(["word", "--not-an-option"]);
  expect(flag(parseFlags(["--cwd=/a=b/c"], ["cwd"]), "cwd")).toBe("/a=b/c");
});

test("-h and --help ask for help, unless they come after --", () => {
  expect(asksForHelp(["-h"])).toBe(true);
  expect(asksForHelp(["--all", "--help"])).toBe(true);
  expect(asksForHelp(["ID", "--", "-h"])).toBe(false);
  expect(asksForHelp(["ID", "say -h please"])).toBe(false);
});
