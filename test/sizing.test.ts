// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { expect, test } from "bun:test";
import { cellAt, cellsThatFit, coverage, dragResize, fitTextPx, recommendSize, zoomKeepingText } from "../src/web/sizing.ts";

// A typical monospace font (0.6 em advance, 1.2 em line) on a standard display.
const font = { widthRatio: 0.6, heightRatio: 1.2, devicePixelRatio: 1 };

test("cells snap to whole device pixels like xterm.js's WebGL renderer", () => {
  expect(cellAt(font, 13)).toEqual({ width: 7, height: 16 }); // 7.8 down to 7, 15.6 up to 16
  // On a 2x display the snapping happens in device pixels: 15.6 -> 15, 31.2 -> 32.
  expect(cellAt({ ...font, devicePixelRatio: 2 }, 13)).toEqual({ width: 7.5, height: 16 });
});

test("recommends the size whose shape matches the tile at the preferred text size", () => {
  // One tile of a 2 x 3 grid (2 rows of 3) on a 4K screen at 150% scaling: about 840 x 600 CSS px.
  const tile = { width: 840, height: 600 };
  expect(recommendSize(tile, font, 13)).toEqual({ cols: 120, rows: 37 });
  // Smaller text means more cells in the same tile.
  expect(recommendSize(tile, font, 10)).toEqual({ cols: 140, rows: 50 });
});

test("the recommended size fills the tile at about the requested text size", () => {
  const tile = { width: 1270, height: 700 };
  const { cols, rows } = recommendSize(tile, font, 13);
  const px = fitTextPx(tile, cols, rows, font);
  expect(px).toBeGreaterThanOrEqual(13);
  expect(px).toBeLessThan(14);
  const covered = coverage(tile, cols, rows, font);
  expect(Math.max(covered.width, covered.height)).toBeLessThanOrEqual(1);
  expect(Math.min(covered.width, covered.height)).toBeGreaterThan(0.9);
});

test("a wide terminal in a tall tile is width-limited and leaves space below", () => {
  const tile = { width: 600, height: 600 };
  const covered = coverage(tile, 120, 36, font);
  expect(covered.width).toBeGreaterThan(0.95);
  expect(covered.height).toBeLessThan(0.75); // 36 rows x 12 px = 432 of 600
});

test("recommendations stay within the limits the daemon accepts", () => {
  expect(recommendSize({ width: 50, height: 20 }, font, 24)).toEqual({ cols: 20, rows: 5 });
  expect(recommendSize({ width: 1e6, height: 1e6 }, font, 8)).toEqual({ cols: 1000, rows: 500 });
});

test("a drag asks for whole cells at the current cell size and stops at the tile's edge", () => {
  const cell = { width: 8, height: 16 };
  const area = { width: 1000, height: 500 }; // room for 125 x 31 cells
  const start = { cols: 100, rows: 24 };
  const both = { cols: true, rows: true };
  // 83 px right is 10.4 cells, 40 px up is 2.5 cells: rounded to whole cells.
  expect(dragResize(start, { dx: 83, dy: -40 }, cell, area, both)).toEqual({ cols: 110, rows: 22 });
  // Never beyond the tile, never below the daemon's minimum.
  expect(dragResize(start, { dx: 5000, dy: 5000 }, cell, area, both)).toEqual({ cols: 125, rows: 31 });
  expect(dragResize(start, { dx: -5000, dy: -5000 }, cell, area, both)).toEqual({ cols: 2, rows: 1 });
  // An edge moves one axis only.
  expect(dragResize(start, { dx: 83, dy: 83 }, cell, area, { cols: true, rows: false })).toEqual({ cols: 110, rows: 24 });
  expect(dragResize(start, { dx: 83, dy: 83 }, cell, area, { cols: false, rows: true })).toEqual({ cols: 100, rows: 29 });
  // A terminal already wider than its tile can only shrink, not grow further.
  expect(dragResize({ cols: 140, rows: 24 }, { dx: 100, dy: 0 }, cell, area, both)).toEqual({ cols: 140, rows: 24 });
  expect(dragResize({ cols: 140, rows: 24 }, { dx: -80, dy: 0 }, cell, area, both)).toEqual({ cols: 130, rows: 24 });
});

test("filling the tile is the most whole cells that fit, within the daemon's limits", () => {
  expect(cellsThatFit({ width: 1000, height: 500 }, { width: 8, height: 16 })).toEqual({ cols: 125, rows: 31 });
  expect(cellsThatFit({ width: 5, height: 5 }, { width: 8, height: 16 })).toEqual({ cols: 2, rows: 1 });
  expect(cellsThatFit({ width: 1e6, height: 1e6 }, { width: 1, height: 1 })).toEqual({ cols: 1000, rows: 500 });
});

test("after a resize, the zoom that keeps the text size is chosen", () => {
  // Grown to fill the tile from a zoomed-out view: the fill font is the text size, so 100%.
  expect(zoomKeepingText(13, 13, 0.3)).toBe(1);
  // Shrunk to fewer cells: filling would enlarge the text to 20 px, so zoom to 65% of that.
  expect(zoomKeepingText(20, 13, 0.3)).toBeCloseTo(0.65);
  // Text larger than the fill font cannot be kept (zoom tops out at 100%), nor smaller than the floor.
  expect(zoomKeepingText(10, 13, 0.3)).toBe(1);
  expect(zoomKeepingText(100, 13, 0.3)).toBe(0.3);
});
