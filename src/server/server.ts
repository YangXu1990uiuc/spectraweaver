// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import type { ServerWebSocket } from "bun";
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { loadInstance } from "../common/config.ts";
import { ensurePrivateDir, type Paths } from "../common/paths.ts";
import {
  type AgentStatus,
  type ClientMessage,
  type DaemonEvent,
  type LostSession,
  type ScreenText,
  type ServerMessage,
  type SessionInfo,
  type SessionView,
  type Snapshot,
  TAB_COLORS,
} from "../common/protocol.ts";
import { VERSION } from "../common/version.ts";
import indexPage from "../web/index.html";
import {
  boundHostAllowlist,
  cookieName,
  Credentials,
  LoginThrottle,
  readCookie,
  RequestGuard,
  safeEqual,
  setPassword,
  validatePassword,
} from "./auth.ts";
import { agentNamed, detectAgent, resumeCommand, shellQuote } from "./agents.ts";
import { type AgentDirs, agentDirs, Conversations } from "./conversations.ts";
import { type Control, type CreateRequest, controlRoutes } from "./control-api.ts";
import { DaemonClient } from "./daemon-client.ts";
import { foregroundProcess, processCwd } from "./foreground.ts";
import { MetaStore } from "./meta.ts";
import { observe, type RevivalDeps } from "./revival.ts";
import { AgentStatusReader } from "./status.ts";

export interface ServerOptions {
  paths: Paths;
  host: string;
  port: number;
  /** Extra hostnames browsers may use to reach the server (e.g. a Tailscale name). */
  allowHosts?: string[];
  development?: boolean;
  log?: (message: string) => void;
  /** How often to note what would bring each terminal back after a restart. */
  revivalEveryMs?: number;
  /** How often to look at what each terminal's coding agent is doing. */
  statusEveryMs?: number;
  /** Where Claude Code and Codex keep their conversations; from the environment by default. */
  agentDirs?: AgentDirs;
}

export interface ServerHandle {
  readonly port: number;
  /** Null only if the token file has gone missing since startup. */
  readonly token: string | null;
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
const REVIVAL_EVERY_MS = 15_000;
const STATUS_EVERY_MS = 2000;
/** The rows of a terminal's screen read to tell what its agent shows. */
const STATUS_SCREEN_ROWS = 60;
/** How far back "Resume a recent conversation" looks, and how many it lists. */
const RECENT_CONVERSATIONS_MS = 14 * 24 * 3600_000;
const RECENT_CONVERSATIONS_MAX = 60;
// A tag the server gives a terminal it creates to restore a lost one; the daemon echoes it.
const RESTORE_TAG = "restore:";

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function ownerName(): string {
  try {
    return userInfo().username;
  } catch {
    // Containers can run as a uid with no passwd entry.
    return process.env.USER ?? `uid ${process.getuid?.() ?? "?"}`;
  }
}

export async function startServer(options: ServerOptions): Promise<ServerHandle> {
  const log = options.log ?? ((message: string) => console.error(`[server] ${message}`));
  ensurePrivateDir(options.paths.stateDir);
  const instance = loadInstance(options.paths);
  const credentials = new Credentials(options.paths.tokenFile, options.paths.passwordFile);
  const cookie = cookieName(instance.instanceId);
  const throttle = new LoginThrottle();
  const guard = new RequestGuard([...(options.allowHosts ?? []), ...boundHostAllowlist(options.host)]);
  const meta = new MetaStore(options.paths.metaFile);
  const sessions = new Map<string, SessionInfo>();
  const clients = new Set<Client>();
  const fans = new Map<string, Fan>();
  const owner = { user: ownerName(), host: hostname() };
  /** What the connected daemon answers beyond protocol 1's first requests (HelloResult.features). */
  let daemonFeatures = new Set<string>();

  /** What each terminal's coding agent is doing, for terminals that run one. */
  const statuses = new Map<string, AgentStatus>();

  const view = (session: SessionInfo): SessionView => ({
    ...session,
    banner: meta.banner(session.id),
    tab: meta.tabOf(session.id),
    color: meta.colorOf(session.id, sessions.keys()),
    frame: meta.frameOf(session.id),
    agent: statuses.get(session.id),
  });
  const dirs = options.agentDirs ?? agentDirs();
  const conversations = new Conversations(dirs);
  const revivalDeps: RevivalDeps = { foreground: foregroundProcess, processCwd, conversations, dirs };
  const statusReader = new AgentStatusReader(conversations, dirs);

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
  const broadcastTabs = () => broadcast({ t: "tabs", tabs: meta.tabs() });
  const broadcastLost = () => broadcast({ t: "lost", sessions: lostViews() });

  const daemon = new DaemonClient(
    options.paths.daemonSocket,
    {
      onConnected: (hello) => {
        daemonFeatures = new Set(hello.features ?? []);
        log(`connected to daemon ${hello.version} (pid ${hello.pid})`);
        daemon
          .call<SessionInfo[]>({ op: "list" })
          .then((list) => {
            sessions.clear();
            statuses.clear();
            for (const session of list) sessions.set(session.id, session);
            // Daemons older than the instance id are told apart by pid.
            meta.reconcile(new Set(sessions.keys()), hello.instance ?? `pid ${hello.pid}`);
            // Sessions without a colour get one in creation order, so the result is stable.
            for (const session of [...list].sort((a, b) => a.createdAt - b.createdAt)) {
              meta.colorOf(session.id, sessions.keys());
            }
            broadcast({ t: "daemon", up: true, features: [...daemonFeatures] });
            broadcast({ t: "sessions", sessions: list.map(view) });
            broadcastLost();
            noteRevivals();
            // Browsers keep their subscriptions across a daemon reconnect; each gets a fresh snapshot.
            // A new daemon has none of the old sessions; those subscriptions just end.
            fans.clear();
            for (const client of clients) {
              for (const id of [...client.data.subs]) {
                if (sessions.has(id)) subscribe(client, id);
                else client.data.subs.delete(id);
              }
            }
          })
          .catch((error: Error) => log(`listing sessions failed: ${error.message}`));
      },
      onDisconnected: () => {
        log("daemon disconnected");
        fans.clear();
        daemonFeatures = new Set();
        broadcast({ t: "daemon", up: false, features: [] });
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
        // Sessions created from a browser carry the tab they were created in; restored ones, the
        // lost terminal they replace.
        if (event.tag?.startsWith(RESTORE_TAG)) adoptLost(event.session.id, event.tag.slice(RESTORE_TAG.length));
        else if (event.tag) meta.setSessionTab(event.session.id, event.tag, sessions.keys());
        broadcast({ t: "session", session: view(event.session) });
        return;
      case "exited": {
        const session = sessions.get(event.session);
        if (session) session.exited = { code: event.code, signal: event.signal, at: Date.now() };
        // Its program ended: there is nothing left to restore.
        meta.setRevival(event.session, undefined);
        statuses.delete(event.session);
        broadcastSession(event.session);
        return;
      }
      case "removed":
        sessions.delete(event.session);
        fans.delete(event.session);
        statuses.delete(event.session);
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
      case "resized": {
        const session = sessions.get(event.session);
        if (!session) return;
        session.cols = event.cols;
        session.rows = event.rows;
        broadcastSession(event.session);
        // Every viewer gets a snapshot at the new size. This event comes in stream order, before
        // anything the program prints for the new size, and subscribe() takes the browser out of
        // the fan first: no output meant for the new grid reaches a browser still showing the old one.
        for (const client of clients) if (client.data.subs.has(event.session)) subscribe(client, event.session);
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
      case "create": {
        const tab = typeof message.tab === "string" && meta.hasTab(message.tab) ? message.tab : undefined;
        let cwd = typeof message.cwd === "string" ? message.cwd : undefined;
        const source = typeof message.cwdOf === "string" ? sessions.get(message.cwdOf) : undefined;
        if (!cwd && source && !source.exited) cwd = processCwd(source.pid) ?? undefined;
        daemon.request(
          {
            op: "create",
            cols: Number(message.cols),
            rows: Number(message.rows),
            cwd,
            cmd: typeof message.cmd === "string" ? message.cmd : undefined,
            tag: tab,
          },
          (response) => {
            if (!response.ok) {
              sendJson(client, { t: "error", message: response.error });
              return;
            }
            // Daemons older than the tab tag don't echo it; place the session here instead.
            const id = (response.result as SessionInfo).id;
            if (tab && meta.tabOf(id) !== tab && meta.setSessionTab(id, tab, sessions.keys())) broadcastSession(id);
          },
        );
        return;
      }
      case "close":
        daemon.request({ op: "close", session: String(message.session) });
        return;
      case "resize": {
        const id = String(message.session);
        if (!sessions.has(id)) return;
        if (!daemonFeatures.has("resize")) {
          sendJson(client, {
            t: "error",
            message:
              "This daemon predates resizing. To resize terminals, restart it: `spectraweaver down --all` " +
              "(every session ends), then `spectraweaver up`.",
          });
          return;
        }
        daemon.request(
          { op: "resize", session: id, cols: Number(message.cols), rows: Number(message.rows) },
          (response) => {
            if (!response.ok) sendJson(client, { t: "error", message: response.error });
          },
        );
        return;
      }
      case "banner": {
        const id = String(message.session);
        if (!sessions.has(id)) return;
        meta.setBanner(id, String(message.banner ?? "").slice(0, 200));
        broadcastSession(id);
        return;
      }
      case "session-move": {
        const id = String(message.session);
        if (sessions.has(id) && meta.setSessionTab(id, String(message.tab), sessions.keys())) broadcastSession(id);
        return;
      }
      case "session-frame": {
        const id = String(message.session);
        if (sessions.has(id) && meta.setSessionFrame(id, message.frame)) broadcastSession(id);
        return;
      }
      case "tab-create":
        if (
          meta.createTab({
            id: String(message.id),
            name: String(message.name ?? ""),
            color: String(message.color ?? ""),
            grid: String(message.grid ?? ""),
          })
        ) {
          broadcastTabs();
        }
        return;
      case "tab-update":
        if (
          meta.updateTab(String(message.id), {
            name: typeof message.name === "string" ? message.name : undefined,
            color: typeof message.color === "string" ? message.color : undefined,
            grid: typeof message.grid === "string" ? message.grid : undefined,
          })
        ) {
          broadcastTabs();
        }
        return;
      case "tab-delete": {
        const moved = meta.deleteTab(String(message.id), sessions.keys());
        if (!moved) {
          sendJson(client, { t: "error", message: "The last tab cannot be deleted." });
          return;
        }
        broadcastTabs();
        for (const id of moved) broadcastSession(id);
        return;
      }
      case "tab-move":
        if (meta.moveTab(String(message.id), Number(message.index))) broadcastTabs();
        return;
      case "restore":
        if (Array.isArray(message.ids)) for (const id of message.ids) restore(client, String(id));
        return;
      case "forget":
        if (!Array.isArray(message.ids)) return;
        for (const id of message.ids) if (meta.isLost(String(id)) && !restoring.has(String(id))) meta.forget(String(id));
        broadcastLost();
        return;
      case "conversations":
        sendJson(client, { t: "conversations", conversations: recentConversations(), flags: meta.agentFlags() });
        return;
    }
  }

  // ---- terminals lost when their daemon stopped -------------------------------------------

  /** Lost terminals being restored, so a second click does not restore them twice. */
  const restoring = new Set<string>();

  function lostViews(): LostSession[] {
    return meta.lostIds().flatMap((id) => {
      const revival = meta.revival(id);
      if (!revival || restoring.has(id)) return [];
      const lost: LostSession = {
        id,
        tab: meta.tabOf(id),
        color: meta.colorOf(id, []),
        banner: meta.banner(id),
        frame: meta.frameOf(id),
        cwd: revival.cwd,
        cols: revival.cols,
        rows: revival.rows,
      };
      const agent = revival.agent && agentNamed(revival.agent.name);
      if (revival.agent && agent) {
        const id = revival.agent.conversation ?? null;
        const file = id ? conversations.find(agent.name, id) : undefined;
        lost.agent = {
          name: agent.name,
          command: resumeCommand(agent, id, revival.agent.flags),
          conversation: file ? conversations.label(file) : undefined,
        };
      }
      return [lost];
    });
  }

  /**
   * A new terminal for a lost one: same tab, window, size and directory (home if it is gone),
   * resuming the agent that ran in it on the same conversation.
   */
  function restore(client: Client, lostId: string): void {
    const revival = meta.revival(lostId);
    if (!meta.isLost(lostId) || !revival || restoring.has(lostId)) return;
    if (!daemon.connected) {
      sendJson(client, { t: "error", message: "The daemon is not running. Start it with `spectraweaver up`." });
      return;
    }
    const agent = revival.agent && agentNamed(revival.agent.name);
    const cmd = revival.agent && agent ? resumeCommand(agent, revival.agent.conversation ?? null, revival.agent.flags) : undefined;
    restoring.add(lostId);
    broadcastLost();
    daemon.request(
      {
        op: "create",
        cols: revival.cols,
        rows: revival.rows,
        cwd: isDirectory(revival.cwd) ? revival.cwd : undefined,
        cmd,
        tag: `${RESTORE_TAG}${lostId}`,
      },
      (response) => {
        restoring.delete(lostId);
        if (!response.ok) {
          sendJson(client, { t: "error", message: `Restoring a terminal failed: ${response.error}` });
        } else if (meta.isLost(lostId)) {
          // Daemons older than the tag don't echo it.
          adoptLost((response.result as SessionInfo).id, lostId);
        }
        broadcastLost();
      },
    );
  }

  function adoptLost(sessionId: string, lostId: string): void {
    if (!meta.isLost(lostId)) return;
    meta.adopt(sessionId, lostId);
    broadcastSession(sessionId);
  }

  /** Conversations from the last two weeks that no terminal, live or lost, is on. */
  function recentConversations() {
    conversations.refresh();
    const taken = new Set<string>();
    for (const id of [...sessions.keys(), ...meta.lostIds()]) {
      const conversation = meta.revival(id)?.agent?.conversation;
      if (conversation) taken.add(conversation);
    }
    return conversations
      .recent(Date.now() - RECENT_CONVERSATIONS_MS, RECENT_CONVERSATIONS_MAX + taken.size)
      .filter((found) => !taken.has(found.id))
      .slice(0, RECENT_CONVERSATIONS_MAX)
      .map((found) => ({
        agent: found.agent,
        id: found.id,
        cwd: found.cwd,
        label: found.label,
        updatedAt: Math.round(found.mtimeMs),
        command: agentNamed(found.agent)!.resume(found.id),
      }));
  }

  /** Notes, for every running terminal, what would bring it back after a restart. */
  function noteRevivals(): void {
    if (!daemon.connected) return;
    const claimed = new Set<string>();
    const live = [...sessions.values()].filter((session) => !session.exited);
    // Conversations already found are kept first, so a guess for another terminal cannot take them.
    for (const session of live) {
      const conversation = meta.revival(session.id)?.agent?.conversation;
      if (conversation) claimed.add(conversation);
    }
    for (const session of live) {
      const previous = meta.revival(session.id);
      const own = previous?.agent?.conversation;
      if (own) claimed.delete(own);
      try {
        const revival = observe(session, previous, claimed, revivalDeps);
        meta.setRevival(session.id, revival);
        if (revival.agent) {
          if (revival.agent.conversation) claimed.add(revival.agent.conversation);
          meta.setAgentFlags(revival.agent.name, revival.agent.flags.map(shellQuote).join(" "));
        }
      } catch (error) {
        log(`noting how to restore ${session.id} failed: ${(error as Error).message}`);
        if (own) claimed.add(own);
      }
    }
  }
  const revivalTimer = setInterval(noteRevivals, options.revivalEveryMs ?? REVIVAL_EVERY_MS);

  // ---- what the agents are doing ----------------------------------------------------------

  let notingStatuses = false;

  /** Looks at what every terminal's agent is doing; terminals whose status changed are sent again. */
  async function noteStatuses(): Promise<void> {
    if (notingStatuses || !daemon.connected) return;
    notingStatuses = true;
    try {
      const canRead = daemonFeatures.has("text");
      let unnoted = false;
      const live = [...sessions.values()].filter((session) => !session.exited);
      await Promise.all(
        live.map(async (session) => {
          const running = foregroundProcess(session.pid);
          const agent = running && !running.isShell ? detectAgent(running.argv) : null;
          let status: AgentStatus | undefined;
          if (running && agent) {
            const revival = meta.revival(session.id)?.agent;
            // A conversation noted for this very process; a new agent waits for the next note.
            const conversation = revival?.pid === running.pid ? revival.conversation : undefined;
            if (revival?.pid !== running.pid) unnoted = true;
            const screen = canRead
              ? await daemon
                  .call<ScreenText>({ op: "text", session: session.id, lines: STATUS_SCREEN_ROWS })
                  .catch(() => null)
              : null;
            status = statusReader.status(agent, running.pid, conversation, screen);
          }
          if (!sessions.has(session.id) || JSON.stringify(status) === JSON.stringify(statuses.get(session.id))) return;
          if (status) statuses.set(session.id, status);
          else statuses.delete(session.id);
          broadcastSession(session.id);
        }),
      );
      // An agent started since the last note: find its conversation now rather than in a few seconds.
      if (unnoted) noteRevivals();
    } catch (error) {
      log(`looking at the agents failed: ${(error as Error).message}`);
    } finally {
      notingStatuses = false;
    }
  }
  const statusTimer = setInterval(() => void noteStatuses(), options.statusEveryMs ?? STATUS_EVERY_MS);

  // ---- the command line's interface ------------------------------------------------------

  /** A tab by id or name; a name no tab has makes a new tab. */
  function tabFor(nameOrId: string): string {
    const name = nameOrId.replace(/\s+/g, " ").trim();
    const tabs = meta.tabs();
    const found = tabs.find((tab) => tab.id === name) ?? tabs.find((tab) => tab.name.toLowerCase() === name.toLowerCase());
    if (found) return found.id;
    // Not red, which marks a terminal that needs someone, nor grey: a colour no tab has yet, if one is left.
    const colors = TAB_COLORS.filter((candidate) => candidate !== "#f14c4c" && candidate !== "#8b8b8b");
    const used = new Set(tabs.map((tab) => tab.color));
    const color = colors.find((candidate) => !used.has(candidate)) ?? colors[tabs.length % colors.length]!;
    let id: string;
    do id = randomBytes(4).toString("hex");
    while (meta.hasTab(id));
    meta.createTab({ id, name, color, grid: "2x2" });
    broadcastTabs();
    return id;
  }

  const control: Control = {
    sessions: () => [...sessions.values()].sort((a, b) => a.createdAt - b.createdAt).map(view),
    tabs: () => meta.tabs(),
    create: (request: CreateRequest) =>
      new Promise((resolve, reject) => {
        if (!daemon.connected) {
          reject(new Error("the daemon is not running (start it with `spectraweaver up`)"));
          return;
        }
        const tab = request.tab?.trim() ? tabFor(request.tab) : undefined;
        daemon.request(
          { op: "create", cols: request.cols, rows: request.rows, cwd: request.cwd, cmd: request.cmd, tag: tab },
          (response) => {
            if (!response.ok) {
              reject(new Error(response.error));
              return;
            }
            const created = response.result as SessionInfo;
            // Daemons older than the tab tag don't echo it.
            if (tab && meta.tabOf(created.id) !== tab) meta.setSessionTab(created.id, tab, sessions.keys());
            if (request.banner) meta.setBanner(created.id, request.banner.slice(0, 200));
            broadcastSession(created.id);
            resolve(view(sessions.get(created.id) ?? created));
          },
        );
      }),
    update: (id, patch) => {
      const session = sessions.get(id);
      if (!session) return null;
      if (patch.banner !== undefined) meta.setBanner(id, patch.banner.slice(0, 200));
      if (patch.tab?.trim()) meta.setSessionTab(id, tabFor(patch.tab), sessions.keys());
      broadcastSession(id);
      return view(session);
    },
  };

  const isAuthed = (request: Request) => {
    const value = readCookie(request, cookie);
    const expected = credentials.cookieValue();
    return value !== null && expected !== null && safeEqual(value, expected);
  };

  const cookieHeader = (request: Request, value: string, maxAge: number) => {
    const secure = request.headers.get("origin")?.startsWith("https:") ? "; Secure" : "";
    return `${cookie}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
  };

  const loggedIn = (request: Request) => {
    const value = credentials.cookieValue();
    if (value === null) {
      log(`sign-in refused: the token file ${options.paths.tokenFile} is missing`);
      return new Response("the server's token file is missing; restart it", { status: 503 });
    }
    return new Response(null, { status: 204, headers: { "Set-Cookie": cookieHeader(request, value, 31_536_000) } });
  };

  const readJson = async (request: Request) =>
    ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;

  const server = Bun.serve({
    hostname: options.host,
    port: options.port,
    development: options.development ?? false,
    routes: {
      "/": indexPage,
      // `uid` lets `spectraweaver up` tell its own server from another user's on the same port.
      "/api/health": () => Response.json({ ok: true, version: VERSION, uid: process.getuid?.() ?? null }),
      "/api/login-info": () =>
        Response.json({ ...owner, passwordSet: credentials.passwordHash() !== null }),
      "/api/me": (request) =>
        isAuthed(request) ? Response.json({ ok: true }) : new Response("unauthorized", { status: 401 }),
      "/api/login": {
        POST: async (request) => {
          if (!guard.check(request, true)) return new Response("forbidden", { status: 403 });
          const body = await readJson(request);
          if (typeof body.password === "string") {
            const wait = throttle.retryAfterMs();
            if (wait > 0) {
              return new Response("too many attempts", {
                status: 429,
                headers: { "Retry-After": String(Math.ceil(wait / 1000)) },
              });
            }
            if (!(await credentials.verifyPassword(body.password))) {
              throttle.failed();
              return new Response("unauthorized", { status: 401 });
            }
            throttle.succeeded();
            return loggedIn(request);
          }
          const token = credentials.token();
          if (token !== null && typeof body.token === "string" && safeEqual(body.token, token)) {
            return loggedIn(request);
          }
          await Bun.sleep(250);
          return new Response("unauthorized", { status: 401 });
        },
      },
      "/api/password": {
        POST: async (request) => {
          if (!guard.check(request, true)) return new Response("forbidden", { status: 403 });
          if (!isAuthed(request)) return new Response("unauthorized", { status: 401 });
          const body = await readJson(request);
          const password = typeof body.password === "string" ? body.password : "";
          const problem = validatePassword(password);
          if (problem) return new Response(problem, { status: 400 });
          await setPassword(options.paths.passwordFile, password);
          // Every other browser's cookie is now invalid; drop their sockets so they notice.
          for (const client of clients) client.close(4001, "password changed");
          return loggedIn(request);
        },
      },
      "/api/logout": {
        POST: (request) => {
          if (!guard.check(request, true)) return new Response("forbidden", { status: 403 });
          return new Response(null, { status: 204, headers: { "Set-Cookie": cookieHeader(request, "", 0) } });
        },
      },
      ...controlRoutes(control, () => credentials.token(), (request) => guard.check(request, false)),
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
        sendJson(client, { t: "daemon", up: daemon.connected, features: [...daemonFeatures] });
        sendJson(client, { t: "tabs", tabs: meta.tabs() });
        sendJson(client, { t: "sessions", sessions: [...sessions.values()].map(view) });
        sendJson(client, { t: "lost", sessions: lostViews() });
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
    get token() {
      return credentials.token();
    },
    async stop() {
      clearInterval(revivalTimer);
      clearInterval(statusTimer);
      daemon.stop();
      await server.stop(true);
      meta.flush();
    },
  };
}
