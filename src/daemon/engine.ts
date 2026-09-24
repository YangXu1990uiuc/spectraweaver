// Copyright 2026 The workstreams Authors
// SPDX-License-Identifier: Apache-2.0
// Part of workstreams: https://github.com/YangXu1990uiuc/workstreams

import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/headless";
import { THEME } from "../common/protocol.ts";
import { VERSION } from "../common/version.ts";

export interface EngineOptions {
  cols: number;
  rows: number;
  scrollback: number;
  /** Replies to terminal queries (DA, CPR, colours, ...) go back to the program through this. */
  reply: (data: string) => void;
}

export interface EngineEvents {
  onTitle(title: string): void;
  onBell(): void;
  onNotify(kind: "osc9" | "osc777", text: string): void;
  onCwd(cwd: string): void;
}

// State that SerializeAddon 0.14 does not restore. Reading xterm.js's own state is exact:
// reset, soft-reset and alternate-screen semantics come for free, and nothing is re-implemented.
// These are private fields, so the xterm.js version is pinned and test/engine.test.ts fails
// loudly if they move.
interface CoreInternals {
  coreService: {
    isCursorHidden: boolean;
    decPrivateModes: { cursorStyle?: "block" | "underline" | "bar"; cursorBlink?: boolean };
  };
  coreMouseService: { activeEncoding: string };
  buffer: { scrollTop: number; scrollBottom: number };
}

const CURSOR_STYLE_CODE = { block: 1, underline: 3, bar: 5 } as const;

/**
 * The daemon-side copy of a session's terminal: the same engine the browser runs, so a
 * serialized snapshot restores faithfully, and the single responder to terminal queries
 * whether zero, one or many browsers are attached.
 */
export class Engine {
  readonly term: Terminal;
  private readonly serializer = new SerializeAddon();

  constructor(options: EngineOptions, events: EngineEvents) {
    this.term = new Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: options.scrollback,
      allowProposedApi: true,
    });
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = "11";
    this.term.loadAddon(this.serializer);
    this.term.onData(options.reply);
    this.term.onTitleChange(events.onTitle);
    this.term.onBell(events.onBell);
    this.installResponders(options.reply);
    this.installObservers(events);
  }

  write(data: Uint8Array | string, callback?: () => void): void {
    this.term.write(data, callback);
  }

  get sendFocusMode(): boolean {
    return this.term.modes.sendFocusMode;
  }

  /** Call only when the engine has processed exactly the bytes the snapshot should cover. */
  serialize(): string {
    return this.serializer.serialize() + this.restoreSuffix();
  }

  dispose(): void {
    this.term.dispose();
  }

  private core(): CoreInternals {
    return (this.term as unknown as { _core: CoreInternals })._core;
  }

  private restoreSuffix(): string {
    const core = this.core();
    let out = "";
    switch (core.coreMouseService.activeEncoding) {
      case "SGR":
        out += "\x1b[?1006h";
        break;
      case "SGR_PIXELS":
        out += "\x1b[?1016h";
        break;
    }
    const { cursorStyle, cursorBlink } = core.coreService.decPrivateModes;
    if (cursorStyle) {
      const code = CURSOR_STYLE_CODE[cursorStyle];
      out += `\x1b[${cursorBlink ? code : code + 1} q`;
    }
    if (core.coreService.isCursorHidden) out += "\x1b[?25l";

    const { scrollTop, scrollBottom } = core.buffer;
    if (scrollTop !== 0 || scrollBottom !== this.term.rows - 1) {
      out += `\x1b[${scrollTop + 1};${scrollBottom + 1}r`;
    }
    // DECSTBM homes the cursor, and SerializeAddon can leave it one column off after a
    // full-row write (xterm.js #6165), so finish with an explicit position. A pending wrap
    // (cursorX === cols) cannot be expressed with CUP and is clamped to the last column.
    const buffer = this.term.buffer.active;
    const x = Math.min(buffer.cursorX, this.term.cols - 1);
    const y = this.term.modes.originMode ? buffer.cursorY - scrollTop : buffer.cursorY;
    out += `\x1b[${y + 1};${x + 1}H`;
    return out;
  }

  private installResponders(reply: (data: string) => void): void {
    const parser = this.term.parser;
    // Headless xterm answers DA, CPR and DECRQM itself but not colour queries. Agents use
    // OSC 11 to pick a light or dark theme, so answer with the colours the UI renders.
    const colours: Array<[number, string]> = [
      [10, THEME.foreground],
      [11, THEME.background],
      [12, THEME.cursor],
    ];
    for (const [id, colour] of colours) {
      parser.registerOscHandler(id, (data) => {
        if (data !== "?") return false;
        reply(`\x1b]${id};${xColour(colour)}\x1b\\`);
        return true;
      });
    }
    // XTVERSION
    parser.registerCsiHandler({ prefix: ">", final: "q" }, (params) => {
      if ((params[0] ?? 0) !== 0) return false;
      reply(`\x1bP>|workstreams(${VERSION})\x1b\\`);
      return true;
    });
  }

  private installObservers(events: EngineEvents): void {
    const parser = this.term.parser;
    parser.registerOscHandler(9, (data) => {
      // "OSC 9;4;..." is ConEmu's progress report (Claude Code sends it); anything else is an
      // iTerm2-style notification.
      if (!/^4(;|$)/.test(data)) events.onNotify("osc9", data);
      return true;
    });
    parser.registerOscHandler(777, (data) => {
      const [kind, title = "", ...body] = data.split(";");
      if (kind === "notify") events.onNotify("osc777", body.length ? `${title}: ${body.join(";")}` : title);
      return true;
    });
    parser.registerOscHandler(7, (data) => {
      try {
        const url = new URL(data);
        if (url.protocol === "file:") events.onCwd(decodeURIComponent(url.pathname));
      } catch {
        // Not a file URL; ignore.
      }
      return true;
    });
  }
}

function xColour(hex: string): string {
  const r = hex.slice(1, 3);
  const g = hex.slice(3, 5);
  const b = hex.slice(5, 7);
  return `rgb:${r}${r}/${g}${g}/${b}${b}`;
}
