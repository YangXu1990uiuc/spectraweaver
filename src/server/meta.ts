// Copyright 2026 The workstreams Authors
// SPDX-License-Identifier: Apache-2.0
// Part of workstreams: https://github.com/YangXu1990uiuc/workstreams

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

interface MetaFile {
  version: 1;
  sessions: Record<string, { banner: string }>;
}

/** Presentational per-session data owned by the server (banners for now). */
export class MetaStore {
  private data: MetaFile = { version: 1, sessions: {} };
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly file: string) {
    if (!existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as MetaFile;
      if (parsed.version === 1 && parsed.sessions) this.data = parsed;
    } catch {
      // A corrupt file only loses banners; start fresh.
    }
  }

  banner(sessionId: string): string {
    return this.data.sessions[sessionId]?.banner ?? "";
  }

  setBanner(sessionId: string, banner: string): void {
    this.data.sessions[sessionId] = { banner };
    this.scheduleSave();
  }

  forget(sessionId: string): void {
    if (!(sessionId in this.data.sessions)) return;
    delete this.data.sessions[sessionId];
    this.scheduleSave();
  }

  /** Drops metadata of sessions the daemon no longer has. */
  prune(liveIds: Set<string>): void {
    for (const id of Object.keys(this.data.sessions)) if (!liveIds.has(id)) this.forget(id);
  }

  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 100);
  }
}
