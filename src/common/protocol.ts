// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

// Wire formats shared by the daemon, the server and the browser. This module must stay
// free of Node/Bun-only imports because the browser bundle uses it too.
//
// Daemon socket frames: u32 length (big-endian, counts kind + payload) | u8 kind | payload.
// Output payloads have the same layout on the daemon socket and on the browser WebSocket,
// so the server forwards them untouched: u8 idLength | id (UTF-8) | f64 offset | bytes.

export const PROTOCOL_VERSION = 1;
export const KIND_JSON = 1;
export const KIND_OUTPUT = 2;
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export interface SessionInfo {
  id: string;
  cmd: string | null;
  cwd: string;
  cols: number;
  rows: number;
  pid: number;
  createdAt: number;
  title: string;
  exited: { code: number | null; signal: string | null; at: number } | null;
}

export interface Snapshot {
  session: string;
  /** Stream offset the snapshot corresponds to; live output continues from here. */
  offset: number;
  cols: number;
  rows: number;
  data: string;
}

// ---- server -> daemon ------------------------------------------------------------------

export type DaemonRequest =
  | { op: "hello"; protocol: number; client: string }
  | { op: "list" }
  /** `tag` is opaque to the daemon and echoed in the "created" event (the server puts a tab id there). */
  | { op: "create"; cols: number; rows: number; cwd?: string; cmd?: string; tag?: string }
  | { op: "input"; session: string; data: string; binary?: boolean }
  | { op: "subscribe"; session: string }
  | { op: "snapshot"; session: string }
  | { op: "unsubscribe"; session: string }
  | { op: "focus"; session: string; client: string; focused: boolean }
  | { op: "close"; session: string };

/** Requests with id 0 are one-way: the daemon never answers them. */
export type DaemonRequestFrame = DaemonRequest & { t: "req"; id: number };

export type DaemonEvent =
  | { type: "created"; session: SessionInfo; tag?: string }
  | { type: "exited"; session: string; code: number | null; signal: string | null }
  | { type: "removed"; session: string }
  | { type: "title"; session: string; title: string }
  | { type: "bell"; session: string }
  | { type: "notify"; session: string; kind: "osc9" | "osc777"; text: string }
  | { type: "cwd"; session: string; cwd: string };

export type DaemonResponse =
  | { t: "res"; id: number; ok: true; result?: unknown }
  | { t: "res"; id: number; ok: false; error: string };

export type DaemonMessage = DaemonResponse | { t: "evt"; ev: DaemonEvent };

export interface HelloResult {
  protocol: number;
  version: string;
  pid: number;
}

// ---- browser <-> server ----------------------------------------------------------------

export interface SessionView extends SessionInfo {
  banner: string;
  /** The tab (workspace) this session belongs to. */
  tab: string;
}

export interface TabView {
  id: string;
  name: string;
  color: string;
  /** Tiles per screen in matrix order, "rowsxcols": "2x3" is 2 rows of 3 tiles. */
  grid: string;
}

export const TAB_COLORS = [
  "#8b8b8b",
  "#f14c4c",
  "#f5a623",
  "#cca700",
  "#2ea043",
  "#26a69a",
  "#3794ff",
  "#b180d7",
  "#e36fa8",
] as const;

export const GRID_PATTERN = /^[1-9]x[1-9]$/;

export type ClientMessage =
  | { t: "sub"; session: string }
  | { t: "unsub"; session: string }
  | { t: "input"; session: string; data: string; binary?: boolean }
  | { t: "focus"; session: string; focused: boolean }
  | { t: "create"; cols: number; rows: number; cwd?: string; cmd?: string; tab?: string }
  | { t: "close"; session: string }
  | { t: "banner"; session: string; banner: string }
  | { t: "session-move"; session: string; tab: string }
  | { t: "tab-create"; id: string; name: string; color: string; grid: string }
  | { t: "tab-update"; id: string; name?: string; color?: string; grid?: string }
  | { t: "tab-delete"; id: string }
  | { t: "tab-move"; id: string; index: number };

export type ServerMessage =
  | { t: "hello"; version: string }
  | { t: "daemon"; up: boolean }
  | { t: "tabs"; tabs: TabView[] }
  | { t: "sessions"; sessions: SessionView[] }
  | { t: "session"; session: SessionView }
  | { t: "removed"; session: string }
  | { t: "snapshot"; snapshot: Snapshot }
  | { t: "bell"; session: string }
  | { t: "error"; message: string };

// ---- terminal theme --------------------------------------------------------------------

/** The daemon answers OSC 10/11/12 colour queries with these, so they must match the UI. */
export const THEME = {
  foreground: "#cccccc",
  background: "#1f1f1f",
  cursor: "#aeafad",
} as const;

// ---- encoding --------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function withHeader(kind: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  new DataView(frame.buffer).setUint32(0, 1 + payload.length);
  frame[4] = kind;
  frame.set(payload, 5);
  return frame;
}

export function encodeJsonFrame(message: unknown): Uint8Array {
  return withHeader(KIND_JSON, encoder.encode(JSON.stringify(message)));
}

export function encodeOutputPayload(sessionId: string, offset: number, data: Uint8Array): Uint8Array {
  const id = encoder.encode(sessionId);
  if (id.length > 255) throw new Error("session id too long");
  const payload = new Uint8Array(1 + id.length + 8 + data.length);
  payload[0] = id.length;
  payload.set(id, 1);
  new DataView(payload.buffer).setFloat64(1 + id.length, offset);
  payload.set(data, 1 + id.length + 8);
  return payload;
}

export function encodeOutputFrame(sessionId: string, offset: number, data: Uint8Array): Uint8Array {
  return withHeader(KIND_OUTPUT, encodeOutputPayload(sessionId, offset, data));
}

export interface OutputPayload {
  sessionId: string;
  offset: number;
  data: Uint8Array;
}

export function decodeOutputPayload(payload: Uint8Array): OutputPayload {
  const idLength = payload[0] ?? 0;
  if (payload.length < 1 + idLength + 8) throw new Error("truncated output payload");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    sessionId: decoder.decode(payload.subarray(1, 1 + idLength)),
    offset: view.getFloat64(1 + idLength),
    data: payload.subarray(1 + idLength + 8),
  };
}

export function decodeJson<T>(payload: Uint8Array): T {
  return JSON.parse(decoder.decode(payload)) as T;
}

/** Splits a byte stream into frames. Payloads handed to the callback are fresh copies. */
export class FrameDecoder {
  private pending: Uint8Array = new Uint8Array(0);

  constructor(private readonly onFrame: (kind: number, payload: Uint8Array) => void) {}

  push(chunk: Uint8Array): void {
    let buffer = chunk;
    if (this.pending.length > 0) {
      buffer = new Uint8Array(this.pending.length + chunk.length);
      buffer.set(this.pending, 0);
      buffer.set(chunk, this.pending.length);
    }
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    let offset = 0;
    while (buffer.length - offset >= 4) {
      const length = view.getUint32(offset);
      if (length < 1 || length > MAX_FRAME_BYTES) throw new Error(`invalid frame length ${length}`);
      if (buffer.length - offset - 4 < length) break;
      const kind = buffer[offset + 4]!;
      const payload = buffer.slice(offset + 5, offset + 4 + length);
      offset += 4 + length;
      this.onFrame(kind, payload);
    }
    this.pending = offset === buffer.length ? new Uint8Array(0) : buffer.slice(offset);
  }
}
