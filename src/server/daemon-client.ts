// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import type { Socket } from "bun";
import {
  type DaemonEvent,
  type DaemonMessage,
  type DaemonRequest,
  type DaemonResponse,
  decodeJson,
  decodeOutputPayload,
  encodeJsonFrame,
  FrameDecoder,
  type HelloResult,
  KIND_OUTPUT,
  PROTOCOL_VERSION,
} from "../common/protocol.ts";
import { QueuedWriter } from "../common/socket.ts";

export interface DaemonClientEvents {
  onConnected(hello: HelloResult): void;
  onDisconnected(): void;
  onEvent(event: DaemonEvent): void;
  /** `payload` is the raw output payload, forwarded to browsers as-is. */
  onOutput(payload: Uint8Array, sessionId: string, offset: number): void;
}

const MAX_BACKLOG = 64 * 1024 * 1024;

/** The server's single connection to the daemon. Reconnects until stopped. */
export class DaemonClient {
  private socket: Socket<undefined> | null = null;
  private writer: QueuedWriter | null = null;
  private ready = false;
  private stopped = false;
  private nextId = 1;
  private readonly pending = new Map<number, (response: DaemonResponse) => void>();

  constructor(
    private readonly socketPath: string,
    private readonly events: DaemonClientEvents,
    private readonly log: (message: string) => void,
  ) {}

  get connected(): boolean {
    return this.ready;
  }

  start(): void {
    void this.connectLoop();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.end();
  }

  /**
   * Sends a request. Without a callback it is one-way (id 0) and the daemon does not answer.
   * The callback runs synchronously in frame order: output frames decoded after the
   * response have not been delivered yet. Snapshot handling depends on this.
   */
  request(request: DaemonRequest, callback?: (response: DaemonResponse) => void): void {
    if (!this.writer) {
      callback?.({ t: "res", id: 0, ok: false, error: "daemon not connected" });
      return;
    }
    const id = callback ? this.nextId++ : 0;
    if (callback) this.pending.set(id, callback);
    this.writer.send(encodeJsonFrame({ ...request, t: "req", id }));
  }

  call<T>(request: DaemonRequest): Promise<T> {
    return new Promise((resolve, reject) => {
      this.request(request, (response) => {
        if (response.ok) resolve(response.result as T);
        else reject(new Error(response.error));
      });
    });
  }

  private async connectLoop(): Promise<void> {
    let delay = 100;
    while (!this.stopped) {
      try {
        await this.connectOnce();
        return;
      } catch {
        await Bun.sleep(delay);
        delay = Math.min(delay * 2, 2000);
      }
    }
  }

  private async connectOnce(): Promise<void> {
    const decoder = new FrameDecoder((kind, payload) => this.onFrame(kind, payload));
    const socket = await Bun.connect({
      unix: this.socketPath,
      socket: {
        data: (sock, chunk) => {
          try {
            decoder.push(chunk);
          } catch (error) {
            this.log(`bad frame from daemon: ${(error as Error).message}`);
            sock.end();
          }
        },
        drain: () => this.writer?.drain(),
        close: () => this.onClose(),
        error: (_sock, error) => this.log(`daemon socket error: ${error.message}`),
      },
    });
    if (this.stopped) {
      socket.end();
      return;
    }
    this.socket = socket;
    this.writer = new QueuedWriter(socket, MAX_BACKLOG, () => socket.end());
    this.request({ op: "hello", protocol: PROTOCOL_VERSION, client: "spectraweaver-server" }, (response) => {
      const hello = response.ok ? (response.result as HelloResult) : null;
      if (!hello || hello.protocol !== PROTOCOL_VERSION) {
        this.log(`daemon speaks protocol ${hello?.protocol ?? "?"}, expected ${PROTOCOL_VERSION}`);
        socket.end();
        return;
      }
      this.ready = true;
      this.events.onConnected(hello);
    });
  }

  private onClose(): void {
    const wasReady = this.ready;
    this.socket = null;
    this.writer = null;
    this.ready = false;
    const callbacks = [...this.pending.values()];
    this.pending.clear();
    for (const callback of callbacks) callback({ t: "res", id: 0, ok: false, error: "daemon disconnected" });
    if (wasReady) this.events.onDisconnected();
    if (!this.stopped) void this.connectLoop();
  }

  private onFrame(kind: number, payload: Uint8Array): void {
    if (kind === KIND_OUTPUT) {
      const { sessionId, offset } = decodeOutputPayload(payload);
      this.events.onOutput(payload, sessionId, offset);
      return;
    }
    const message = decodeJson<DaemonMessage>(payload);
    if (message.t === "evt") {
      this.events.onEvent(message.ev);
      return;
    }
    const callback = this.pending.get(message.id);
    if (callback) {
      this.pending.delete(message.id);
      callback(message);
    }
  }
}
