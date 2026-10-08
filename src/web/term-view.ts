// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { ClipboardAddon, type IClipboardProvider } from "@xterm/addon-clipboard";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { type ClientMessage, type SessionView, type Snapshot, THEME } from "../common/protocol.ts";
import { loadSetting, saveSetting } from "./dom.ts";
import { installKeymap, type Platform } from "./keymap.ts";
import { suppressQueryReplies } from "./queries.ts";
import type { ResizeTarget } from "./resize-dialog.ts";
import { type ResizeGeometry, ResizeHandles } from "./resize.ts";
import { type Area, cellAt, cellsThatFit, fitTextPx, type FontMetrics, measureFont, zoomKeepingText } from "./sizing.ts";
import { SNAP_SLACK_PX } from "./windows.ts";

/**
 * Zoom is a fraction of the font size that exactly fills the tile; 1 is the maximum. Ctrl + / -
 * step through these; a resize that keeps the text size can land between them (keepTextSize).
 */
const ZOOM_STEPS = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3];
const MIN_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1]!;
const BASE_FONT_SIZE = 14;
const MIN_FONT_SIZE = 3;
const MAX_FONT_SIZE = 72;
/** How much larger Ctrl + = makes the text once it fills the tile, in CSS px per press. */
const TEXT_STEP_PX = 1;
/** A resize this tile asked for is forgotten after this long without the snapshot that applies it. */
const PENDING_RESIZE_MS = 10_000;
export const FONT_FAMILY =
  '"JetBrains Mono", "Cascadia Mono", "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace';

export interface TermViewOptions {
  session: SessionView;
  platform: Platform;
  useWebgl: boolean;
  send(message: ClientMessage): void;
  onFocusChange(focused: boolean): void;
  /** Shows the user a short message. */
  notify(message: string): void;
}

/**
 * Puts text a program sent with OSC 52 on the clipboard: Claude Code and Codex copy this
 * way what you select with the mouse inside them. navigator.clipboard exists only on HTTPS
 * and localhost. Elsewhere, a copy command still works shortly after a key press or click,
 * which is when programs answer one (Ctrl+C after selecting, or releasing the mouse).
 */
async function writeClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // For example, the page lost focus; try the copy command.
    }
  }
  let copied = false;
  const onCopy = (event: ClipboardEvent) => {
    event.clipboardData?.setData("text/plain", text);
    event.preventDefault();
    event.stopImmediatePropagation(); // before xterm.js copies its own (empty) selection
    copied = true;
  };
  window.addEventListener("copy", onCopy, { capture: true });
  try {
    document.execCommand("copy");
  } finally {
    window.removeEventListener("copy", onCopy, { capture: true });
  }
  return copied;
}

function openLink(uri: string): void {
  if (/^https?:\/\//i.test(uri)) window.open(uri, "_blank", "noopener,noreferrer");
}

/**
 * One session rendered in one tile. The terminal keeps the session's size until the session is
 * resized on purpose (requestResize); fitting the tile and zooming only change the font size
 * (DESIGN.md §4).
 */
export class TermView {
  readonly element: HTMLDivElement;
  private readonly term: Terminal;
  private readonly sessionId: string;
  private ready = false;
  private expectedOffset = 0;
  /** A fraction of the font that fills the tile, MIN_ZOOM..1. */
  private zoom: number;
  private focused = false;
  private fitScheduled = false;
  private resizeObserver: ResizeObserver | null = null;
  private webgl: WebglAddon | null = null;
  private paused = false;
  /** When the last snapshot request went out, until the snapshot arrives. */
  private awaitingSnapshotSince: number | null = null;
  private handles: ResizeHandles | null = null;
  private resizable = false;
  /** A resize this tile asked for, until the snapshot at the new size arrives. */
  private pendingResize: { cols: number; rows: number; textPx: number; at: number } | null = null;

  constructor(private readonly options: TermViewOptions) {
    const { session } = options;
    this.sessionId = session.id;
    this.zoom = loadZoom(session.id);
    this.element = document.createElement("div");
    this.element.className = "term-host";
    this.term = new Terminal({
      cols: session.cols,
      rows: session.rows,
      allowProposedApi: true,
      scrollback: 10_000,
      fontSize: BASE_FONT_SIZE,
      fontFamily: FONT_FAMILY,
      theme: { background: THEME.background, foreground: THEME.foreground, cursor: THEME.cursor },
      rightClickSelectsWord: options.platform === "mac",
      // Programs that use the mouse (Claude Code, Codex) take drags for themselves; holding
      // Shift (Option on macOS) selects in the terminal instead.
      macOptionClickForcesSelection: true,
      linkHandler: { activate: (_event, uri) => openLink(uri), allowNonHttpProtocols: false },
    });
  }

  get hasFocus(): boolean {
    return this.focused;
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.element);
    const term = this.term;
    term.open(this.element);
    this.handles = new ResizeHandles({
      host: this.element,
      geometry: () => this.geometry(),
      commit: (cols, rows) => this.requestResize(cols, rows),
      fill: () => this.fillTile(),
    });
    this.handles.setEnabled(this.resizable);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.loadAddon(new WebLinksAddon((_event, uri) => openLink(uri)));
    const forceSelection = this.options.platform === "mac" ? "Option" : "Shift";
    const clipboard: IClipboardProvider = {
      readText: () => "", // programs may set the clipboard, never read it
      writeText: async (_selection, text) => {
        if (await writeClipboard(text)) return;
        this.options.notify(
          `The browser blocked a program's copy. Hold ${forceSelection} while selecting to use the terminal's own selection, then copy.`,
        );
      },
    };
    term.loadAddon(new ClipboardAddon(undefined, clipboard));
    if (this.options.useWebgl) this.enableWebgl();
    suppressQueryReplies(term);
    installKeymap(term, this.options.platform, {
      zoom: (direction) => this.zoomStep(direction),
      send: (data) => this.sendInput(data),
    });

    term.onData((data) => {
      // Focus reports are aggregated by the daemon across all viewers (see focus messages).
      if (data === "\x1b[I" || data === "\x1b[O") return;
      this.sendInput(data);
    });
    term.onBinary((data) => this.options.send({ t: "input", session: this.sessionId, data, binary: true }));
    term.textarea?.addEventListener("focus", () => this.setFocused(true));
    term.textarea?.addEventListener("blur", () => this.setFocused(false));

    this.element.addEventListener("paste", (event) => this.onPaste(event), true);
    this.element.addEventListener("contextmenu", (event) => this.onContextMenu(event));
    this.element.addEventListener(
      "wheel",
      (event) => {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        event.stopPropagation();
        this.zoomStep(event.deltaY < 0 ? 1 : -1);
      },
      { passive: false, capture: true },
    );

    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.resizeObserver.observe(this.element);
    void document.fonts?.ready.then(() => this.scheduleFit());
    this.scheduleFit();
  }

  focus(): void {
    this.term.focus();
  }

  applySnapshot(snapshot: Snapshot): void {
    if (snapshot.cols !== this.term.cols || snapshot.rows !== this.term.rows) {
      // A resize this tile asked for keeps the text at the size it had, as a window keeps its
      // font when it is dragged larger or smaller; other tiles keep their zoom.
      const pending = this.pendingResize;
      this.pendingResize = null;
      const ours = pending && pending.cols === snapshot.cols && pending.rows === snapshot.rows;
      this.term.resize(snapshot.cols, snapshot.rows);
      if (ours && Date.now() - pending.at < PENDING_RESIZE_MS) this.keepTextSize(pending.textPx);
      this.scheduleFit();
    }
    this.term.reset();
    this.term.write(snapshot.data);
    this.expectedOffset = snapshot.offset;
    this.ready = true;
    this.awaitingSnapshotSince = null;
  }

  write(offset: number, data: Uint8Array): void {
    if (!this.ready) return;
    if (offset !== this.expectedOffset) {
      // A gap would silently corrupt the screen; ask for a fresh snapshot instead.
      console.warn(`session ${this.sessionId}: expected offset ${this.expectedOffset}, got ${offset}`);
      this.resync();
      return;
    }
    this.expectedOffset += data.length;
    this.term.write(data);
  }

  resync(): void {
    if (this.paused) return;
    this.ready = false;
    this.awaitingSnapshotSince = Date.now();
    this.options.send({ t: "sub", session: this.sessionId });
  }

  /** Stops receiving output, for a page in the background; resume() catches up with a snapshot. */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.ready = false;
    this.options.send({ t: "unsub", session: this.sessionId });
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.resync();
  }

  /** Whether a snapshot was asked for at least `ms` ago and has not arrived. */
  waitingLongerThan(ms: number): boolean {
    return this.awaitingSnapshotSince !== null && Date.now() - this.awaitingSnapshotSince > ms;
  }

  /**
   * Draws every glyph and cell again. While a page is hidden, or the computer sleeps, the GPU
   * may lose the WebGL context or corrupt its glyph texture, which leaves the terminal blank
   * until something redraws it (xterm.js documents clearTextureAtlas for this).
   */
  repaint(): void {
    if (this.options.useWebgl && !this.webgl) this.enableWebgl(); // lost earlier: try again
    this.term.clearTextureAtlas();
    this.term.refresh(0, this.term.rows - 1);
  }

  /**
   * Whether the terminal can be resized (the daemon must know how, and the program must be
   * running), and whether its own edges are the handles for it (not in a window, whose edges
   * resize window and terminal together).
   */
  setResizable(resizable: boolean, handles = resizable): void {
    this.resizable = resizable;
    this.handles?.setEnabled(resizable && handles);
  }

  /**
   * Asks the daemon for a new size; the snapshot that follows applies it (applySnapshot). The
   * size belongs to the session, so every browser follows.
   */
  requestResize(cols: number, rows: number, textPx = this.term.options.fontSize ?? BASE_FONT_SIZE): void {
    if (cols === this.term.cols && rows === this.term.rows) return;
    const pending = { cols, rows, textPx, at: Date.now() };
    this.pendingResize = pending;
    this.options.send({ t: "resize", session: this.sessionId, cols, rows });
    // Should no snapshot come (the daemon refused), fit the tile as it is once the request expires.
    setTimeout(() => {
      if (this.pendingResize !== pending) return;
      this.pendingResize = null;
      this.scheduleFit();
    }, PENDING_RESIZE_MS + 100);
  }

  /** One cell as drawn now, in CSS px; null while the terminal cannot be measured. */
  cellSize(): Area | null {
    return this.geometry()?.cell ?? null;
  }

  /** Resizes to the most cells that fit the tile at the current text size. */
  fillTile(): void {
    const geometry = this.geometry();
    if (!geometry) return;
    const { cols, rows } = cellsThatFit(geometry.area, geometry.cell);
    this.requestResize(cols, rows);
  }

  /** What the resize dialog needs, measured now; null while the terminal cannot be measured. */
  resizeTarget(name: string): ResizeTarget | null {
    const geometry = this.geometry();
    if (!geometry) return null;
    return {
      name,
      cols: geometry.cols,
      rows: geometry.rows,
      area: geometry.area,
      font: trueFont(),
      textPx: this.term.options.fontSize ?? BASE_FONT_SIZE,
      commit: (cols, rows, textPx) => this.requestResize(cols, rows, textPx),
    };
  }

  dispose(): void {
    if (this.focused) this.setFocused(false);
    this.resizeObserver?.disconnect();
    this.handles?.dispose();
    this.term.dispose();
    this.element.remove();
  }

  private sendInput(data: string): void {
    this.options.send({ t: "input", session: this.sessionId, data });
  }

  private setFocused(focused: boolean): void {
    if (this.focused === focused) return;
    this.focused = focused;
    this.options.send({ t: "focus", session: this.sessionId, focused });
    this.options.onFocusChange(focused);
  }

  /**
   * Ctrl + / - / 0: to the next step above or below the current zoom, or back to filling the
   * tile. At 100% the text already fills the tile, so Ctrl + goes on by making the text larger
   * and the terminal smaller (growText), as a desktop terminal does.
   */
  private zoomStep(direction: 1 | -1 | 0): void {
    if (direction > 0 && this.zoom >= 1 - 1e-6 && this.growText()) return;
    if (direction === 0) this.zoom = 1;
    else if (direction > 0) this.zoom = ZOOM_STEPS.filter((step) => step > this.zoom + 1e-6).at(-1) ?? this.zoom;
    else this.zoom = ZOOM_STEPS.find((step) => step < this.zoom - 1e-6) ?? this.zoom;
    saveZoom(this.sessionId, this.zoom);
    this.scheduleFit();
  }

  /**
   * Larger text in the same tile: asks for the most whole cells that fit at TEXT_STEP_PX more,
   * which the snapshot then shows at that size (applySnapshot). An explicit resize, like a drag
   * of the edges: the program is told and redraws. False if the terminal cannot be resized, or
   * the text is as large as it gets.
   */
  private growText(): boolean {
    if (!this.resizable) return false;
    const geometry = this.geometry();
    if (!geometry) return false;
    const textPx = this.term.options.fontSize ?? BASE_FONT_SIZE;
    const room = { width: geometry.area.width - SNAP_SLACK_PX, height: geometry.area.height - SNAP_SLACK_PX };
    const font = trueFont();
    // Cells snap to device pixels, so at small sizes a step may not change the cell: step on until it does.
    for (let target = textPx + TEXT_STEP_PX; target <= MAX_FONT_SIZE; target += TEXT_STEP_PX) {
      const { cols, rows } = cellsThatFit(room, cellAt(font, target));
      if (cols === this.term.cols && rows === this.term.rows) continue;
      this.requestResize(cols, rows, Math.floor(target * 4) / 4);
      return true;
    }
    return false;
  }

  private scheduleFit(): void {
    if (this.fitScheduled) return;
    this.fitScheduled = true;
    requestAnimationFrame(() => {
      this.fitScheduled = false;
      if (this.fit()) this.scheduleFit(); // verify once more after the renderer settles
    });
  }

  /**
   * Picks the font size at which the fixed cols x rows grid fills the tile ("contain"),
   * scaled by the zoom step. Returns true if the font size changed.
   */
  private fit(): boolean {
    // While a resize this tile asked for is in flight, its window may already have the new size
    // (a drag of the window's edge resizes both) but the terminal still has the old grid. Fitting
    // that grid into the new window would move the font the snapshot's resize is meant to keep;
    // the snapshot fits once it has applied the new grid.
    const pending = this.pendingResize;
    if (pending && Date.now() - pending.at < PENDING_RESIZE_MS) return false;
    const width = this.element.clientWidth;
    const height = this.element.clientHeight;
    const screen = this.term.element?.querySelector<HTMLElement>(".xterm-screen");
    if (!screen || width < 10 || height < 10) return false;
    const start = this.term.options.fontSize ?? BASE_FONT_SIZE;
    // The epsilon keeps a zoom chosen as textPx / fill (keepTextSize) from landing a step short.
    let size = clampFont(Math.floor(this.fillFont(width, height) * this.zoom * 4 + 1e-6) / 4);
    if (size !== start) this.term.options.fontSize = size;
    // The model can be a device pixel off at a rounding boundary: the grid must never overflow.
    while (size > MIN_FONT_SIZE && (screen.offsetWidth > width || screen.offsetHeight > height)) {
      size -= 0.25;
      this.term.options.fontSize = size;
    }
    this.handles?.layout();
    return size !== start;
  }

  /**
   * The largest font, in quarter pixels, at which the grid fits the tile, from the font's own
   * metrics with the renderer's device-pixel snapping (fitTextPx) rather than by trying sizes on
   * the terminal: each size tried makes the WebGL renderer rebuild its glyph atlas, and a run of
   * them left it drawing nothing until the next size change. The font is set once, by fit().
   */
  private fillFont(width: number, height: number): number {
    return fitTextPx({ width, height }, this.term.cols, this.term.rows, trueFont());
  }

  /** The terminal as drawn now: grid, cell and screen size, and the tile area it may fill. */
  private geometry(): ResizeGeometry | null {
    const screen = this.term.element?.querySelector<HTMLElement>(".xterm-screen");
    const width = screen?.offsetWidth ?? 0;
    const height = screen?.offsetHeight ?? 0;
    if (!width || !height) return null;
    return {
      cols: this.term.cols,
      rows: this.term.rows,
      cell: { width: width / this.term.cols, height: height / this.term.rows },
      screen: { width, height },
      area: { width: this.element.clientWidth, height: this.element.clientHeight },
    };
  }

  /**
   * Sets the zoom at which the grid the terminal has now shows text of size `textPx` in this
   * tile: the fraction of the fill font (fillFont, as fit() reckons it) that gives it. Text
   * larger than the fill (a size the dialog or Ctrl + asked for that does not quite fit) gets
   * the fill.
   */
  private keepTextSize(textPx: number): void {
    const width = this.element.clientWidth;
    const height = this.element.clientHeight;
    if (width < 10 || height < 10) return;
    this.zoom = zoomKeepingText(this.fillFont(width, height), textPx, MIN_ZOOM);
    saveZoom(this.sessionId, this.zoom);
  }

  private enableWebgl(): void {
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        // Falls back to the DOM renderer; repaint() tries WebGL again later.
        addon.dispose();
        if (this.webgl === addon) this.webgl = null;
      });
      this.term.loadAddon(addon);
      this.webgl = addon;
    } catch (error) {
      console.warn("WebGL renderer unavailable, using the DOM renderer", error);
    }
  }

  private onPaste(event: ClipboardEvent): void {
    const text = event.clipboardData?.getData("text/plain");
    if (!text) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    // Pasted text must not smuggle control sequences, e.g. an early "ESC [201~" that ends
    // bracketed paste and turns the rest into typed commands.
    this.term.paste(sanitizePaste(text));
  }

  private onContextMenu(event: MouseEvent): void {
    // Windows: right click copies the selection, or pastes when nothing is selected.
    if (this.options.platform !== "windows") return;
    if (this.term.hasSelection()) {
      event.preventDefault();
      this.term.focus();
      document.execCommand("copy");
      this.term.clearSelection();
      return;
    }
    if (!navigator.clipboard?.readText) return; // plain HTTP: keep the browser menu (it has Paste)
    event.preventDefault();
    navigator.clipboard
      .readText()
      .then((text) => this.term.paste(sanitizePaste(text)))
      .catch(() => {});
  }
}

/**
 * The terminal font's cell shape, measured from the font itself (not from the cells as drawn,
 * which at small sizes are snapped so coarsely that scaling them misleads by a cell or more).
 * Measured again when the device pixel ratio changes (the browser was zoomed).
 */
let trueFontCache: FontMetrics | null = null;
function trueFont(): FontMetrics {
  if (!trueFontCache || trueFontCache.devicePixelRatio !== (window.devicePixelRatio || 1)) trueFontCache = measureFont(FONT_FAMILY);
  return trueFontCache;
}

export function sanitizePaste(text: string): string {
  return text.replace(/[\x1b\x9b]/g, "");
}

function clampFont(size: number): number {
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size));
}

/** Stored as a fraction with decimals ("0.935"); a bare digit is the former format, an index into ZOOM_STEPS. */
function loadZoom(sessionId: string): number {
  const stored = loadSetting(`zoom.${sessionId}`, "1.000");
  if (/^\d$/.test(stored)) return ZOOM_STEPS[Number(stored)] ?? 1;
  const value = Number(stored);
  return Number.isFinite(value) && value >= MIN_ZOOM && value <= 1 ? value : 1;
}

function saveZoom(sessionId: string, zoom: number): void {
  saveSetting(`zoom.${sessionId}`, zoom.toFixed(3));
}
