// Copyright 2026 The workstreams Authors
// SPDX-License-Identifier: Apache-2.0
// Part of workstreams: https://github.com/YangXu1990uiuc/workstreams

import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import type { Paths } from "../src/common/paths.ts";
import {
  type ClientMessage,
  decodeOutputPayload,
  type ServerMessage,
  type SessionView,
  type Snapshot,
  type TabView,
} from "../src/common/protocol.ts";
import { type DaemonHandle, startDaemon } from "../src/daemon/daemon.ts";
import { type ServerHandle, startServer } from "../src/server/server.ts";
import { TEST_SHELL, tempPaths, until } from "./helpers.ts";

let paths: Paths;
let cleanup: () => void;
let daemon: DaemonHandle;
let server: ServerHandle;
let base: string;
let cookie: string;

async function launchServer(): Promise<void> {
  server = await startServer({ paths, host: "127.0.0.1", port: 0, log: () => {} });
  base = `http://127.0.0.1:${server.port}`;
}

beforeAll(async () => {
  ({ paths, cleanup } = tempPaths());
  daemon = await startDaemon({ paths, shellArgv: TEST_SHELL, log: () => {} });
  await launchServer();
});

afterAll(async () => {
  await server.stop();
  await daemon.stop();
  cleanup();
});

function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function cookieOf(response: Response): string {
  return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
}

/** A scripted browser tab that checks the output stream never has gaps. */
class Tab {
  readonly messages: ServerMessage[] = [];
  private readonly outputs = new Map<string, string>();
  private readonly offsets = new Map<string, number>();
  private readonly decoder = new TextDecoder();

  private constructor(private readonly ws: WebSocket) {
    ws.binaryType = "arraybuffer";
    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        const message = JSON.parse(event.data) as ServerMessage;
        if (message.t === "snapshot") {
          this.offsets.set(message.snapshot.session, message.snapshot.offset);
          this.outputs.set(message.snapshot.session, message.snapshot.data);
        }
        this.messages.push(message);
        return;
      }
      const { sessionId, offset, data } = decodeOutputPayload(new Uint8Array(event.data as ArrayBuffer));
      const expected = this.offsets.get(sessionId);
      if (offset !== expected) throw new Error(`gap in ${sessionId}: expected ${expected}, got ${offset}`);
      this.offsets.set(sessionId, offset + data.length);
      this.outputs.set(sessionId, (this.outputs.get(sessionId) ?? "") + this.decoder.decode(data));
    });
  }

  static open(origin = base): Promise<Tab> {
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws`, { headers: { origin, cookie } } as never);
    return new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve(new Tab(ws)));
      ws.addEventListener("error", () => reject(new Error("WebSocket failed")));
    });
  }

  send(message: ClientMessage): void {
    this.ws.send(JSON.stringify(message));
  }

  output(sessionId: string): string {
    return this.outputs.get(sessionId) ?? "";
  }

  async next<T extends ServerMessage>(predicate: (message: ServerMessage) => boolean): Promise<T> {
    let found: ServerMessage | undefined;
    await until(() => (found = this.messages.find(predicate)) !== undefined, "a server message");
    this.messages.splice(this.messages.indexOf(found!), 1);
    return found as T;
  }

  close(): void {
    this.ws.close();
  }
}

test("login requires the token and sets an HttpOnly cookie", async () => {
  expect((await fetch(`${base}/api/me`)).status).toBe(401);
  const post = (token: string, origin = base) =>
    fetch(`${base}/api/login`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
  expect((await post("wrong")).status).toBe(401);
  expect((await post(server.token!, "https://evil.example")).status).toBe(403);

  const ok = await post(server.token!);
  expect(ok.status).toBe(204);
  const setCookie = ok.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("SameSite=Strict");
  cookie = setCookie.split(";")[0]!;
  expect((await fetch(`${base}/api/me`, { headers: { cookie } })).status).toBe(200);
});

test("a cross-site page cannot open the WebSocket", async () => {
  await expect(Tab.open("https://evil.example")).rejects.toThrow();
});

test("two tabs mirror one session, a new tab restores it, banners sync", async () => {
  const a = await Tab.open();
  const b = await Tab.open();
  a.send({ t: "create", cols: 80, rows: 24 });
  const { session } = await a.next<{ t: "session"; session: SessionView }>((m) => m.t === "session");
  await b.next((m) => m.t === "session" && m.session.id === session.id);

  a.send({ t: "sub", session: session.id });
  b.send({ t: "sub", session: session.id });
  await a.next((m) => m.t === "snapshot");
  await b.next((m) => m.t === "snapshot");

  a.send({ t: "input", session: session.id, data: "echo hello-$((6*7))\r" });
  await until(
    () => a.output(session.id).includes("hello-42") && b.output(session.id).includes("hello-42"),
    "both tabs to see the output",
  );

  b.close();
  const c = await Tab.open();
  c.send({ t: "sub", session: session.id });
  const { snapshot } = await c.next<{ t: "snapshot"; snapshot: Snapshot }>((m) => m.t === "snapshot");
  expect(snapshot.data).toContain("hello-42");
  expect([snapshot.cols, snapshot.rows]).toEqual([80, 24]);

  a.send({ t: "banner", session: session.id, banner: "auth refactor" });
  await c.next((m) => m.t === "session" && m.session.banner === "auth refactor");

  a.close();
  c.close();
}, 20_000);

test("sessions survive a server restart", async () => {
  const before = await Tab.open();
  before.send({ t: "create", cols: 100, rows: 30, cmd: "echo survivor-$((40+2))" });
  const { session } = await before.next<{ t: "session"; session: SessionView }>((m) => m.t === "session");
  before.send({ t: "sub", session: session.id });
  await until(() => before.output(session.id).includes("survivor-42"), "the startup command");
  before.close();

  await server.stop();
  await launchServer();

  const after = await Tab.open();
  const { sessions } = await after.next<{ t: "sessions"; sessions: SessionView[] }>(
    (m) => m.t === "sessions" && m.sessions.some((s) => s.id === session.id),
  );
  expect(sessions.find((s) => s.id === session.id)?.exited).toBeNull();
  after.send({ t: "sub", session: session.id });
  const { snapshot } = await after.next<{ t: "snapshot"; snapshot: Snapshot }>((m) => m.t === "snapshot");
  expect(snapshot.data).toContain("survivor-42");

  after.send({ t: "close", session: session.id });
  await after.next((m) => m.t === "removed" && m.session === session.id);
  after.close();
}, 30_000);

test("health names the owner's uid so `up` can tell instances apart", async () => {
  const health = (await (await fetch(`${base}/api/health`)).json()) as { ok: boolean; uid: number };
  expect(health.ok).toBe(true);
  expect(health.uid).toBe(process.getuid!());
  const info = (await (await fetch(`${base}/api/login-info`)).json()) as { user: string; passwordSet: boolean };
  expect(info.user).toBe(userInfo().username);
  expect(info.passwordSet).toBe(false);
});

test("tabs: a session created in a tab lands there; moving; deleting a tab moves its sessions", async () => {
  const tab = await Tab.open();
  const { tabs } = await tab.next<{ t: "tabs"; tabs: TabView[] }>((m) => m.t === "tabs");
  const main = tabs[0]!.id;
  const agents = "cafe0001";
  tab.send({ t: "tab-create", id: agents, name: "agents", color: "#2ea043", grid: "2x3" });
  const created = await tab.next<{ t: "tabs"; tabs: TabView[] }>(
    (m) => m.t === "tabs" && m.tabs.some((t) => t.id === agents),
  );
  expect(created.tabs.find((t) => t.id === agents)).toEqual({
    id: agents,
    name: "agents",
    color: "#2ea043",
    grid: "2x3",
  });

  tab.send({ t: "create", cols: 80, rows: 24, tab: agents });
  const { session } = await tab.next<{ t: "session"; session: SessionView }>((m) => m.t === "session");
  expect(session.tab).toBe(agents); // the very first broadcast already has the tab

  tab.send({ t: "session-move", session: session.id, tab: main });
  await tab.next((m) => m.t === "session" && m.session.id === session.id && m.session.tab === main);
  tab.send({ t: "session-move", session: session.id, tab: agents });
  await tab.next((m) => m.t === "session" && m.session.id === session.id && m.session.tab === agents);

  tab.send({ t: "tab-delete", id: agents });
  await tab.next((m) => m.t === "tabs" && !m.tabs.some((t) => t.id === agents));
  await tab.next((m) => m.t === "session" && m.session.id === session.id && m.session.tab === main);

  tab.send({ t: "tab-delete", id: main });
  await tab.next((m) => m.t === "error"); // the last tab stays

  tab.send({ t: "close", session: session.id });
  await tab.next((m) => m.t === "removed" && m.session === session.id);
  tab.close();
}, 20_000);

test("password: set it, sign in with it, sign out; other logins end", async () => {
  expect((await post("/api/password", { password: "correct horse" })).status).toBe(401);
  expect((await post("/api/password", { password: "short" }, { cookie })).status).toBe(400);
  const set = await post("/api/password", { password: "correct horse" }, { cookie });
  expect(set.status).toBe(204);
  const fresh = cookieOf(set);
  expect((await fetch(`${base}/api/me`, { headers: { cookie } })).status).toBe(401);
  expect((await fetch(`${base}/api/me`, { headers: { cookie: fresh } })).status).toBe(200);

  expect((await post("/api/login", { password: "wrong horse" })).status).toBe(401);
  const login = await post("/api/login", { password: "correct horse" });
  expect(login.status).toBe(204);
  cookie = cookieOf(login);
  expect(cookie).toBe(fresh);
  const info = (await (await fetch(`${base}/api/login-info`)).json()) as { passwordSet: boolean };
  expect(info.passwordSet).toBe(true);

  const logout = await post("/api/logout", {}, { cookie });
  expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
});

test("password guessing locks out after five failures; the token still works", async () => {
  for (let i = 0; i < 5; i++) {
    expect((await post("/api/login", { password: `guess-${i}-xxxxx` })).status).toBe(401);
  }
  const locked = await post("/api/login", { password: "correct horse" });
  expect(locked.status).toBe(429);
  expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
  expect((await post("/api/login", { token: server.token })).status).toBe(204);
});

test("if the token file goes missing, nothing signs in (no empty-token fallback)", async () => {
  const token = readFileSync(paths.tokenFile, "utf8");
  const hash = existsSync(paths.passwordFile) ? readFileSync(paths.passwordFile, "utf8").trim() : "";
  const emptyKeyCookie = createHmac("sha256", "").update(`workstreams-cookie-v2\0${hash}`).digest("base64url");
  const name = cookie.split("=")[0]!;
  rmSync(paths.tokenFile);
  try {
    expect((await post("/api/login", { token: "" })).status).toBe(401);
    expect((await fetch(`${base}/api/me`, { headers: { cookie: `${name}=${emptyKeyCookie}` } })).status).toBe(401);
    expect((await fetch(`${base}/api/me`, { headers: { cookie } })).status).toBe(401);
  } finally {
    writeFileSync(paths.tokenFile, token, { mode: 0o600 });
  }
  expect((await fetch(`${base}/api/me`, { headers: { cookie } })).status).toBe(200);
});
