// Copyright 2026 The workstreams Authors
// SPDX-License-Identifier: Apache-2.0
// Part of workstreams: https://github.com/YangXu1990uiuc/workstreams

import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Paths } from "../src/common/paths.ts";
import {
  type ClientMessage,
  decodeOutputPayload,
  type ServerMessage,
  type SessionView,
  type Snapshot,
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
  expect((await post(server.token, "https://evil.example")).status).toBe(403);

  const ok = await post(server.token);
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
