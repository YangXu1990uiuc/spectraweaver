// Copyright 2026 The workstreams Authors
// SPDX-License-Identifier: Apache-2.0
// Part of workstreams: https://github.com/YangXu1990uiuc/workstreams

import { expect, test } from "bun:test";
import { pickFreePort, portIsFree } from "../src/common/net.ts";

test("picks the next free port when the first is taken (another user's instance)", () => {
  const first = pickFreePort("127.0.0.1", 42000, 200);
  expect(first).not.toBeNull();
  const occupied = Bun.listen({ hostname: "127.0.0.1", port: first!, socket: { data() {} } });
  try {
    expect(portIsFree("127.0.0.1", first!)).toBe(false);
    const next = pickFreePort("127.0.0.1", first!, 200);
    expect(next).not.toBeNull();
    expect(next).not.toBe(first);
    expect(next!).toBeGreaterThan(first!);
  } finally {
    occupied.stop(true);
  }
  expect(portIsFree("127.0.0.1", first!)).toBe(true);
});
