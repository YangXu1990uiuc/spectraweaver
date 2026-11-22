// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import type { Subprocess } from "bun";
import { sessionEnv } from "../common/env.ts";
import { type DaemonEvent, MAX_FRAME_BYTES, type ScreenText, type SessionInfo, type Snapshot } from "../common/protocol.ts";
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
/** Room for a snapshot in one frame, leaving some for the rest of the message. */
const SNAPSHOT_MAX_BYTES = MAX_FRAME_BYTES - 64 * 1024;
/** Titles and notification texts are cut to this many characters. */
const MAX_TEXT = 1000;

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
  private lastOutputAt: number | null = null;
  private disposed = false;
  /** The size last asked for (resize), which the engine and the program reach in order. */
  private target: { cols: number; rows: number };

  constructor(private readonly options: SessionOptions) {
    this.id = options.id;
    this.target = { cols: options.cols, rows: options.rows };
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
        // Programs set these at will (a shell at every prompt), and they reach every browser:
        // kept short, and sent only when they change.
        onTitle: (raw) => {
          const title = raw.slice(0, MAX_TEXT);
          if (title === this.state.title) return;
          this.state.title = title;
          emit({ type: "title", session: this.id, title });
        },
        onBell: () => emit({ type: "bell", session: this.id }),
        onNotify: (kind, text) => emit({ type: "notify", session: this.id, kind, text: text.slice(0, MAX_TEXT) }),
        onCwd: (raw) => {
          const cwd = raw.slice(0, 4096);
          if (cwd === this.state.cwd) return;
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

  /**
   * Adds a subscriber once the engine has parsed everything received so far, with a snapshot of
   * that point. If `wanted` says no by then (an unsubscribe came first), the snapshot is still
   * answered but nothing more is sent.
   */
  subscribe(subscriber: Subscriber, onSnapshot: (snapshot: Snapshot) => void, wanted: () => boolean = () => true): void {
    this.engine.write("", () => {
      if (subscriber.closed) return;
      if (wanted() && !this.disposed) this.subscribers.add(subscriber);
      onSnapshot(this.snapshotNow());
    });
  }

  snapshot(onSnapshot: (snapshot: Snapshot) => void): void {
    this.engine.write("", () => onSnapshot(this.snapshotNow()));
  }

  /** The terminal's last `rows` rows as text, once the engine has parsed everything received so far. */
  text(rows: number, done: (text: ScreenText) => void): void {
    this.engine.write("", () =>
      done({
        session: this.id,
        cols: this.state.cols,
        rows: this.state.rows,
        lines: this.disposed ? [] : this.engine.text(rows),
        altScreen: this.engine.altScreen,
        bracketedPaste: this.engine.bracketedPaste,
        lastOutputAt: this.lastOutputAt,
      }),
    );
  }

  unsubscribe(subscriber: Subscriber): void {
    this.subscribers.delete(subscriber);
  }

  /**
   * Changes the session's size. The program is told (SIGWINCH) and redraws. The engine takes the
   * new grid in a write callback, at the point of the output stream it has reached, and the
   * "resized" event and `done` follow there: a snapshot asked for afterwards (the server asks one
   * for every viewer) shows the new grid, and what the program prints in answer to the signal is
   * read in a later turn of the event loop, so the engine parses it at the new size.
   */
  resize(cols: number, rows: number, done: (info: SessionInfo) => void): void {
    if (this.state.exited) throw new Error("the session has exited");
    // Against the size last asked for, not the one applied: a second resize sent before the
    // first is applied must not be taken for no change. Answered in order either way.
    if (cols === this.target.cols && rows === this.target.rows) {
      this.engine.write("", () => done(this.info()));
      return;
    }
    this.target = { cols, rows };
    this.engine.write("", () => {
      this.engine.resize(cols, rows);
      this.state.cols = cols;
      this.state.rows = rows;
      this.options.emit({ type: "resized", session: this.id, cols, rows });
      done(this.info());
    });
    const terminal = this.proc.terminal;
    if (terminal && !terminal.closed) terminal.resize(cols, rows);
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
    if (this.state.exited || this.killTimer) return;
    this.proc.kill("SIGHUP");
    this.killTimer = setTimeout(() => this.proc.kill("SIGKILL"), KILL_GRACE_MS);
  }

  dispose(): void {
    this.disposed = true;
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
    const snapshot = { session: this.id, offset: this.offset, cols: this.state.cols, rows: this.state.rows, data: "" };
    // A request queued before the session was removed finds its engine gone: nothing to show.
    if (this.disposed) return snapshot;
    snapshot.data = this.engine.serialize();
    // The snapshot travels in one frame, where JSON writes each control character as six bytes:
    // a full scrollback of richly coloured text can pass the limit. Less scrollback then.
    for (const lines of [2000, 200, 0]) {
      if (snapshot.data.length * 6 < SNAPSHOT_MAX_BYTES) break;
      if (Buffer.byteLength(JSON.stringify(snapshot.data)) < SNAPSHOT_MAX_BYTES) break;
      snapshot.data = this.engine.serialize(lines);
    }
    return snapshot;
  }

  private reportFocusChange(before: boolean): void {
    const after = this.focused.size > 0;
    if (before !== after && this.engine.sendFocusMode) this.writeInput(after ? "\x1b[I" : "\x1b[O");
  }

  private onPtyData(data: Uint8Array): void {
    // Copy: the engine queues chunks and Bun may reuse the read buffer.
    const chunk = data.slice();
    this.lastOutputAt = Date.now();
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
