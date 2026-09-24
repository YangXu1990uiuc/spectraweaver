// Copyright 2026 The workstreams Authors
// SPDX-License-Identifier: Apache-2.0
// Part of workstreams: https://github.com/YangXu1990uiuc/workstreams

interface WritableSocket {
  write(data: Uint8Array): number;
}

/**
 * Preserves frame order on a Bun socket. `socket.write` may accept only part of a buffer;
 * the rest waits here until the socket drains.
 */
export class QueuedWriter {
  private queue: Uint8Array[] = [];
  private queuedBytes = 0;

  constructor(
    private readonly socket: WritableSocket,
    private readonly maxQueuedBytes: number,
    private readonly onOverflow: () => void,
  ) {}

  get backlog(): number {
    return this.queuedBytes;
  }

  send(frame: Uint8Array): void {
    let rest = frame;
    if (this.queue.length === 0) {
      const written = this.socket.write(rest);
      if (written >= rest.length) return;
      rest = rest.subarray(Math.max(written, 0));
    }
    this.queue.push(rest);
    this.queuedBytes += rest.length;
    if (this.queuedBytes > this.maxQueuedBytes) this.onOverflow();
  }

  drain(): void {
    while (this.queue.length > 0) {
      const head = this.queue[0]!;
      const written = this.socket.write(head);
      if (written < 0) return;
      if (written < head.length) {
        this.queue[0] = head.subarray(written);
        this.queuedBytes -= written;
        return;
      }
      this.queue.shift();
      this.queuedBytes -= head.length;
    }
  }
}
