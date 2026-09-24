// Copyright 2026 The workstreams Authors
// SPDX-License-Identifier: Apache-2.0
// Part of workstreams: https://github.com/YangXu1990uiuc/workstreams

import type { Terminal } from "@xterm/xterm";

export type Platform = "mac" | "windows" | "linux";

export function detectPlatform(): Platform {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent;
  if (/mac|iphone|ipad/i.test(platform)) return "mac";
  if (/win/i.test(platform)) return "windows";
  return "linux";
}

export interface KeymapActions {
  /** 1 zooms in, -1 zooms out, 0 resets to fill the tile. */
  zoom(direction: 1 | -1 | 0): void;
  send(data: string): void;
}

/**
 * VS Code's terminal behaviour for each client OS:
 * - Windows: Ctrl+C copies when text is selected (otherwise ^C); Ctrl+V pastes; Ctrl+Shift+C/V too.
 * - Linux: Ctrl+Shift+C / Ctrl+Shift+V, and Shift+Insert pastes; Ctrl+C / Ctrl+V go to the program.
 * - macOS: Cmd+C / Cmd+V, which xterm.js already leaves to the browser.
 *
 * Returning false makes xterm.js skip a key without calling preventDefault, so the browser's
 * native copy and paste run. They work on plain HTTP, unlike navigator.clipboard.
 */
export function installKeymap(term: Terminal, platform: Platform, actions: KeymapActions): void {
  term.attachCustomKeyEventHandler((event) => {
    if (event.isComposing || event.keyCode === 229) return true; // IME composition
    const key = event.key.toLowerCase();
    const primary = platform === "mac" ? event.metaKey : event.ctrlKey;

    // Zoom this tile. The UI owns these keys; they never reach the program.
    if (primary && !event.altKey && ["=", "+", "-", "_", "0"].includes(key)) {
      if (event.type === "keydown") {
        event.preventDefault();
        actions.zoom(key === "0" ? 0 : key === "-" || key === "_" ? -1 : 1);
      }
      return false;
    }
    if (event.type !== "keydown") return true;
    const ctrlOnly = event.ctrlKey && !event.altKey && !event.metaKey;

    if (platform === "windows" && ctrlOnly && !event.shiftKey) {
      if (key === "c" && term.hasSelection()) {
        setTimeout(() => term.clearSelection(), 0);
        return false;
      }
      if (key === "v") return false;
    }
    if (platform !== "mac" && ctrlOnly && event.shiftKey) {
      if (key === "c") {
        // The browser would open DevTools' element picker; copy explicitly instead.
        event.preventDefault();
        if (term.hasSelection()) document.execCommand("copy");
        return false;
      }
      if (key === "v") return false;
    }
    if (platform === "linux" && key === "insert" && event.shiftKey && !event.ctrlKey && !event.altKey) {
      return false;
    }

    // Shift+Enter inserts a newline in agent prompts. xterm.js 6.0 has no kitty keyboard
    // protocol, so send ESC CR (Alt+Enter), which Claude Code and Codex both read as newline.
    if (event.key === "Enter" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      actions.send("\x1b\r");
      return false;
    }
    return true;
  });
}
