// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { boundHostAllowlist, Credentials, hostnameOf, machineNames, RequestGuard } from "../src/server/auth.ts";

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

test("beyond loopback, the machine's own names and addresses are allowed as Host", () => {
  const machine = { names: ["devbox", "devbox.local"], addresses: ["10.1.2.3", "[fd00::1]"] };
  expect(boundHostAllowlist("127.0.0.1", machine)).toEqual([]);
  expect(boundHostAllowlist("10.1.2.3", machine)).toEqual(["devbox", "devbox.local", "10.1.2.3"]);
  expect(boundHostAllowlist("fd00::1", machine)).toEqual(["devbox", "devbox.local", "[fd00::1]"]);
  expect(boundHostAllowlist("0.0.0.0", machine)).toEqual(["devbox", "devbox.local", "10.1.2.3", "[fd00::1]"]);

  const guard = new RequestGuard(boundHostAllowlist("0.0.0.0", machine));
  expect(guard.check(request({ host: "devbox:7777", origin: "http://devbox:7777" }), true)).toBe(true);
  expect(guard.check(request({ host: "10.1.2.3:7777", origin: "http://10.1.2.3:7777" }), true)).toBe(true);
  // DNS rebinding still fails: the attacker's page arrives with its own host name.
  expect(guard.check(request({ host: "evil.example:7777", origin: "http://evil.example:7777" }), true)).toBe(false);
});

test("the machine's names include its host name and a .local name", () => {
  const { names } = machineNames();
  expect(names[0]).toBe(hostname().toLowerCase());
  expect(names.some((name) => name.endsWith(".local"))).toBe(true);
});

test("credentials fail closed when the token file disappears or is truncated", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-auth-"));
  try {
    const tokenFile = join(dir, "auth.token");
    const credentials = new Credentials(tokenFile, join(dir, "password"));
    expect(credentials.token()).toHaveLength(32);
    expect(credentials.cookieValue()).not.toBeNull();
    rmSync(tokenFile);
    expect(credentials.token()).toBeNull();
    expect(credentials.cookieValue()).toBeNull();
    writeFileSync(tokenFile, "short\n");
    expect(credentials.token()).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
