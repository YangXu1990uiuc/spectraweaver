// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { expect, test } from "bun:test";
import { asksForHelp, duration, elapsed, flag, parseFlags } from "../src/cli-args.ts";

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

test("a while, briefly, and a duration as given", () => {
  expect(elapsed(45_000)).toBe("45s");
  expect(elapsed(12 * 60_000)).toBe("12m");
  expect(elapsed((6 * 60 + 50) * 60_000)).toBe("6h50m");
  expect(elapsed(3 * 3_600_000)).toBe("3h");
  expect(elapsed((2 * 24 + 3) * 3_600_000)).toBe("2d3h");
  expect(duration("90s", "--timeout")).toBe(90_000);
  expect(duration("30m", "--timeout")).toBe(1_800_000);
  expect(duration("2h", "--timeout")).toBe(7_200_000);
  expect(duration("1d", "--since")).toBe(86_400_000);
  expect(duration("45", "--timeout")).toBe(45_000);
});
