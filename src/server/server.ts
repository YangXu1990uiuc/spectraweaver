// Copyright 2026 The workstreams Authors
// SPDX-License-Identifier: Apache-2.0
// Part of workstreams: https://github.com/YangXu1990uiuc/workstreams

import type { ServerWebSocket } from "bun";
import { randomBytes } from "node:crypto";
import { ensurePrivateDir, type Paths } from "../common/paths.ts";
import type {
  ClientMessage,
  DaemonEvent,
  ServerMessage,
  SessionInfo,
  SessionView,
  Snapshot,
} from "../common/protocol.ts";
import { VERSION } from "../common/version.ts";
import indexPage from "../web/index.html";
import {
  COOKIE_NAME,
  deriveCookieValue,
  loadOrCreateToken,
  readCookie,
  RequestGuard,
  safeEqual,
} from "./auth.ts";
import { DaemonClient } from "./daemon-client.ts";
import { MetaStore } from "./meta.ts";

export interface ServerOptions {
  paths: Paths;
  host: string;
  port: number;
  /** Extra hostnames browsers may use to reach the server (e.g. a Tailscale name). */
  allowHosts?: string[];
  development?: boolean;
  log?: (message: string) => void;
}

export interface ServerHandle {
  readonly port: number;
  readonly token: string;
  stop(): Promise<void>;
}

interface ClientData {
  id: string;
  /** Sessions this browser wants to watch, whether or not its snapshot has arrived yet. */
  subs: Set<string>;
}

type Client = ServerWebSocket<ClientData>;

/** Per-session fan-out: browsers that have received a snapshot get every later frame. */
interface Fan {
  active: Set<Client>;
  subscribed: boolean;
}

// A browser that cannot keep up is disconnected; it reconnects and gets fresh snapshots.
const MAX_CLIENT_BACKLOG = 32 * 1024 * 1024;

export async function startServer(options: ServerOptions): Promise<ServerHandle> {
  const log = options.log ?? ((message: string) => console.error(`[server] ${message}`));
  ensurePrivateDir(options.paths.stateDir);
  const token = loadOrCreateToken(options.paths.tokenFile);
  const cookieValue = deriveCookieValue(token);
  const guard = new RequestGuard(options.allowHosts);
  const meta = new MetaStore(options.paths.metaFile);
  const sessions = new Map<string, SessionInfo>();
  const clients = new Set<Client>();
  const fans = new Map<string, Fan>();

  const view = (session: SessionInfo): SessionView => ({ ...session, banner: meta.banner(session.id) });

  const send = (client: Client, data: string | Uint8Array) => {
    client.send(data);
    if (client.getBufferedAmount() > MAX_CLIENT_BACKLOG) client.close(1013, "client too slow");
  };
  const sendJson = (client: Client, message: ServerMessage) => send(client, JSON.stringify(message));
  const broadcast = (message: ServerMessage) => {
    const text = JSON.stringify(message);
    for (const client of clients) send(client, text);
  };
  const broadcastSession = (id: string) => {
    const session = sessions.get(id);
    if (session) broadcast({ t: "session", session: view(session) });
  };

  const daemon = new DaemonClient(
    options.paths.daemonSocket,
    {
      onConnected: (hello) => {
        log(`connected to daemon ${hello.version} (pid ${hello.pid})`);
        daemon
          .call<SessionInfo[]>({ op: "list" })
          .then((list) => {
            sessions.clear();
            for (const session of list) sessions.set(session.id, session);
            meta.prune(new Set(sessions.keys()));
            broadcast({ t: "daemon", up: true });
            broadcast({ t: "sessions", sessions: list.map(view) });
            // Browsers keep their subscriptions across a daemon reconnect; each gets a fresh snapshot.
            fans.clear();
            for (const client of clients) for (const id of client.data.subs) subscribe(client, id);
          })
          .catch((error: Error) => log(`listing sessions failed: ${error.message}`));
      },
      onDisconnected: () => {
        log("daemon disconnected");
        fans.clear();
        broadcast({ t: "daemon", up: false });
      },
      onEvent: (event) => onDaemonEvent(event),
      onOutput: (payload, sessionId) => {
        const fan = fans.get(sessionId);
        if (fan) for (const client of fan.active) send(client, payload);
      },
    },
    log,
  );

  function onDaemonEvent(event: DaemonEvent): void {
    switch (event.type) {
      case "created":
        sessions.set(event.session.id, event.session);
        broadcast({ t: "session", session: view(event.session) });
        return;
      case "exited": {
        const session = sessions.get(event.session);
        if (session) session.exited = { code: event.code, signal: event.signal, at: Date.now() };
        broadcastSession(event.session);
        return;
      }
      case "removed":
        sessions.delete(event.session);
        fans.delete(event.session);
        meta.forget(event.session);
        for (const client of clients) client.data.subs.delete(event.session);
        broadcast({ t: "removed", session: event.session });
        return;
      case "title": {
        const session = sessions.get(event.session);
        if (session) session.title = event.title;
        broadcastSession(event.session);
        return;
      }
      case "cwd": {
        const session = sessions.get(event.session);
        if (session) session.cwd = event.cwd;
        broadcastSession(event.session);
        return;
      }
      case "bell":
      case "notify":
        broadcast({ t: "bell", session: event.session });
        return;
    }
  }

  function subscribe(client: Client, sessionId: string): void {
    if (!sessions.has(sessionId)) {
      sendJson(client, { t: "error", message: `no such session: ${sessionId}` });
      return;
    }
    client.data.subs.add(sessionId);
    if (!daemon.connected) return; // resubscribed on reconnect
    let fan = fans.get(sessionId);
    if (!fan) {
      fan = { active: new Set(), subscribed: false };
      fans.set(sessionId, fan);
    }
    const current = fan;
    // The browser resets its terminal on every snapshot, so a repeat subscribe starts clean.
    current.active.delete(client);
    const op = current.subscribed ? "snapshot" : "subscribe";
    current.subscribed = true;
    // This callback runs in frame order: every output frame after it continues from the
    // snapshot's offset, so the browser is added to the fan exactly at that point.
    daemon.request({ op, session: sessionId }, (response) => {
      if (fans.get(sessionId) !== current) return;
      if (!response.ok) {
        if (op === "subscribe") current.subscribed = false;
        sendJson(client, { t: "error", message: response.error });
        return;
      }
      if (!clients.has(client) || !client.data.subs.has(sessionId)) return;
      sendJson(client, { t: "snapshot", snapshot: response.result as Snapshot });
      current.active.add(client);
    });
  }

  function unsubscribe(client: Client, sessionId: string): void {
    client.data.subs.delete(sessionId);
    daemon.request({ op: "focus", session: sessionId, client: client.data.id, focused: false });
    const fan = fans.get(sessionId);
    if (!fan) return;
    fan.active.delete(client);
    for (const other of clients) if (other.data.subs.has(sessionId)) return;
    fans.delete(sessionId);
    daemon.request({ op: "unsubscribe", session: sessionId });
  }

  function onClientMessage(client: Client, message: ClientMessage): void {
    switch (message.t) {
      case "sub":
        subscribe(client, String(message.session));
        return;
      case "unsub":
        unsubscribe(client, String(message.session));
        return;
      case "input":
        if (typeof message.data !== "string") return;
        daemon.request({
          op: "input",
          session: String(message.session),
          data: message.data,
          binary: message.binary === true,
        });
        return;
      case "focus":
        daemon.request({
          op: "focus",
          session: String(message.session),
          client: client.data.id,
          focused: message.focused === true,
        });
        return;
      case "create":
        daemon.request(
          {
            op: "create",
            cols: Number(message.cols),
            rows: Number(message.rows),
            cwd: typeof message.cwd === "string" ? message.cwd : undefined,
            cmd: typeof message.cmd === "string" ? message.cmd : undefined,
          },
          (response) => {
            if (!response.ok) sendJson(client, { t: "error", message: response.error });
          },
        );
        return;
      case "close":
        daemon.request({ op: "close", session: String(message.session) });
        return;
      case "banner": {
        const id = String(message.session);
        if (!sessions.has(id)) return;
        meta.setBanner(id, String(message.banner ?? "").slice(0, 200));
        broadcastSession(id);
        return;
      }
    }
  }

  const isAuthed = (request: Request) => {
    const cookie = readCookie(request, COOKIE_NAME);
    return cookie !== null && safeEqual(cookie, cookieValue);
  };

  const server = Bun.serve({
    hostname: options.host,
    port: options.port,
    development: options.development ?? false,
    routes: {
      "/": indexPage,
      "/api/health": () => Response.json({ ok: true, version: VERSION }),
      "/api/me": (request) =>
        isAuthed(request) ? Response.json({ ok: true }) : new Response("unauthorized", { status: 401 }),
      "/api/login": {
        POST: async (request) => {
          if (!guard.check(request, true)) return new Response("forbidden", { status: 403 });
          const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
          const candidate = typeof body?.token === "string" ? body.token : "";
          if (!safeEqual(candidate, token)) {
            await Bun.sleep(250);
            return new Response("unauthorized", { status: 401 });
          }
          const secure = request.headers.get("origin")?.startsWith("https:") ? "; Secure" : "";
          return new Response(null, {
            status: 204,
            headers: {
              "Set-Cookie": `${COOKIE_NAME}=${cookieValue}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secure}`,
            },
          });
        },
      },
      "/ws": (request, srv) => {
        if (!guard.check(request, true)) return new Response("forbidden", { status: 403 });
        if (!isAuthed(request)) return new Response("unauthorized", { status: 401 });
        const data: ClientData = { id: randomBytes(4).toString("hex"), subs: new Set() };
        if (srv.upgrade(request, { data })) return undefined;
        return new Response("expected a WebSocket upgrade", { status: 400 });
      },
    },
    fetch: () => new Response("not found", { status: 404 }),
    websocket: {
      data: {} as ClientData,
      open(client) {
        clients.add(client);
        sendJson(client, { t: "hello", version: VERSION });
        sendJson(client, { t: "daemon", up: daemon.connected });
        sendJson(client, { t: "sessions", sessions: [...sessions.values()].map(view) });
      },
      message(client, raw) {
        if (typeof raw !== "string") return;
        let message: ClientMessage;
        try {
          message = JSON.parse(raw) as ClientMessage;
        } catch {
          return;
        }
        onClientMessage(client, message);
      },
      close(client) {
        clients.delete(client);
        for (const id of [...client.data.subs]) unsubscribe(client, id);
      },
    },
  });

  daemon.start();
  const port = server.port ?? options.port;
  log(`listening on http://${options.host}:${port}`);

  return {
    port,
    token,
    async stop() {
      daemon.stop();
      await server.stop(true);
      meta.flush();
    },
  };
}
