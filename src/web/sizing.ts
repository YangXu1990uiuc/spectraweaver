// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

// Terminal sizes are fixed at creation (DESIGN.md §4). The new-terminal dialog pre-fills a
// size whose shape matches the tiles of the current layout at the user's preferred text
// size; the user can still type any size.

/** A font's cell shape, measured once, plus the display's pixel ratio. */
export interface FontMetrics {
  /** Glyph advance per pixel of font size. */
  widthRatio: number;
  /** Line height per pixel of font size. */
  heightRatio: number;
  devicePixelRatio: number;
}

export interface Area {
  width: number;
  height: number;
}

export const DEFAULT_TEXT_PX = 13;
export const MIN_TEXT_PX = 8;
export const MAX_TEXT_PX = 24;

/**
 * The cell xterm.js's WebGL renderer draws at a font size, in CSS pixels. It snaps cells to
 * whole device pixels, width down and height up, so cells are not a linear function of the
 * font size; ignoring that overestimates the width by up to a pixel per column.
 */
export function cellAt(font: FontMetrics, textPx: number): Area {
  const ratio = font.devicePixelRatio;
  return {
    width: Math.max(1, Math.floor(textPx * font.widthRatio * ratio)) / ratio,
    height: Math.max(1, Math.ceil(textPx * font.heightRatio * ratio)) / ratio,
  };
}

export function recommendSize(tile: Area, font: FontMetrics, textPx: number): { cols: number; rows: number } {
  const cell = cellAt(font, textPx);
  return {
    cols: clamp(Math.floor(tile.width / cell.width), 20, 1000),
    rows: clamp(Math.floor(tile.height / cell.height), 5, 500),
  };
}

/**
 * The largest text size (in quarter pixels, as TermView.fit uses) at which a cols x rows
 * terminal fits the tile ("contain").
 */
export function fitTextPx(tile: Area, cols: number, rows: number, font: FontMetrics): number {
  const fits = (px: number) => {
    const cell = cellAt(font, px);
    return cols * cell.width <= tile.width && rows * cell.height <= tile.height;
  };
  let low = 1; // quarter pixels
  let high = 4 * 200;
  if (!fits(low / 4)) return low / 4;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid / 4)) low = mid;
    else high = mid - 1;
  }
  return low / 4;
}

/** How much of the tile the terminal covers at its fitted text size, as fractions. */
export function coverage(tile: Area, cols: number, rows: number, font: FontMetrics): Area {
  const cell = cellAt(font, fitTextPx(tile, cols, rows, font));
  return { width: (cols * cell.width) / tile.width, height: (rows * cell.height) / tile.height };
}

/** Measures a font the way xterm.js does: a run of "W" (here at a large size, then scaled). */
export function measureFont(fontFamily: string): FontMetrics {
  const probe = document.createElement("span");
  probe.style.cssText =
    "position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;line-height:normal;font-size:100px;";
  probe.style.fontFamily = fontFamily;
  probe.textContent = "W".repeat(32);
  document.body.appendChild(probe);
  const rect = probe.getBoundingClientRect();
  probe.remove();
  return {
    widthRatio: rect.width / 32 / 100,
    heightRatio: rect.height / 100,
    devicePixelRatio: window.devicePixelRatio || 1,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
