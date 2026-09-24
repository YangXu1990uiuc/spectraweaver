// Copyright 2026 The workstreams Authors
// SPDX-License-Identifier: Apache-2.0
// Part of workstreams: https://github.com/YangXu1990uiuc/workstreams

import { expect, test } from "bun:test";
import { hostnameOf, RequestGuard } from "../src/server/auth.ts";

function request(headers: Record<string, string>): Request {
  return new Request("http://127.0.0.1:7777/ws", { headers });
}

test("hostnameOf strips ports, including for IPv6", () => {
  expect(hostnameOf("localhost:7777")).toBe("localhost");
  expect(hostnameOf("[::1]:7777")).toBe("[::1]");
  expect(hostnameOf("Box.Example.ts.net")).toBe("box.example.ts.net");
});

test("same-origin loopback requests pass on any port", () => {
  const guard = new RequestGuard();
  expect(guard.check(request({ host: "localhost:7777", origin: "http://localhost:7777" }), true)).toBe(true);
  // SSH or VS Code port forwarding often remaps the port.
  expect(guard.check(request({ host: "127.0.0.1:9123", origin: "http://127.0.0.1:9123" }), true)).toBe(true);
});

test("cross-site requests are rejected (WebSocket hijacking)", () => {
  const guard = new RequestGuard();
  expect(guard.check(request({ host: "localhost:7777", origin: "https://evil.example" }), true)).toBe(false);
  expect(guard.check(request({ host: "localhost:7777", origin: "http://localhost:9999" }), true)).toBe(false);
  expect(guard.check(request({ host: "localhost:7777" }), true)).toBe(false);
});

test("unknown Host headers are rejected (DNS rebinding) unless allowed", () => {
  const rebinding = request({ host: "evil.example:7777", origin: "http://evil.example:7777" });
  expect(new RequestGuard().check(rebinding, true)).toBe(false);
  expect(new RequestGuard(["evil.example"]).check(rebinding, true)).toBe(true);
});
