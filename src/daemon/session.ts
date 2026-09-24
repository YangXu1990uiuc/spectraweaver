// Copyright 2026 The workstreams Authors
// SPDX-License-Identifier: Apache-2.0
// Part of workstreams: https://github.com/YangXu1990uiuc/workstreams

import type { Subprocess } from "bun";
import { sessionEnv } from "../common/env.ts";
import type { DaemonEvent, SessionInfo, Snapshot } from "../common/protocol.ts";
import { Engine } from "./engine.ts";

export interface Subscriber {
  readonly closed: boolean;
  sendOutput(sessionId: string, offset: number, data: Uint8Array): void;
}

export interface SessionOptions {
  id: string;
  cols: number;
  rows: number;
  cwd: string;
  /** Typed into the shell once it is ready, so the shell stays when the command exits. */
  cmd: string | null;
  argv: string[];
  env: Record<string, string | undefined>;
  scrollback: number;
  emit: (event: DaemonEvent) => void;
  onExited: (session: Session) => void;
}

const TYPE_AHEAD_QUIET_MS = 300;
const TYPE_AHEAD_FIRST_MS = 3000;
const TYPE_AHEAD_MAX_MS = 5000;
const KILL_GRACE_MS = 3000;

/**
 * One PTY plus its daemon-side terminal engine.
 *
 * Output is broadcast from the engine's write callback, after the engine has parsed it.
 * Snapshots are taken in a write callback too, so every subscriber sees one ordered stream
 * in which a snapshot at offset X is followed by exactly the bytes from X on.
 */
export class Session {
  readonly id: string;
  closing = false;
  private readonly state: SessionInfo;
  private readonly engine: Engine;
  private readonly proc: Subprocess;
  private offset = 0;
  private readonly subscribers = new Set<Subscriber>();
  private readonly focused = new Set<string>();
  private typeAhead: (() => void) | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: SessionOptions) {
    this.id = options.id;
    this.state = {
      id: options.id,
      cmd: options.cmd,
      cwd: options.cwd,
      cols: options.cols,
      rows: options.rows,
      pid: 0,
      createdAt: Date.now(),
      title: "",
      exited: null,
    };
    const emit = options.emit;
    this.engine = new Engine(
      {
        cols: options.cols,
        rows: options.rows,
        scrollback: options.scrollback,
        reply: (data) => this.writeInput(data),
      },
      {
        onTitle: (title) => {
          this.state.title = title;
          emit({ type: "title", session: this.id, title });
        },
        onBell: () => emit({ type: "bell", session: this.id }),
        onNotify: (kind, text) => emit({ type: "notify", session: this.id, kind, text }),
        onCwd: (cwd) => {
          this.state.cwd = cwd;
          emit({ type: "cwd", session: this.id, cwd });
        },
      },
    );
    this.proc = Bun.spawn(options.argv, {
      cwd: options.cwd,
      env: sessionEnv(options.env, options.id),
      terminal: {
        cols: options.cols,
        rows: options.rows,
        data: (_terminal, data) => this.onPtyData(data),
      },
      onExit: (proc, code) => this.onExit(code, proc.signalCode ?? null),
    });
    this.state.pid = this.proc.pid;
    if (options.cmd) this.scheduleTypeAhead(options.cmd);
  }

  get exited(): boolean {
    return this.state.exited !== null;
  }

  info(): SessionInfo {
    return { ...this.state, exited: this.state.exited && { ...this.state.exited } };
  }

  writeInput(data: string | Uint8Array): void {
    if (this.state.exited) return;
    this.proc.terminal?.write(data);
  }

  subscribe(subscriber: Subscriber, onSnapshot: (snapshot: Snapshot) => void): void {
    this.engine.write("", () => {
      if (subscriber.closed) return;
      this.subscribers.add(subscriber);
      onSnapshot(this.snapshotNow());
    });
  }

  snapshot(onSnapshot: (snapshot: Snapshot) => void): void {
    this.engine.write("", () => onSnapshot(this.snapshotNow()));
  }

  unsubscribe(subscriber: Subscriber): void {
    this.subscribers.delete(subscriber);
  }

  /**
   * Focus reports are aggregated across all viewers: the program sees "focused" while at
   * least one viewer has the session focused. Viewers' own focus reports are dropped.
   */
  setFocus(key: string, focused: boolean): void {
    const before = this.focused.size > 0;
    if (focused) this.focused.add(key);
    else this.focused.delete(key);
    this.reportFocusChange(before);
  }

  dropFocusWithPrefix(prefix: string): void {
    const before = this.focused.size > 0;
    for (const key of this.focused) if (key.startsWith(prefix)) this.focused.delete(key);
    this.reportFocusChange(before);
  }

  /** Ends the session: SIGHUP, then SIGKILL if the program ignores it. */
  terminate(): void {
    this.closing = true;
    if (this.state.exited) return;
    this.proc.kill("SIGHUP");
    this.killTimer = setTimeout(() => this.proc.kill("SIGKILL"), KILL_GRACE_MS);
  }

  dispose(): void {
    if (this.killTimer) clearTimeout(this.killTimer);
    if (!this.state.exited) this.proc.kill("SIGKILL");
    this.closePty();
    this.engine.dispose();
    this.subscribers.clear();
  }

  private closePty(): void {
    const terminal = this.proc.terminal;
    if (terminal && !terminal.closed) terminal.close();
  }

  private snapshotNow(): Snapshot {
    return {
      session: this.id,
      offset: this.offset,
      cols: this.state.cols,
      rows: this.state.rows,
      data: this.engine.serialize(),
    };
  }

  private reportFocusChange(before: boolean): void {
    const after = this.focused.size > 0;
    if (before !== after && this.engine.sendFocusMode) this.writeInput(after ? "\x1b[I" : "\x1b[O");
  }

  private onPtyData(data: Uint8Array): void {
    // Copy: the engine queues chunks and Bun may reuse the read buffer.
    const chunk = data.slice();
    this.typeAhead?.();
    this.engine.write(chunk, () => {
      const start = this.offset;
      this.offset += chunk.length;
      for (const subscriber of this.subscribers) subscriber.sendOutput(this.id, start, chunk);
    });
  }

  private onExit(code: number | null, signal: string | null): void {
    if (this.killTimer) clearTimeout(this.killTimer);
    this.typeAhead = null;
    this.state.exited = { code, signal, at: Date.now() };
    this.options.emit({ type: "exited", session: this.id, code, signal });
    // Let the last output drain from the PTY before closing it.
    setTimeout(() => this.closePty(), 100);
    this.options.onExited(this);
  }

  private scheduleTypeAhead(cmd: string): void {
    const deadline = Date.now() + TYPE_AHEAD_MAX_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fire = () => {
      clearTimeout(timer);
      this.typeAhead = null;
      this.writeInput(`${cmd}\r`);
    };
    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(fire, Math.max(0, Math.min(ms, deadline - Date.now())));
    };
    // Wait until the shell goes quiet after printing its prompt; shells that print nothing
    // get the command after TYPE_AHEAD_FIRST_MS.
    this.typeAhead = () => arm(TYPE_AHEAD_QUIET_MS);
    arm(TYPE_AHEAD_FIRST_MS);
  }
}
