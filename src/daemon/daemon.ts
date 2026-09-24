// Copyright 2026 The workstreams Authors
// SPDX-License-Identifier: Apache-2.0
// Part of workstreams: https://github.com/YangXu1990uiuc/workstreams

import type { Socket } from "bun";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, rmSync, statSync, unlinkSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { networkFilesystem } from "../common/files.ts";
import { ensurePrivateDir, type Paths } from "../common/paths.ts";
import {
  type DaemonEvent,
  type DaemonRequestFrame,
  decodeJson,
  encodeJsonFrame,
  encodeOutputFrame,
  FrameDecoder,
  type HelloResult,
  KIND_JSON,
  PROTOCOL_VERSION,
} from "../common/protocol.ts";
import { QueuedWriter } from "../common/socket.ts";
import { VERSION } from "../common/version.ts";
import { Session, type Subscriber } from "./session.ts";

export interface DaemonOptions {
  paths: Paths;
  /** Command line for new sessions. Defaults to the user's login shell. */
  shellArgv?: string[];
  scrollback?: number;
  env?: Record<string, string | undefined>;
  log?: (message: string) => void;
}

export interface DaemonHandle {
  readonly sessions: ReadonlyMap<string, Session>;
  stop(): Promise<void>;
}

// A server that stops reading must not make the daemon buffer without bound. Past this
// backlog the connection is dropped; the server reconnects and resubscribes with snapshots.
const MAX_CONNECTION_BACKLOG = 128 * 1024 * 1024;

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const log = options.log ?? ((message: string) => console.error(`[daemon] ${message}`));
  const socketPath = options.paths.daemonSocket;
  ensurePrivateDir(options.paths.stateDir);
  if (existsSync(socketPath)) {
    if (await isListening(socketPath)) throw new Error(`a daemon is already listening on ${socketPath}`);
    unlinkSync(socketPath);
  }

  const shellArgv = options.shellArgv ?? defaultShellArgv();
  const scrollback = options.scrollback ?? 10_000;
  const env = options.env ?? process.env;
  const sessions = new Map<string, Session>();
  const connections = new Set<Connection>();

  const broadcast = (event: DaemonEvent) => {
    const frame = encodeJsonFrame({ t: "evt", ev: event });
    for (const connection of connections) connection.send(frame);
  };

  const remove = (session: Session) => {
    if (!sessions.delete(session.id)) return;
    session.dispose();
    broadcast({ type: "removed", session: session.id });
  };

  const context: DaemonContext = {
    log,
    sessions,
    create(request) {
      const cols = clampInt(request.cols, 2, 1000);
      const rows = clampInt(request.rows, 1, 500);
      const cwd = resolveCwd(request.cwd);
      const id = newSessionId(sessions);
      const session = new Session({
        id,
        cols,
        rows,
        cwd,
        cmd: request.cmd?.trim() || null,
        argv: shellArgv,
        env,
        scrollback,
        emit: broadcast,
        onExited: (exited) => {
          if (exited.closing) remove(exited);
        },
      });
      sessions.set(id, session);
      log(`session ${id} created (${cols}x${rows}, pid ${session.info().pid})`);
      const tag = typeof request.tag === "string" ? request.tag.slice(0, 64) : undefined;
      broadcast({ type: "created", session: session.info(), tag });
      return session;
    },
    close(id) {
      const session = sessions.get(id);
      if (!session) return;
      if (session.exited) remove(session);
      else session.terminate();
    },
  };

  const listener = listenUnix(socketPath, {
    open(socket) {
      const connection = new Connection(socket, context);
      socket.data = connection;
      connections.add(connection);
    },
    data(socket, chunk) {
      socket.data.receive(chunk);
    },
    drain(socket) {
      socket.data.drain();
    },
    close(socket) {
      socket.data.onClose();
      connections.delete(socket.data);
    },
    error(_socket, error) {
      log(`socket error: ${error.message}`);
    },
  });
  chmodSync(socketPath, 0o600);
  log(`listening on ${socketPath} (pid ${process.pid})`);

  return {
    sessions,
    async stop() {
      listener.stop(true);
      for (const session of sessions.values()) session.dispose();
      sessions.clear();
      rmSync(socketPath, { force: true });
    },
  };
}

interface DaemonContext {
  log: (message: string) => void;
  sessions: Map<string, Session>;
  create(request: { cols: number; rows: number; cwd?: string; cmd?: string; tag?: string }): Session;
  close(id: string): void;
}

class Connection implements Subscriber {
  readonly id = randomBytes(4).toString("hex");
  closed = false;
  private readonly writer: QueuedWriter;
  private readonly decoder: FrameDecoder;
  private readonly subscriptions = new Set<Session>();

  constructor(
    private readonly socket: Socket<Connection>,
    private readonly context: DaemonContext,
  ) {
    this.writer = new QueuedWriter(socket, MAX_CONNECTION_BACKLOG, () => {
      context.log(`connection ${this.id} fell too far behind; dropping it`);
      socket.end();
    });
    this.decoder = new FrameDecoder((kind, payload) => {
      if (kind === KIND_JSON) this.handle(decodeJson<DaemonRequestFrame>(payload));
    });
  }

  send(frame: Uint8Array): void {
    if (!this.closed) this.writer.send(frame);
  }

  sendOutput(sessionId: string, offset: number, data: Uint8Array): void {
    this.send(encodeOutputFrame(sessionId, offset, data));
  }

  receive(chunk: Uint8Array): void {
    try {
      this.decoder.push(chunk);
    } catch (error) {
      this.context.log(`connection ${this.id}: ${(error as Error).message}`);
      this.socket.end();
    }
  }

  drain(): void {
    this.writer.drain();
  }

  onClose(): void {
    this.closed = true;
    for (const session of this.subscriptions) session.unsubscribe(this);
    this.subscriptions.clear();
    for (const session of this.context.sessions.values()) session.dropFocusWithPrefix(`${this.id}:`);
  }

  private respond(id: number, result: unknown): void {
    if (id !== 0) this.send(encodeJsonFrame({ t: "res", id, ok: true, result }));
  }

  private fail(id: number, error: string): void {
    if (id !== 0) this.send(encodeJsonFrame({ t: "res", id, ok: false, error }));
  }

  private session(id: string): Session {
    const session = this.context.sessions.get(id);
    if (!session) throw new Error(`no such session: ${id}`);
    return session;
  }

  private handle(request: DaemonRequestFrame): void {
    try {
      this.dispatch(request);
    } catch (error) {
      this.fail(request.id, (error as Error).message);
    }
  }

  private dispatch(request: DaemonRequestFrame): void {
    switch (request.op) {
      case "hello": {
        const hello: HelloResult = { protocol: PROTOCOL_VERSION, version: VERSION, pid: process.pid };
        this.respond(request.id, hello);
        return;
      }
      case "list":
        this.respond(
          request.id,
          [...this.context.sessions.values()].map((session) => session.info()),
        );
        return;
      case "create":
        this.respond(request.id, this.context.create(request).info());
        return;
      case "input": {
        const data = request.binary ? Buffer.from(request.data, "latin1") : request.data;
        this.session(request.session).writeInput(data);
        return;
      }
      case "subscribe": {
        const session = this.session(request.session);
        this.subscriptions.add(session);
        session.subscribe(this, (snapshot) => this.respond(request.id, snapshot));
        return;
      }
      case "snapshot":
        this.session(request.session).snapshot((snapshot) => this.respond(request.id, snapshot));
        return;
      case "unsubscribe": {
        const session = this.context.sessions.get(request.session);
        if (session) {
          session.unsubscribe(this);
          this.subscriptions.delete(session);
        }
        this.respond(request.id, null);
        return;
      }
      case "focus":
        this.session(request.session).setFocus(`${this.id}:${request.client}`, request.focused);
        return;
      case "close":
        this.context.close(request.session);
        this.respond(request.id, null);
        return;
    }
  }
}

function listenUnix(
  socketPath: string,
  handlers: Parameters<typeof Bun.listen<Connection>>[0]["socket"],
): ReturnType<typeof Bun.listen<Connection>> {
  try {
    return Bun.listen<Connection>({ unix: socketPath, socket: handlers });
  } catch (error) {
    // Some network filesystems refuse to create socket files.
    const where = networkFilesystem(dirname(socketPath));
    const hint = where
      ? `The state directory is on ${where}, which may not allow socket files. `
      : "";
    throw new Error(
      `cannot create the daemon socket ${socketPath}: ${(error as Error).message}\n${hint}` +
        "Put the state directory on a local disk: `workstreams config state-dir /local/path`.",
    );
  }
}

function defaultShellArgv(): string[] {
  let shell = process.env.SHELL;
  if (!shell) {
    try {
      shell = userInfo().shell ?? undefined;
    } catch {
      shell = undefined;
    }
  }
  // A login shell loads the user's profile, which also fixes the minimal PATH systemd gives services.
  return [shell || "/bin/sh", "-l"];
}

function resolveCwd(requested: string | undefined): string {
  const home = homedir();
  if (!requested?.trim()) return home;
  const expanded = requested.trim().replace(/^~(?=$|\/)/, home);
  const path = resolve(home, expanded);
  let isDirectory = false;
  try {
    isDirectory = statSync(path).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) throw new Error(`not a directory: ${path}`);
  return path;
}

function clampInt(value: unknown, min: number, max: number): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) throw new Error(`invalid size: ${String(value)}`);
  return Math.min(max, Math.max(min, n));
}

function newSessionId(existing: Map<string, Session>): string {
  for (;;) {
    const id = randomBytes(4).toString("hex");
    if (!existing.has(id)) return id;
  }
}

async function isListening(socketPath: string): Promise<boolean> {
  try {
    const socket = await Bun.connect({ unix: socketPath, socket: { data() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}
