// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Paths } from "../src/common/paths.ts";
import {
  type ClientMessage,
  decodeOutputPayload,
  MAX_UPLOAD_BYTES,
  type ServerMessage,
  type SessionView,
  type Snapshot,
  type TabView,
} from "../src/common/protocol.ts";
import { type DaemonHandle, startDaemon } from "../src/daemon/daemon.ts";
import { processCwd } from "../src/server/foreground.ts";
import { type ServerHandle, startServer } from "../src/server/server.ts";
import { uploadDir } from "../src/server/uploads.ts";
import { TEST_SHELL, tempPaths, until } from "./helpers.ts";

let paths: Paths;
let cleanup: () => void;
let daemon: DaemonHandle;
let server: ServerHandle;
let base: string;
let cookie: string;
/** Where the server writes uploads: inside the test's own directory, not the real one in /tmp. */
let uploads: string;

async function launchServer(): Promise<void> {
  uploads = uploadDir(dirname(paths.configDir));
  server = await startServer({ paths, host: "127.0.0.1", port: 0, log: () => {}, uploadDir: uploads });
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

  sendRaw(text: string): void {
    this.ws.send(text);
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

test("resizing from one tab: every tab learns the size and gets a fresh screen, and the program sees it", async () => {
  const a = await Tab.open();
  const b = await Tab.open();
  const daemonMessage = await a.next<{ t: "daemon"; up: boolean; features?: string[] }>((m) => m.t === "daemon");
  expect(daemonMessage.up).toBe(true);
  expect(daemonMessage.features).toContain("resize");
  a.send({ t: "create", cols: 80, rows: 24 });
  const { session } = await a.next<{ t: "session"; session: SessionView }>((m) => m.t === "session");
  await b.next((m) => m.t === "session" && m.session.id === session.id);
  a.send({ t: "sub", session: session.id });
  b.send({ t: "sub", session: session.id });
  await a.next((m) => m.t === "snapshot");
  await b.next((m) => m.t === "snapshot");
  a.send({ t: "input", session: session.id, data: "stty size\r" });
  await until(() => a.output(session.id).includes("24 80") && b.output(session.id).includes("24 80"), "the size before");

  a.send({ t: "resize", session: session.id, cols: 132, rows: 40 });
  for (const tab of [a, b]) {
    await tab.next((m) => m.t === "session" && m.session.id === session.id && m.session.cols === 132 && m.session.rows === 40);
    const { snapshot } = await tab.next<{ t: "snapshot"; snapshot: Snapshot }>((m) => m.t === "snapshot");
    expect([snapshot.cols, snapshot.rows]).toEqual([132, 40]);
  }
  // The stream after each snapshot continues without a gap (Tab throws on one), and the
  // program was told about the new size.
  a.send({ t: "input", session: session.id, data: "stty size\r" });
  await until(() => a.output(session.id).includes("40 132") && b.output(session.id).includes("40 132"), "the size after");

  a.send({ t: "close", session: session.id });
  await a.next((m) => m.t === "removed" && m.session === session.id);
  a.close();
  b.close();
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

test("windows: a frame placed from one tab reaches every tab, a bad one is ignored, a move to another tab drops it", async () => {
  const a = await Tab.open();
  const b = await Tab.open();
  await a.next<{ t: "tabs"; tabs: TabView[] }>((m) => m.t === "tabs");
  a.send({ t: "create", cols: 80, rows: 24 });
  const { session } = await a.next<{ t: "session"; session: SessionView }>((m) => m.t === "session");
  expect(session.frame).toBeUndefined();
  await b.next((m) => m.t === "session" && m.session.id === session.id);

  a.send({ t: "session-frame", session: session.id, frame: { x: 0.5, y: "top", w: 0.5, h: 0.5, z: 1 } as never });
  a.send({ t: "session-frame", session: session.id, frame: { x: 0.5, y: 0.00004, w: 0.5, h: 0.5, z: 7 } });
  for (const tab of [a, b]) {
    const placed = await tab.next<{ t: "session"; session: SessionView }>((m) => m.t === "session" && m.session.id === session.id);
    expect(placed.session.frame).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5, z: 7 }); // the bad frame caused no broadcast
  }

  const other = "abcdef01";
  a.send({ t: "tab-create", id: other, name: "other", color: "#2ea043", grid: "2x2" });
  await b.next((m) => m.t === "tabs" && m.tabs.some((t) => t.id === other));

  a.send({ t: "session-move", session: session.id, tab: other });
  const moved = await b.next<{ t: "session"; session: SessionView }>((m) => m.t === "session" && m.session.tab === other);
  expect(moved.session.frame).toBeUndefined();

  a.send({ t: "tab-delete", id: other });
  await a.next((m) => m.t === "tabs" && !m.tabs.some((t) => t.id === other));
  a.send({ t: "close", session: session.id });
  await a.next((m) => m.t === "removed" && m.session === session.id);
  a.close();
  b.close();
});

test("a browser's malformed messages are ignored, not fatal", async () => {
  const tab = await Tab.open();
  for (const text of ["null", "5", '"x"', "[]", '{"t":"banner"}', '{"t":"session-frame","session":{},"frame":null}', "{not json"]) {
    tab.sendRaw(text);
  }
  tab.send({ t: "tab-create", id: "cafecafe", name: "still here", color: "#2ea043", grid: "2x2" });
  await tab.next((message) => message.t === "tabs" && message.tabs.some((candidate) => candidate.name === "still here"));
  tab.send({ t: "tab-delete", id: "cafecafe" });
  tab.close();
});

test("health names the owner's uid so `up` can tell instances apart", async () => {
  const health = (await (await fetch(`${base}/api/health`)).json()) as { ok: boolean; uid: number; pid: number };
  expect(health.ok).toBe(true);
  expect(health.uid).toBe(process.getuid!());
  expect(health.pid).toBe(process.pid);
  // A page on another name (DNS rebinding) cannot read who runs it.
  expect((await fetch(`${base}/api/login-info`, { headers: { host: "evil.example:80" } })).status).toBe(403);
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

test("password guessing locks out after five failures, even guesses sent at once; the token still works", async () => {
  // All at once: only five get checked before the lock.
  const guesses = await Promise.all(Array.from({ length: 20 }, (_, i) => post("/api/login", { password: `guess-${i}-xxxxx` })));
  const statuses = guesses.map((response) => response.status);
  expect(statuses.filter((status) => status === 401)).toHaveLength(5);
  expect(statuses.filter((status) => status === 429)).toHaveLength(15);
  const locked = await post("/api/login", { password: "correct horse" });
  expect(locked.status).toBe(429);
  expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
  expect((await post("/api/login", { token: server.token })).status).toBe(204);
});

test("if the token file goes missing, nothing signs in (no empty-token fallback)", async () => {
  const token = readFileSync(paths.tokenFile, "utf8");
  const hash = existsSync(paths.passwordFile) ? readFileSync(paths.passwordFile, "utf8").trim() : "";
  const emptyKeyCookie = createHmac("sha256", "").update(`spectraweaver-cookie-v2\0${hash}`).digest("base64url");
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

test("a new terminal can start in the current directory of another one", async () => {
  const tab = await Tab.open();
  await tab.next((m) => m.t === "sessions");
  tab.send({ t: "create", cols: 80, rows: 24 });
  const { session: first } = await tab.next<{ t: "session"; session: SessionView }>((m) => m.t === "session");
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sw-cwd-")));
  tab.send({ t: "input", session: first.id, data: `cd ${dir}\r` });
  await until(() => processCwd(first.pid) === dir, "the shell to change directory");

  tab.send({ t: "create", cols: 80, rows: 24, cwdOf: first.id });
  const { session: second } = await tab.next<{ t: "session"; session: SessionView }>(
    (m) => m.t === "session" && m.session.id !== first.id,
  );
  expect(second.cwd).toBe(dir);
  await until(() => processCwd(second.pid) === dir, "the new shell to start there");

  for (const session of [first, second]) {
    tab.send({ t: "close", session: session.id });
    await tab.next((m) => m.t === "removed" && m.session === session.id);
  }
  tab.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a file dropped or pasted in a browser is written where the terminals run, for this user only", async () => {
  const upload = (body: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/upload`, {
      method: "POST",
      headers: { origin: base, cookie, "content-type": "image/png", "x-file-name": encodeURIComponent("Screen shot 1.png"), ...headers },
      body,
    });
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  expect((await upload(png, { cookie: "" })).status).toBe(401);
  expect((await upload(png, { origin: "https://evil.example" })).status).toBe(403);
  expect((await upload(new Uint8Array(0))).status).toBe(400);
  expect((await upload(new Uint8Array(MAX_UPLOAD_BYTES + 1))).status).toBe(413);

  const response = await upload(png);
  expect(response.status).toBe(200);
  const { path } = (await response.json()) as { path: string };
  expect(dirname(path)).toBe(uploads);
  // Named so a command line takes it as it is: the time, the name made safe, random letters.
  expect(basename(path)).toMatch(/^\d{8}-\d{6}-Screen-shot-1-[0-9a-f]{6}\.png$/);
  expect(new Uint8Array(readFileSync(path))).toEqual(png);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(uploads).mode & 0o777).toBe(0o700);
  // A pasted screenshot may have no name, or one of letters a command line would mangle.
  const unnamed = (await (await upload(png, { "x-file-name": "", "content-type": "image/jpeg" })).json()) as { path: string };
  expect(basename(unnamed.path)).toMatch(/-upload-[0-9a-f]{6}\.jpg$/);
  const chinese = (await (await upload(png, { "x-file-name": encodeURIComponent("截图 (2).png") })).json()) as { path: string };
  expect(basename(chinese.path)).toMatch(/-2-[0-9a-f]{6}\.png$/);
});
