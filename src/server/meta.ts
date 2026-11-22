// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "../common/files.ts";
import type { Revival } from "./revival.ts";
import {
  type Board,
  type Frame,
  GRID_PATTERN,
  normalizeFrame,
  TAB_COLORS,
  type TabView,
  TILE_COLORS,
} from "../common/protocol.ts";

interface SessionMeta {
  banner?: string;
  tab?: string;
  color?: string;
  /** The session's window in its tab; absent until the user places it. */
  frame?: Frame;
  /** Its window is put away in the tab's taskbar. */
  hidden?: true;
  /** What would bring the terminal back, noted while it runs. */
  revival?: Revival;
  /** The terminal was lost when its daemon stopped, and waits to be restored or forgotten. */
  lost?: true;
}

interface MetaFile {
  version: 2;
  tabs: TabView[];
  sessions: Record<string, SessionMeta>;
  /** The daemon run the sessions belong to (HelloResult.instance). */
  daemon?: string;
  /** The flags each agent was last seen running with, shell-quoted. */
  agentFlags?: Record<string, string>;
}

const TAB_ID = /^[0-9a-f]{8}$/;
const COLOR = /^#[0-9a-f]{6}$/i;
const DEFAULT_TAB: TabView = { id: "00000000", name: "Main", color: "#3794ff", grid: "2x2" };

/**
 * Presentational state owned by the server: tabs (workspaces) and per-session banners,
 * colours, tab membership and window frames. There is always at least one tab; a session whose
 * tab is missing belongs to the first one.
 */
export class MetaStore {
  private data: MetaFile = { version: 2, tabs: [{ ...DEFAULT_TAB }], sessions: {} };
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly file: string) {
    if (!existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<MetaFile>;
      const tabs = (parsed.tabs ?? []).filter((tab) => TAB_ID.test(tab.id)).map(withSaneBoard);
      this.data = {
        version: 2,
        tabs: tabs.length > 0 ? tabs : [{ ...DEFAULT_TAB }],
        sessions: parsed.sessions ?? {}, // version 1 files carry banners only
        daemon: typeof parsed.daemon === "string" ? parsed.daemon : undefined,
        agentFlags: parsed.agentFlags ?? {},
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

  revival(sessionId: string): Revival | undefined {
    const revival = this.data.sessions[sessionId]?.revival;
    return typeof revival?.cwd === "string" ? revival : undefined;
  }

  /** Notes what would bring a live terminal back; written only when it changed. */
  setRevival(sessionId: string, revival: Revival | undefined): void {
    if (JSON.stringify(this.data.sessions[sessionId]?.revival) === JSON.stringify(revival)) return;
    if (revival || this.data.sessions[sessionId]) this.patchSession(sessionId, { revival });
  }

  /** Lost terminals, in the order they were created. */
  lostIds(): string[] {
    return Object.keys(this.data.sessions).filter((id) => this.isLost(id));
  }

  isLost(sessionId: string): boolean {
    return this.data.sessions[sessionId]?.lost === true && this.revival(sessionId) !== undefined;
  }

  /**
   * Brings the stored sessions in line with the daemon's. A session the daemon does not have
   * was closed while the server was away, unless the daemon is a new one: then it was lost, and
   * is kept to be restored if there is anything to restore it from.
   */
  reconcile(liveIds: Set<string>, daemon: string): void {
    const restarted = this.data.daemon !== undefined && this.data.daemon !== daemon;
    for (const id of Object.keys(this.data.sessions)) {
      if (liveIds.has(id) || this.data.sessions[id]!.lost) continue;
      if (restarted && this.revival(id)) this.patchSession(id, { lost: true });
      else this.forget(id);
    }
    if (this.data.daemon !== daemon) {
      this.data.daemon = daemon;
      this.scheduleSave();
    }
  }

  /** Gives a restored terminal the tab, colour, banner and window of the lost one, which goes. */
  adopt(sessionId: string, lostId: string): void {
    const lost = this.data.sessions[lostId];
    if (!lost) return;
    this.patchSession(sessionId, {
      tab: lost.tab,
      color: lost.color,
      banner: lost.banner,
      frame: lost.frame,
      hidden: lost.hidden,
    });
    this.forget(lostId);
  }

  agentFlags(): Record<string, string> {
    return { ...this.data.agentFlags };
  }

  setAgentFlags(agent: string, flags: string): void {
    this.data.agentFlags ??= {};
    if (this.data.agentFlags[agent] === flags) return;
    this.data.agentFlags[agent] = flags;
    this.scheduleSave();
  }

  frameOf(sessionId: string): Frame | undefined {
    return this.data.sessions[sessionId]?.frame;
  }

  hiddenOf(sessionId: string): boolean {
    return this.data.sessions[sessionId]?.hidden === true;
  }

  /** Puts a session's window away in the taskbar, or brings it back. */
  setHidden(sessionId: string, hidden: boolean): void {
    if (this.hiddenOf(sessionId) === hidden) return;
    this.patchSession(sessionId, { hidden: hidden ? true : undefined });
  }

  board(tabId: string): Board | undefined {
    return this.data.tabs.find((tab) => tab.id === tabId)?.board;
  }

  /**
   * Stores a tab's board (checked by parseBoard). The first board a tab gets opens its window;
   * true then, so the server can lay the tab out for it.
   */
  setBoard(tabId: string, board: Board): boolean {
    const tab = this.data.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return false;
    const first = tab.board === undefined;
    tab.board = board;
    if (first) tab.boardWindow = { ...tab.boardWindow, open: true };
    this.scheduleSave();
    return first;
  }

  /** Removes a tab's board and closes its window. */
  clearBoard(tabId: string): boolean {
    const tab = this.data.tabs.find((candidate) => candidate.id === tabId);
    if (!tab?.board) return false;
    delete tab.board;
    if (tab.boardWindow) tab.boardWindow = { ...tab.boardWindow, open: false };
    this.scheduleSave();
    return true;
  }

  /**
   * Opens or puts away a tab's board window, places it, or sets which way its graph runs ("auto":
   * whichever fits); false if nothing valid was asked.
   */
  setBoardWindow(tabId: string, patch: { open?: unknown; frame?: unknown; direction?: unknown }): boolean {
    const tab = this.data.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return false;
    const next = { ...(tab.boardWindow ?? { open: false }) };
    let changed = false;
    if (typeof patch.open === "boolean") {
      next.open = patch.open;
      changed = true;
    }
    if (patch.frame !== undefined) {
      const frame = normalizeFrame(patch.frame);
      if (frame) {
        next.frame = frame;
        changed = true;
      }
    }
    if (patch.direction === "down" || patch.direction === "right") {
      next.direction = patch.direction;
      changed = true;
    } else if (patch.direction === "auto") {
      delete next.direction;
      changed = true;
    }
    if (!changed) return false;
    tab.boardWindow = next;
    this.scheduleSave();
    return true;
  }

  /** Places a session's window; false if the frame is malformed (it is checked, not trusted). */
  setSessionFrame(sessionId: string, frame: unknown): boolean {
    const normalized = normalizeFrame(frame);
    if (!normalized) return false;
    this.patchSession(sessionId, { frame: normalized });
    return true;
  }

  /**
   * Moves a session to a tab. It keeps its colour unless a session there already has it, and
   * loses its window frame: a frame belongs to the arrangement of the tab it was placed in.
   */
  setSessionTab(sessionId: string, tabId: string, liveIds: Iterable<string> = []): boolean {
    if (!this.hasTab(tabId)) return false;
    this.placeInTab(sessionId, tabId);
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
        this.placeInTab(sessionId, neighbour);
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

  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    writeFileAtomic(this.file, JSON.stringify(this.data, null, 2));
  }

  /**
   * A session arriving in another tab has no window there yet, and shows; one already in the tab
   * keeps its frame.
   */
  private placeInTab(sessionId: string, tabId: string): void {
    if (this.tabOf(sessionId) === tabId) return;
    this.patchSession(sessionId, { tab: tabId, frame: undefined, hidden: undefined });
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

/** A tab as read from meta.json, without a board or board window that is not well formed. */
function withSaneBoard(tab: TabView): TabView {
  const { board, boardWindow, ...rest } = tab;
  const sane: TabView = rest;
  if (board && Array.isArray(board.tasks) && typeof board.updatedAt === "number") sane.board = board;
  if (boardWindow && typeof boardWindow.open === "boolean") {
    const frame = boardWindow.frame && normalizeFrame(boardWindow.frame);
    sane.boardWindow = frame ? { open: boardWindow.open, frame } : { open: boardWindow.open };
    if (boardWindow.direction === "down" || boardWindow.direction === "right") sane.boardWindow.direction = boardWindow.direction;
  }
  return sane;
}

function cleanName(name: string): string {
  return String(name).replace(/\s+/g, " ").trim().slice(0, 60);
}
