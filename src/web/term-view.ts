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

/** Zoom is a fraction of the font size that exactly fills the tile; 1 is the maximum. */
const ZOOM_STEPS = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3];
const BASE_FONT_SIZE = 14;
const MIN_FONT_SIZE = 3;
const MAX_FONT_SIZE = 72;
export const FONT_FAMILY =
  '"JetBrains Mono", "Cascadia Mono", "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace';

export interface TermViewOptions {
  session: SessionView;
  platform: Platform;
  useWebgl: boolean;
  send(message: ClientMessage): void;
  onFocusChange(focused: boolean): void;
}

// Programs may set the clipboard (OSC 52) but never read it.
const writeOnlyClipboard: IClipboardProvider = {
  readText: () => "",
  writeText: (_selection, text) => navigator.clipboard.writeText(text),
};

function openLink(uri: string): void {
  if (/^https?:\/\//i.test(uri)) window.open(uri, "_blank", "noopener,noreferrer");
}

/**
 * One session rendered in one tile. The terminal keeps the session's fixed size forever;
 * fitting the tile and zooming only change the font size (DESIGN.md §4).
 */
export class TermView {
  readonly element: HTMLDivElement;
  private readonly term: Terminal;
  private readonly sessionId: string;
  private ready = false;
  private expectedOffset = 0;
  private zoomIndex: number;
  private focused = false;
  private fitScheduled = false;
  private resizeObserver: ResizeObserver | null = null;

  constructor(private readonly options: TermViewOptions) {
    const { session } = options;
    this.sessionId = session.id;
    this.zoomIndex = loadZoom(session.id);
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
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.loadAddon(new WebLinksAddon((_event, uri) => openLink(uri)));
    if (window.isSecureContext) term.loadAddon(new ClipboardAddon(undefined, writeOnlyClipboard));
    if (this.options.useWebgl) this.enableWebgl();
    suppressQueryReplies(term);
    installKeymap(term, this.options.platform, {
      zoom: (direction) => this.zoom(direction),
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
        this.zoom(event.deltaY < 0 ? 1 : -1);
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
      this.term.resize(snapshot.cols, snapshot.rows);
      this.scheduleFit();
    }
    this.term.reset();
    this.term.write(snapshot.data);
    this.expectedOffset = snapshot.offset;
    this.ready = true;
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
    this.ready = false;
    this.options.send({ t: "sub", session: this.sessionId });
  }

  dispose(): void {
    if (this.focused) this.setFocused(false);
    this.resizeObserver?.disconnect();
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

  private zoom(direction: 1 | -1 | 0): void {
    const next = direction === 0 ? 0 : this.zoomIndex - direction;
    this.zoomIndex = Math.min(ZOOM_STEPS.length - 1, Math.max(0, next));
    saveZoom(this.sessionId, this.zoomIndex);
    this.scheduleFit();
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
    const width = this.element.clientWidth;
    const height = this.element.clientHeight;
    const screen = this.term.element?.querySelector<HTMLElement>(".xterm-screen");
    if (!screen || width < 10 || height < 10) return false;
    const zoom = ZOOM_STEPS[this.zoomIndex] ?? 1;
    const start = this.term.options.fontSize ?? BASE_FONT_SIZE;
    let size = start;
    for (let i = 0; i < 6; i++) {
      const w = screen.offsetWidth;
      const h = screen.offsetHeight;
      if (!w || !h) break;
      const target = clampFont(Math.floor(size * Math.min(width / w, height / h) * zoom * 4) / 4);
      if (Math.abs(target - size) < 0.25) break;
      size = target;
      this.term.options.fontSize = size;
    }
    // Cell sizes round to device pixels, so the linear estimate can overshoot slightly.
    while (size > MIN_FONT_SIZE && (screen.offsetWidth > width || screen.offsetHeight > height)) {
      size -= 0.25;
      this.term.options.fontSize = size;
    }
    return size !== start;
  }

  private enableWebgl(): void {
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => addon.dispose());
      this.term.loadAddon(addon);
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

export function sanitizePaste(text: string): string {
  return text.replace(/[\x1b\x9b]/g, "");
}

function clampFont(size: number): number {
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size));
}

function loadZoom(sessionId: string): number {
  const value = Number(loadSetting(`zoom.${sessionId}`, "0"));
  return Number.isInteger(value) && value >= 0 && value < ZOOM_STEPS.length ? value : 0;
}

function saveZoom(sessionId: string, index: number): void {
  saveSetting(`zoom.${sessionId}`, String(index));
}
