// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

const STORAGE_PREFIX = "spectraweaver.";
const FORMER_STORAGE_PREFIX = "workstreams.";

/** Moves preferences saved under the project's former name (text size, zoom, folder) over. */
export function adoptFormerSettings(): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(FORMER_STORAGE_PREFIX)) continue;
      const renamed = STORAGE_PREFIX + key.slice(FORMER_STORAGE_PREFIX.length);
      const value = localStorage.getItem(key);
      if (value !== null && localStorage.getItem(renamed) === null) localStorage.setItem(renamed, value);
      localStorage.removeItem(key);
    }
  } catch {
    // Storage unavailable (private mode); there is nothing to move.
  }
}

/** Per-browser preferences. Storage can be unavailable (private mode); callers get the fallback. */
export function loadSetting(key: string, fallback: string): string {
  try {
    return localStorage.getItem(`${STORAGE_PREFIX}${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}

export function saveSetting(key: string, value: string): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${key}`, value);
  } catch {
    // Storage unavailable; the setting just won't persist.
  }
}

/** "just now", "5 min ago", "3 h ago", "yesterday", or the date. */
export function ago(at: number, now = Date.now()): string {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  if (hours < 48) return "yesterday";
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Grids use matrix order: "2x3" is 2 rows of 3 tiles. */
export interface Grid {
  rows: number;
  cols: number;
}

export function parseGrid(text: string): Grid | null {
  const match = /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i.exec(text);
  return match ? { rows: Number(match[1]), cols: Number(match[2]) } : null;
}

export function formatGrid(grid: Grid): string {
  return `${grid.rows} × ${grid.cols}`;
}

export function randomId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
