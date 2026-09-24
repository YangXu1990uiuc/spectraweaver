// Copyright 2026 The workstreams Authors
// SPDX-License-Identifier: Apache-2.0
// Part of workstreams: https://github.com/YangXu1990uiuc/workstreams

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

/** Per-browser preferences. Storage can be unavailable (private mode); callers get the fallback. */
export function loadSetting(key: string, fallback: string): string {
  try {
    return localStorage.getItem(`workstreams.${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}

export function saveSetting(key: string, value: string): void {
  try {
    localStorage.setItem(`workstreams.${key}`, value);
  } catch {
    // Storage unavailable; the setting just won't persist.
  }
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
