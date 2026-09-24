// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { expect, test } from "bun:test";
import { cellAt, coverage, fitTextPx, recommendSize } from "../src/web/sizing.ts";

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
