// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "../common/files.ts";
import { GRID_PATTERN, TAB_COLORS, type TabView, TILE_COLORS } from "../common/protocol.ts";

interface SessionMeta {
  banner?: string;
  tab?: string;
  color?: string;
}

interface MetaFile {
  version: 2;
  tabs: TabView[];
  sessions: Record<string, SessionMeta>;
}

const TAB_ID = /^[0-9a-f]{8}$/;
const COLOR = /^#[0-9a-f]{6}$/i;
const DEFAULT_TAB: TabView = { id: "00000000", name: "Main", color: "#3794ff", grid: "2x2" };

/**
 * Presentational state owned by the server: tabs (workspaces) and per-session banners,
 * colours and tab membership. There is always at least one tab; a session whose tab is missing belongs
 * to the first one.
 */
export class MetaStore {
  private data: MetaFile = { version: 2, tabs: [{ ...DEFAULT_TAB }], sessions: {} };
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly file: string) {
    if (!existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        version?: number;
        tabs?: TabView[];
        sessions?: Record<string, SessionMeta>;
      };
      const tabs = (parsed.tabs ?? []).filter((tab) => TAB_ID.test(tab.id));
      this.data = {
        version: 2,
        tabs: tabs.length > 0 ? tabs : [{ ...DEFAULT_TAB }],
        sessions: parsed.sessions ?? {}, // version 1 files carry banners only
      };
    } catch {
      // A corrupt file only loses banners and tabs; start fresh.
    }
  }

  tabs(): TabView[] {
    return this.data.tabs.map((tab) => ({ ...tab }));
  }

  hasTab(id: string): boolean {
    return this.data.tabs.some((tab) => tab.id === id);
  }

  banner(sessionId: string): string {
    return this.data.sessions[sessionId]?.banner ?? "";
  }

  tabOf(sessionId: string): string {
    const tab = this.data.sessions[sessionId]?.tab;
    return tab && this.hasTab(tab) ? tab : this.data.tabs[0]!.id;
  }

  setBanner(sessionId: string, banner: string): void {
    this.patchSession(sessionId, { banner });
  }

  /**
   * The session's colour. The first time, it takes the colour least used by the other live
   * sessions in its tab, so a tab's tiles differ at a glance; after that it keeps it.
   */
  colorOf(sessionId: string, liveIds: Iterable<string>): string {
    const stored = this.data.sessions[sessionId]?.color;
    if (stored) return stored;
    const color = this.leastUsedColor(sessionId, liveIds);
    this.patchSession(sessionId, { color });
    return color;
  }

  /** Moves a session to a tab. It keeps its colour unless a session there already has it. */
  setSessionTab(sessionId: string, tabId: string, liveIds: Iterable<string> = []): boolean {
    if (!this.hasTab(tabId)) return false;
    this.patchSession(sessionId, { tab: tabId });
    this.keepColorDistinct(sessionId, [...liveIds]);
    return true;
  }

  createTab(tab: TabView): boolean {
    if (!TAB_ID.test(tab.id) || this.hasTab(tab.id)) return false;
    this.data.tabs.push({
      id: tab.id,
      name: cleanName(tab.name) || "New tab",
      color: COLOR.test(tab.color) ? tab.color : TAB_COLORS[0],
      grid: GRID_PATTERN.test(tab.grid) ? tab.grid : DEFAULT_TAB.grid,
    });
    this.scheduleSave();
    return true;
  }

  updateTab(id: string, patch: { name?: string; color?: string; grid?: string }): boolean {
    const tab = this.data.tabs.find((candidate) => candidate.id === id);
    if (!tab) return false;
    if (patch.name !== undefined && cleanName(patch.name)) tab.name = cleanName(patch.name);
    if (patch.color !== undefined && COLOR.test(patch.color)) tab.color = patch.color;
    if (patch.grid !== undefined && GRID_PATTERN.test(patch.grid)) tab.grid = patch.grid;
    this.scheduleSave();
    return true;
  }

  /**
   * Removes a tab and moves its sessions to the neighbouring tab; processes are never
   * touched. Returns the ids of the moved sessions, or null if the tab cannot be deleted.
   */
  deleteTab(id: string, liveSessionIds: Iterable<string>): string[] | null {
    const index = this.data.tabs.findIndex((tab) => tab.id === id);
    if (index < 0 || this.data.tabs.length === 1) return null;
    const neighbour = this.data.tabs[index > 0 ? index - 1 : 1]!.id;
    const live = [...liveSessionIds];
    const moved: string[] = [];
    for (const sessionId of live) {
      if (this.tabOf(sessionId) === id) {
        this.patchSession(sessionId, { tab: neighbour });
        this.keepColorDistinct(sessionId, live);
        moved.push(sessionId);
      }
    }
    this.data.tabs.splice(index, 1);
    this.scheduleSave();
    return moved;
  }

  moveTab(id: string, toIndex: number): boolean {
    const from = this.data.tabs.findIndex((tab) => tab.id === id);
    if (from < 0 || !Number.isInteger(toIndex)) return false;
    const [tab] = this.data.tabs.splice(from, 1);
    this.data.tabs.splice(Math.max(0, Math.min(toIndex, this.data.tabs.length)), 0, tab!);
    this.scheduleSave();
    return true;
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
    writeFileAtomic(this.file, JSON.stringify(this.data, null, 2));
  }

  private keepColorDistinct(sessionId: string, liveIds: string[]): void {
    const color = this.data.sessions[sessionId]?.color;
    if (!color) return;
    const tab = this.tabOf(sessionId);
    const taken = liveIds.some(
      (id) => id !== sessionId && this.tabOf(id) === tab && this.data.sessions[id]?.color === color,
    );
    if (taken) this.patchSession(sessionId, { color: this.leastUsedColor(sessionId, liveIds) });
  }

  private leastUsedColor(sessionId: string, liveIds: Iterable<string>): string {
    const tab = this.tabOf(sessionId);
    const uses = new Map(TILE_COLORS.map((color) => [color, 0]));
    for (const id of liveIds) {
      const color = this.data.sessions[id]?.color;
      if (id !== sessionId && color !== undefined && uses.has(color) && this.tabOf(id) === tab) {
        uses.set(color, uses.get(color)! + 1);
      }
    }
    const fewest = Math.min(...uses.values());
    return TILE_COLORS.find((color) => uses.get(color) === fewest)!;
  }

  private patchSession(sessionId: string, patch: SessionMeta): void {
    this.data.sessions[sessionId] = { ...this.data.sessions[sessionId], ...patch };
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 100);
  }
}

function cleanName(name: string): string {
  return String(name).replace(/\s+/g, " ").trim().slice(0, 60);
}
