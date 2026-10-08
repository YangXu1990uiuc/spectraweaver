// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { expect, test } from "bun:test";
import { normalizeFrame } from "../src/common/protocol.ts";
import {
  cellFrame,
  frameToRect,
  layoutOf,
  MIN_WINDOW,
  moveRect,
  placeWindow,
  rectToFrame,
  resizeRect,
  SNAP_SLACK_PX as SLACK,
  topZ,
} from "../src/web/windows.ts";

const workspace = { width: 1600, height: 900 };

test("a tab is laid out as windows unless it asks for a grid", () => {
  expect(layoutOf(null)).toBe("windows");
  expect(layoutOf({})).toBe("windows"); // a tab from before layouts existed
  expect(layoutOf({ layout: "windows" })).toBe("windows");
  expect(layoutOf({ layout: "grid" })).toBe("grid");
});

test("a frame from a browser is checked, rounded and kept inside the workspace", () => {
  expect(normalizeFrame({ x: 0.123456, y: 0.2, w: 0.5, h: 0.25, z: 3 })).toEqual({ x: 0.1235, y: 0.2, w: 0.5, h: 0.25, z: 3 });
  // Over the right or bottom edge: pulled back in. Too small or too large: the limits.
  expect(normalizeFrame({ x: 0.9, y: 0.95, w: 0.5, h: 0.25, z: 0 })).toEqual({ x: 0.5, y: 0.75, w: 0.5, h: 0.25, z: 0 });
  expect(normalizeFrame({ x: -1, y: -1, w: 0.001, h: 2, z: -4.6 })).toEqual({ x: 0, y: 0, w: 0.02, h: 1, z: 0 });
  expect(normalizeFrame({ x: 0.1, y: 0.1, w: 0.2, h: 0.2, z: 1.4 })?.z).toBe(1);
  // Not a frame at all.
  expect(normalizeFrame(null)).toBeNull();
  expect(normalizeFrame("0.1,0.1,0.2,0.2,1")).toBeNull();
  expect(normalizeFrame({ x: "0.1", y: 0.1, w: 0.2, h: 0.2, z: 1 })).toBeNull();
  expect(normalizeFrame({ x: Number.NaN, y: 0.1, w: 0.2, h: 0.2, z: 1 })).toBeNull();
  expect(normalizeFrame({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 })).toBeNull();
});

test("frames and rectangles convert both ways; a rectangle over the edge is pulled inside", () => {
  const frame = { x: 0.25, y: 0.5, w: 0.5, h: 0.25, z: 2 };
  const rect = frameToRect(frame, workspace);
  expect(rect).toEqual({ left: 400, top: 450, width: 800, height: 225 });
  expect(rectToFrame(rect, workspace, 2)).toEqual(frame);
  expect(rectToFrame({ left: 1500, top: -50, width: 800, height: 225 }, workspace, 0)).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.25, z: 0 });
});

test("the cells of a grid come in reading order and wrap", () => {
  const grid = { rows: 2, cols: 3 };
  expect(cellFrame(grid, 0)).toEqual({ x: 0, y: 0, w: 1 / 3, h: 0.5, z: 0 });
  expect(cellFrame(grid, 4)).toEqual({ x: 1 / 3, y: 0.5, w: 1 / 3, h: 0.5, z: 0 });
  expect(cellFrame(grid, 6)).toEqual(cellFrame(grid, 0));
});

test("an unplaced window takes the first free cell, in front; a full grid cascades", () => {
  const grid = { rows: 2, cols: 2 };
  expect(placeWindow(grid, [], 0)).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5, z: 1 });
  // A window whose centre is in a cell takes it, however it is sized; a cell under a big window is taken too.
  const first = { x: 0.05, y: 0.05, w: 0.4, h: 0.4, z: 4 };
  const second = { x: 0.5, y: 0, w: 0.5, h: 0.5, z: 1 };
  expect(placeWindow(grid, [first, second], 0)).toEqual({ x: 0, y: 0.5, w: 0.5, h: 0.5, z: 5 });
  const wide = { x: 0, y: 0, w: 1, h: 0.75, z: 1 }; // covers the top row's centres; the bottom-left cell is free
  expect(placeWindow(grid, [wide], 0)).toEqual({ x: 0, y: 0.5, w: 0.5, h: 0.5, z: 2 });
  // Every cell taken: cascade from the top-left, a step per unplaced window, at a cell's size.
  const full = [0, 1, 2, 3].map((index) => cellFrame(grid, index, 1));
  expect(placeWindow(grid, full, 0)).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5, z: 2 });
  const third = placeWindow(grid, full, 2);
  expect(third.x).toBeCloseTo(0.06);
  expect(third.y).toBeCloseTo(0.06);
  expect([third.w, third.h, third.z]).toEqual([0.5, 0.5, 2]);
});

test("moving keeps the window inside the workspace", () => {
  const start = { left: 400, top: 450, width: 800, height: 225 };
  expect(moveRect(start, { dx: 100, dy: -50 }, workspace)).toEqual({ left: 500, top: 400, width: 800, height: 225 });
  expect(moveRect(start, { dx: 5000, dy: 5000 }, workspace)).toEqual({ left: 800, top: 675, width: 800, height: 225 });
  expect(moveRect(start, { dx: -5000, dy: -5000 }, workspace)).toEqual({ left: 0, top: 0, width: 800, height: 225 });
});

test("resizing by an edge keeps the opposite edge, snaps the terminal to whole cells and stays inside", () => {
  const cell = { width: 8, height: 16 };
  const chrome = { width: 2, height: 30 }; // the borders, and a header
  const start = { left: 100, top: 100, width: 2 + 80 * 8, height: 30 + 24 * 16 }; // an 80 x 24 terminal: 642 x 414
  const limits = { workspace, chrome, cell, current: { cols: 80, rows: 24 } };
  const right = { left: false, right: true, top: false, bottom: false };
  // 83 px to the right is 10.4 cells: 10 whole cells, plus the slack; the rows are untouched.
  expect(resizeRect(start, { dx: 83, dy: 50 }, right, limits)).toEqual({
    rect: { left: 100, top: 100, width: 2 + 90 * 8 + SLACK, height: 414 },
    cells: { cols: 90, rows: 24 },
  });
  // The left edge moves the left side and keeps the right side where it was.
  const left = { left: true, right: false, top: false, bottom: false };
  expect(resizeRect(start, { dx: -83, dy: 0 }, left, limits)).toEqual({
    rect: { left: 742 - (2 + 90 * 8 + SLACK), top: 100, width: 2 + 90 * 8 + SLACK, height: 414 },
    cells: { cols: 90, rows: 24 },
  });
  // A corner moves both axes: 38 px and 30 px inward are 5 columns and 2 rows fewer.
  const nw = { left: true, right: false, top: true, bottom: false };
  expect(resizeRect(start, { dx: 38, dy: 30 }, nw, limits)).toEqual({
    rect: { left: 742 - (2 + 75 * 8 + SLACK), top: 514 - (30 + 22 * 16 + SLACK), width: 2 + 75 * 8 + SLACK, height: 30 + 22 * 16 + SLACK },
    cells: { cols: 75, rows: 22 },
  });
  // A window snapped before, dragged by nothing, keeps its cells (floating point must not lose one).
  const snapped = { left: 100, top: 100, width: 2 + 90 * 8 + SLACK, height: 30 + 22 * 16 + SLACK };
  const se = { left: false, right: true, top: false, bottom: true };
  expect(resizeRect(snapped, { dx: 0, dy: 0 }, se, limits)).toEqual({ rect: snapped, cells: { cols: 90, rows: 22 } });
  // Never beyond the workspace: the edge stops there and the terminal takes the cells that fit.
  const far = resizeRect(start, { dx: 5000, dy: 5000 }, se, limits);
  expect(far.rect.left + far.rect.width).toBeLessThanOrEqual(workspace.width);
  expect(far.rect.top + far.rect.height).toBeLessThanOrEqual(workspace.height);
  expect(far.cells).toEqual({ cols: Math.floor((1600 - 100 - 2 - SLACK) / 8), rows: Math.floor((900 - 100 - 30 - SLACK) / 16) });
  // Never smaller than the minimum window; the terminal keeps whole cells.
  const tiny = resizeRect(start, { dx: -5000, dy: -5000 }, se, limits);
  expect(tiny.rect.width).toBeGreaterThanOrEqual(MIN_WINDOW.width);
  expect(tiny.rect.height).toBeGreaterThanOrEqual(MIN_WINDOW.height);
  expect(tiny.cells).toEqual({ cols: (tiny.rect.width - 2 - SLACK) / 8, rows: (tiny.rect.height - 30 - SLACK) / 16 });
  // Without a cell (an exited terminal, or a daemon that cannot resize) the window alone resizes, by the pixel.
  expect(resizeRect(start, { dx: 83, dy: 50 }, right, { ...limits, cell: null })).toEqual({
    rect: { left: 100, top: 100, width: 642 + 83, height: 414 },
    cells: null,
  });
});

test("the top of the stack is the highest z, 0 with nothing stacked", () => {
  expect(topZ([])).toBe(0);
  expect(topZ([{ x: 0, y: 0, w: 1, h: 1, z: 3 }, { x: 0, y: 0, w: 1, h: 1, z: 7 }])).toBe(7);
});
