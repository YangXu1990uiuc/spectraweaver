// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

// A tab laid out as windows (DESIGN.md §4.5): each terminal is a window the user moves by its
// header and resizes by its edges, as on a desktop. Where a window sits is a Frame, in fractions
// of the workspace, so every screen shows the same arrangement at its own size; a drag is worked
// out here on rectangles in CSS px and converted back. Pure functions, tested without a browser.

import { type Frame, FRAME_MIN_SIDE, SIZE_LIMITS, type TabLayout } from "../common/protocol.ts";
import type { Grid } from "./dom.ts";
import type { Area } from "./sizing.ts";

/** A tab's layout; windows unless the tab asks for a grid (tabs from before layouts existed are windows too). */
export function layoutOf(tab: { layout?: TabLayout } | null): TabLayout {
  return tab?.layout === "grid" ? "grid" : "windows";
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The smallest window, in CSS px: a header and a few cells. */
export const MIN_WINDOW: Area = { width: 180, height: 90 };
/** A press on the header that travels less than this is a click, not a drag. */
export const DRAG_THRESHOLD_PX = 4;
/**
 * Room a snapped window leaves after its whole cells, in CSS px. The frame is stored as a
 * fraction and laid out as a percentage, and the browser reports sizes in whole pixels, so a
 * window sized to exactly its cells can come out a fraction of a pixel short; the fit would then
 * shrink the font a step, and the next drag would start from the smaller cell. Two pixels cover
 * every rounding on the way.
 */
export const SNAP_SLACK_PX = 2;
/** Windows that find no free cell cascade from the top-left by this fraction per step. */
const CASCADE_STEP = 0.03;

export function frameToRect(frame: Frame, workspace: Area): Rect {
  return {
    left: frame.x * workspace.width,
    top: frame.y * workspace.height,
    width: frame.w * workspace.width,
    height: frame.h * workspace.height,
  };
}

/** The frame of a rectangle in the workspace, pulled inside it; `z` is carried over. */
export function rectToFrame(rect: Rect, workspace: Area, z: number): Frame {
  const w = clamp(rect.width / workspace.width, FRAME_MIN_SIDE, 1);
  const h = clamp(rect.height / workspace.height, FRAME_MIN_SIDE, 1);
  return {
    x: clamp(rect.left / workspace.width, 0, 1 - w),
    y: clamp(rect.top / workspace.height, 0, 1 - h),
    w,
    h,
    z,
  };
}

/** One cell of the grid in reading order (indexes past the last cell wrap), as a frame. */
export function cellFrame(grid: Grid, index: number, z = 0): Frame {
  const cells = grid.rows * grid.cols;
  const slot = ((index % cells) + cells) % cells;
  const w = 1 / grid.cols;
  const h = 1 / grid.rows;
  return { x: (slot % grid.cols) * w, y: Math.floor(slot / grid.cols) * h, w, h, z };
}

/** The highest z among the frames, 0 when there are none. */
export function topZ(frames: Iterable<Frame>): number {
  let top = 0;
  for (const frame of frames) top = Math.max(top, frame.z);
  return top;
}

/**
 * Where a window without a place goes, in front of the others: the first cell of the tab's grid
 * that is free (its centre inside no placed window, no placed window's centre inside it), else
 * cascaded from the top-left as a desktop places new windows. A function of its inputs only, so
 * every browser puts an unplaced window in the same spot without being told; the first move or
 * resize stores the place.
 */
export function placeWindow(grid: Grid, taken: readonly Frame[], ordinal: number): Frame {
  const z = topZ(taken) + 1;
  const cells = grid.rows * grid.cols;
  for (let index = 0; index < cells; index++) {
    const cell = cellFrame(grid, index, z);
    const free = !taken.some((frame) => contains(frame, centre(cell)) || contains(cell, centre(frame)));
    if (free) return cell;
  }
  const size = cellFrame(grid, 0);
  const offset = CASCADE_STEP * (ordinal % 10);
  return { x: Math.min(offset, 1 - size.w), y: Math.min(offset, 1 - size.h), w: size.w, h: size.h, z };
}

/** The window moved by the pointer's travel, kept inside the workspace. */
export function moveRect(start: Rect, travel: { dx: number; dy: number }, workspace: Area): Rect {
  return {
    ...start,
    left: clamp(start.left + travel.dx, 0, Math.max(0, workspace.width - start.width)),
    top: clamp(start.top + travel.dy, 0, Math.max(0, workspace.height - start.height)),
  };
}

/** Which sides of the window a handle moves. */
export interface Edges {
  left: boolean;
  right: boolean;
  top: boolean;
  bottom: boolean;
}

export interface ResizeLimits {
  workspace: Area;
  /** What the window adds around its terminal: header and borders, in CSS px. */
  chrome: Area;
  /** One terminal cell as drawn: the body then snaps to whole cells. Null resizes the window alone. */
  cell: Area | null;
  /** The terminal's size now, for the axes a handle leaves alone. */
  current: { cols: number; rows: number };
}

export interface Resized {
  rect: Rect;
  /** The terminal size that fills the new window at the current text size; null without a cell. */
  cells: { cols: number; rows: number } | null;
}

/**
 * The window resized by the pointer's travel on the given edges, as a window manager does it:
 * the opposite edges stay put, the window stays inside the workspace and above a minimum size,
 * and with a cell the terminal area snaps to whole cells at the current text size, so the text
 * keeps its size and the terminal grows or shrinks by cells (never beyond the daemon's limits).
 */
export function resizeRect(start: Rect, travel: { dx: number; dy: number }, edges: Edges, limits: ResizeLimits): Resized {
  const { workspace, chrome, cell, current } = limits;
  const x = resizeAxis(start.left, start.width, travel.dx, edges.left, edges.right, {
    min: Math.max(MIN_WINDOW.width, chrome.width + (cell ? SIZE_LIMITS.minCols * cell.width + SNAP_SLACK_PX : 0)),
    extent: workspace.width,
    chrome: chrome.width,
    cell: cell?.width ?? null,
    minCells: SIZE_LIMITS.minCols,
    maxCells: SIZE_LIMITS.maxCols,
  });
  const y = resizeAxis(start.top, start.height, travel.dy, edges.top, edges.bottom, {
    min: Math.max(MIN_WINDOW.height, chrome.height + (cell ? SIZE_LIMITS.minRows * cell.height + SNAP_SLACK_PX : 0)),
    extent: workspace.height,
    chrome: chrome.height,
    cell: cell?.height ?? null,
    minCells: SIZE_LIMITS.minRows,
    maxCells: SIZE_LIMITS.maxRows,
  });
  return {
    rect: { left: x.start, top: y.start, width: x.size, height: y.size },
    cells: cell ? { cols: x.cells ?? current.cols, rows: y.cells ?? current.rows } : null,
  };
}

interface AxisLimits {
  min: number;
  extent: number;
  chrome: number;
  cell: number | null;
  minCells: number;
  maxCells: number;
}

/** One axis of resizeRect; `cells` is null when neither edge on this axis moves. */
function resizeAxis(
  start: number,
  size: number,
  delta: number,
  lowMoves: boolean,
  highMoves: boolean,
  limits: AxisLimits,
): { start: number; size: number; cells: number | null } {
  if (!lowMoves && !highMoves) return { start, size, cells: null };
  let low = start;
  let high = start + size;
  // The lower bound wins when the workspace is too small for the minimum.
  if (lowMoves) low = Math.max(0, Math.min(low + delta, high - limits.min));
  if (highMoves) high = Math.min(limits.extent, Math.max(high + delta, low + limits.min));
  let cells: number | null = null;
  if (limits.cell !== null) {
    // The cells that fit beside the chrome and the slack; the epsilon keeps a window that was
    // snapped before from losing a cell to floating point when it is dragged by nothing.
    const room = (high - low - limits.chrome - SNAP_SLACK_PX) / limits.cell;
    cells = clamp(Math.floor(room + 1e-6), limits.minCells, limits.maxCells);
    // Rounding down must not take the window below its minimum: one more cell then.
    if (limits.chrome + cells * limits.cell + SNAP_SLACK_PX < limits.min && cells < limits.maxCells) cells++;
    const snapped = limits.chrome + cells * limits.cell + SNAP_SLACK_PX;
    if (snapped <= limits.extent) {
      if (lowMoves) low = high - snapped;
      else high = low + snapped;
    }
  }
  return { start: low, size: high - low, cells };
}

function centre(frame: Frame): { x: number; y: number } {
  return { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 };
}

function contains(frame: Frame, point: { x: number; y: number }): boolean {
  return point.x >= frame.x && point.x < frame.x + frame.w && point.y >= frame.y && point.y < frame.y + frame.h;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
