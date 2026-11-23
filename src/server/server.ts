// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import type { ServerWebSocket } from "bun";
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { loadInstance } from "../common/config.ts";
import { ensurePrivateDir, type Paths, requireSocket } from "../common/paths.ts";
import {
  type AgentStatus,
  type Board,
  type ClientMessage,
  type Frame,
  type DaemonEvent,
  type LostSession,
  MAX_UPLOAD_BYTES,
  type ScreenText,
  type ServerMessage,
  type SessionInfo,
  type SessionView,
  type Snapshot,
  TAB_COLORS,
  type TabView,
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
import { BoardError, parseBoard } from "./board.ts";
import { type AgentDirs, agentDirs, Conversations } from "./conversations.ts";
import { type Control, type CreateRequest, controlRoutes } from "./control-api.ts";
import { DaemonClient } from "./daemon-client.ts";
import { foregroundProcess, processCwd } from "./foreground.ts";
import { cleanName, MetaStore } from "./meta.ts";
import { observe, type RevivalDeps } from "./revival.ts";
import { AgentStatusReader } from "./status.ts";
import { saveUpload, uploadDir } from "./uploads.ts";

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
  /** How long a program must print nothing to be taken as no longer working (tests shorten it). */
  statusQuietMs?: number;
  /** Where Claude Code and Codex keep their conversations; from the environment by default. */
  agentDirs?: AgentDirs;
  /** Where files uploaded from the browser go; uploadDir() by default. */
  uploadDir?: string;
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
/** The JSON a sign-in or a password change sends is tiny; larger bodies are not read. */
const MAX_JSON_BYTES = 64 * 1024;
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
  requireSocket(options.paths);
  ensurePrivateDir(options.paths.stateDir);
  const instance = loadInstance(options.paths);
  const credentials = new Credentials(options.paths.tokenFile, options.paths.passwordFile);
  const cookie = cookieName(instance.instanceId);
  const throttle = new LoginThrottle();
  const guard = new RequestGuard([...(options.allowHosts ?? []), ...boundHostAllowlist(options.host)]);
  const meta = new MetaStore(options.paths.metaFile, (error) => log(`saving ${options.paths.metaFile} failed: ${error.message}`));
  const sessions = new Map<string, SessionInfo>();
  const clients = new Set<Client>();
  const fans = new Map<string, Fan>();
  const owner = { user: ownerName(), host: hostname() };
  /** What the connected daemon answers beyond protocol 1's first requests (HelloResult.features). */
  let daemonFeatures = new Set<string>();

  /** What each terminal's coding agent is doing, for terminals that run one. */
  const statuses = new Map<string, AgentStatus>();
  /** Whether each terminal's shell waits at its prompt, as last looked at. */
  const prompts = new Map<string, boolean>();

  const view = (session: SessionInfo): SessionView => ({
    ...session,
    banner: meta.banner(session.id),
    tab: meta.tabOf(session.id),
    color: meta.colorOf(session.id, sessions.keys()),
    frame: meta.frameOf(session.id),
    agent: statuses.get(session.id),
    hidden: meta.hiddenOf(session.id) || undefined,
    atPrompt: prompts.get(session.id),
  });
  const dirs = options.agentDirs ?? agentDirs();
  const conversations = new Conversations(dirs);
  const revivalDeps: RevivalDeps = { foreground: foregroundProcess, processCwd, conversations, dirs };
  const statusReader = new AgentStatusReader(conversations, dirs, options.statusQuietMs);

  // Bun closes a socket whose backlog passes MAX_CLIENT_BACKLOG (closeOnBackpressureLimit); a send
  // it drops all the same (0) closes it too, so a browser never goes on with a gap in what it was sent.
  const send = (client: Client, data: string | Uint8Array) => {
    if (client.send(data) === 0) client.close(1013, "client too slow");
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
        // In frame order (a request's callback), so an event that follows the list in the same
        // read is applied after it rather than undone by it.
        daemon.request({ op: "list" }, (response) => {
          if (!response.ok) {
            log(`listing sessions failed: ${response.error}`);
            return;
          }
          const list = response.result as SessionInfo[];
          {
            sessions.clear();
            statuses.clear();
            prompts.clear();
            agentMissing.clear();
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
          }
        });
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
        broadcastSession(event.session.id);
        return;
      case "exited": {
        const session = sessions.get(event.session);
        if (session) session.exited = { code: event.code, signal: event.signal, at: Date.now() };
        // Its program ended: there is nothing left to restore.
        meta.setRevival(event.session, undefined);
        statuses.delete(event.session);
        prompts.delete(event.session);
        broadcastSession(event.session);
        return;
      }
      case "removed":
        sessions.delete(event.session);
        fans.delete(event.session);
        statuses.delete(event.session);
        prompts.delete(event.session);
        agentMissing.delete(event.session);
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
      case "session-hidden": {
        const id = String(message.session);
        if (!sessions.has(id)) return;
        // A window is put away only where the board brings it back.
        if (message.hidden === true && !meta.board(meta.tabOf(id))) return;
        meta.setHidden(id, message.hidden === true);
        broadcastSession(id);
        return;
      }
      case "board-window":
        if (meta.setBoardWindow(String(message.tab), { open: message.open, frame: message.frame, direction: message.direction })) {
          broadcastTabs();
        }
        return;
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
          const id = (response.result as SessionInfo).id;
          adoptLost(id, lostId);
          broadcastSession(id);
        }
        broadcastLost();
      },
    );
  }

  /** Gives a new terminal a lost one's place; the caller sends the terminal to browsers. */
  function adoptLost(sessionId: string, lostId: string): void {
    if (meta.isLost(lostId)) meta.adopt(sessionId, lostId);
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

  /** Terminals whose agent was missing at the last note (see noteRevivals). */
  const agentMissing = new Set<string>();

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
        // An agent dies a moment before its shell when the machine or the daemon goes down; a
        // note taken then must not forget it. Only a second note in a row without it drops it.
        if (previous?.agent && !revival.agent && !agentMissing.has(session.id)) {
          agentMissing.add(session.id);
          if (own) claimed.add(own);
          continue;
        }
        agentMissing.delete(session.id);
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
          // It may have gone, or exited (which clears its status), while the screen was read.
          if (!sessions.has(session.id) || sessions.get(session.id)!.exited) return;
          const previous = statuses.get(session.id);
          // How long it has been working, idle or stopped: from the first look that saw it so.
          if (status) status.since = previous?.activity === status.activity ? previous.since : Date.now();
          const atPrompt = running ? running.isShell : undefined;
          const promptChanged = prompts.get(session.id) !== atPrompt;
          if (!promptChanged && JSON.stringify(status) === JSON.stringify(previous)) return;
          if (status) statuses.set(session.id, status);
          else statuses.delete(session.id);
          if (atPrompt === undefined) prompts.delete(session.id);
          else prompts.set(session.id, atPrompt);
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

  /** A tab by id or by name, whatever its case. */
  function findTab(nameOrId: string): TabView | undefined {
    // Cleaned as a stored name is, so a long name finds the tab it made.
    const name = cleanName(nameOrId);
    const tabs = meta.tabs();
    return tabs.find((tab) => tab.id === name) ?? tabs.find((tab) => tab.name.toLowerCase() === name.toLowerCase());
  }

  /** A tab by id or name; a name no tab has makes a new tab. */
  function tabFor(nameOrId: string): string {
    const name = cleanName(nameOrId);
    const tabs = meta.tabs();
    const found = findTab(name);
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
            // A tab with a board shows the board and its lead; the workers start put away, behind their tasks.
            if (tab && meta.board(tab) && !request.show) meta.setHidden(created.id, true);
            broadcastSession(created.id);
            resolve(view(sessions.get(created.id) ?? created));
          },
        );
      }),
    update: (id, patch) => {
      const session = sessions.get(id);
      if (!session) return null;
      if (patch.hidden === true) {
        const tab = patch.tab?.trim() ? findTab(patch.tab) : meta.tabs().find((candidate) => candidate.id === meta.tabOf(id));
        if (!tab?.board) {
          throw new Error(
            `terminal ${id} would be put away in a tab without a board, and only a board brings a window back; ` +
              "a tab gets one with `spectraweaver board set`",
          );
        }
      }
      if (patch.banner !== undefined) meta.setBanner(id, patch.banner.slice(0, 200));
      if (patch.tab?.trim()) meta.setSessionTab(id, tabFor(patch.tab), sessions.keys());
      if (patch.hidden !== undefined) {
        meta.setHidden(id, patch.hidden);
        if (!patch.hidden) raise(id);
      }
      broadcastSession(id);
      return view(session);
    },
    board: (name) => findTab(name) ?? null,
    setBoard: (name, input, lead) => {
      // Checked before the tab is looked up, so a board with mistakes makes no tab.
      const board = parseBoard(input, Date.now(), lead && sessions.has(lead) ? lead : undefined);
      const tab = tabFor(name);
      if (meta.setBoard(tab, board)) layOutForBoard(tab, board);
      broadcastTabs();
      const warnings = board.tasks.flatMap((task) =>
        task.session && !sessions.has(task.session)
          ? [`task "${task.id}": there is no terminal ${task.session} (\`spectraweaver ls\` lists them)`]
          : [],
      );
      return { tab: meta.tabs().find((candidate) => candidate.id === tab)!, warnings };
    },
    clearBoard: (name) => {
      const tab = findTab(name);
      if (!tab) return null;
      if (meta.clearBoard(tab.id)) {
        // Nothing brings a window back without a board: the tab's windows put away come out.
        for (const id of sessions.keys()) {
          if (meta.tabOf(id) !== tab.id || !meta.hiddenOf(id)) continue;
          meta.setHidden(id, false);
          broadcastSession(id);
        }
        broadcastTabs();
      }
      return meta.tabs().find((candidate) => candidate.id === tab.id) ?? null;
    },
  };

  /** The highest window in a tab: its terminals' and its board's. */
  function topOfTab(tab: string): number {
    const frames: Frame[] = [];
    for (const id of sessions.keys()) {
      const frame = meta.tabOf(id) === tab ? meta.frameOf(id) : undefined;
      if (frame) frames.push(frame);
    }
    const board = meta.tabs().find((candidate) => candidate.id === tab)?.boardWindow?.frame;
    if (board) frames.push(board);
    return frames.reduce((top, frame) => Math.max(top, frame.z), 0);
  }

  /** Brings a terminal's window in front of the others in its tab, if it has a place yet. */
  function raise(id: string): void {
    const frame = meta.frameOf(id);
    if (frame) meta.setSessionFrame(id, { ...frame, z: topOfTab(meta.tabOf(id)) + 1 });
  }

  /**
   * A tab's first board: the board takes the left of the tab and the terminal that pushed it the
   * right, in front; the terminals the board assigns tasks to are put away, to come out from their tasks.
   */
  function layOutForBoard(tab: string, board: Board): void {
    const top = topOfTab(tab);
    meta.setBoardWindow(tab, { open: true, frame: { x: 0, y: 0, w: 0.6, h: 1, z: top + 1 } });
    for (const task of board.tasks) {
      if (task.session && task.session !== board.lead && sessions.has(task.session) && meta.tabOf(task.session) === tab) {
        meta.setHidden(task.session, true);
        broadcastSession(task.session);
      }
    }
    if (board.lead && meta.tabOf(board.lead) === tab) {
      meta.setSessionFrame(board.lead, { x: 0.6, y: 0, w: 0.4, h: 1, z: top + 2 });
      meta.setHidden(board.lead, false);
      broadcastSession(board.lead);
    }
  }

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

  // A sign-in or a password: small, and read before anyone is known, so a large body is not read.
  const readJson = async (request: Request) =>
    Number(request.headers.get("content-length") ?? 0) > MAX_JSON_BYTES
      ? {}
      : (((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>);

  const server = Bun.serve({
    hostname: options.host,
    port: options.port,
    development: options.development ?? false,
    routes: {
      "/": indexPage,
      // `uid` lets `spectraweaver up` tell its own server from another user's on the same port.
      // Host-checked like everything else, so a page on a rebound DNS name cannot read who runs it.
      "/api/health": (request) =>
        guard.check(request, false)
          ? Response.json({ ok: true, version: VERSION, uid: process.getuid?.() ?? null, pid: process.pid })
          : new Response("forbidden", { status: 403 }),
      "/api/login-info": (request) =>
        guard.check(request, false)
          ? Response.json({ ...owner, passwordSet: credentials.passwordHash() !== null })
          : new Response("forbidden", { status: 403 }),
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
            // Counted before it is checked: guesses sent at once must not all pass the lock while
            // the first ones are still being verified.
            throttle.failed();
            if (!(await credentials.verifyPassword(body.password))) return new Response("unauthorized", { status: 401 });
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
      // A file dropped on a terminal or pasted into it: the body is the file, its name (URI-encoded)
      // in X-File-Name. Answers the path it was written to, which the browser types in.
      "/api/upload": {
        POST: async (request) => {
          if (!guard.check(request, true)) return new Response("forbidden", { status: 403 });
          if (!isAuthed(request)) return new Response("unauthorized", { status: 401 });
          // Read before it is judged: a reply sent while the browser is still sending can leave the
          // connection hanging. maxRequestBodySize bounds what is read.
          const bytes = new Uint8Array(await request.arrayBuffer());
          if (bytes.length === 0) return new Response("the file is empty", { status: 400 });
          if (bytes.length > MAX_UPLOAD_BYTES) return new Response(`files up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`, { status: 413 });
          let name = "";
          try {
            name = decodeURIComponent(request.headers.get("x-file-name") ?? "");
          } catch {
            // a name that is not valid URI encoding: none
          }
          try {
            const path = saveUpload(options.uploadDir ?? uploadDir(), bytes, name, request.headers.get("content-type") ?? "");
            return Response.json({ path });
          } catch (error) {
            log(`upload failed: ${(error as Error).message}`);
            return new Response((error as Error).message, { status: 500 });
          }
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
    // Bodies are small JSON (a sign-in, a board of at most 500 tasks), or an upload.
    maxRequestBodySize: MAX_UPLOAD_BYTES + 64 * 1024,
    websocket: {
      data: {} as ClientData,
      backpressureLimit: MAX_CLIENT_BACKLOG,
      closeOnBackpressureLimit: true,
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
        if (typeof message !== "object" || message === null) return;
        // A message that trips over something must not take the server, and every terminal's view, down.
        try {
          onClientMessage(client, message);
        } catch (error) {
          log(`a browser's ${String(message.t).slice(0, 40)} message failed: ${(error as Error).message}`);
        }
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
