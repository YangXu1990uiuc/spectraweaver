// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { type Area, dragResize } from "./sizing.ts";

/** What the handles need to know about the terminal they resize, measured when a drag starts. */
export interface ResizeGeometry {
  cols: number;
  rows: number;
  /** One cell as drawn now, in CSS pixels. */
  cell: Area;
  /** The screen as drawn now: cols x cell.width by rows x cell.height. */
  screen: Area;
  /** The tile's terminal area: the most the terminal can grow to at this text size. */
  area: Area;
}

export interface ResizeHandlesOptions {
  /** The terminal's host element: positioned, clipping, and the parent of the handles. */
  host: HTMLElement;
  /** Null while the terminal cannot be measured (not mounted yet, or hidden). */
  geometry(): ResizeGeometry | null;
  /** The drag ended on a different size. */
  commit(cols: number, rows: number): void;
  /** A double-click on the corner: fill the tile at the current text size. */
  fill(): void;
}

type Axes = { cols: boolean; rows: boolean };
type Edge = "right" | "bottom" | "corner";

const AXES: Record<Edge, Axes> = {
  right: { cols: true, rows: false },
  bottom: { cols: false, rows: true },
  corner: { cols: true, rows: true },
};
/** The grab zone across an edge, in CSS px: half inside the terminal, half outside. */
const EDGE = 8;
/** The corner's grab square, inside the terminal. */
const CORNER = 14;

/**
 * Resizes a terminal the way a window is resized: by dragging its right edge, bottom edge or
 * corner. While dragging, a dashed outline shows the new grid in whole cells at the current
 * text size, with the size in a badge; releasing asks the daemon for that size (the text keeps
 * its size, see TermView.requestResize). The handles sit on the terminal's own edges, which
 * move whenever the font is fitted, so TermView calls layout() after each fit.
 */
export class ResizeHandles {
  private readonly handles: Record<Edge, HTMLDivElement>;
  private readonly ghost: HTMLDivElement;
  private readonly badge: HTMLSpanElement;
  private enabled = true;
  private dragging = false;

  constructor(private readonly options: ResizeHandlesOptions) {
    const make = (edge: Edge, title: string) => {
      const handle = document.createElement("div");
      handle.className = `resize-handle resize-${edge}`;
      handle.title = title;
      handle.addEventListener("pointerdown", (event) => this.start(event, handle, AXES[edge]));
      options.host.appendChild(handle);
      return handle;
    };
    this.handles = {
      right: make("right", "Drag to change the number of columns"),
      bottom: make("bottom", "Drag to change the number of rows"),
      corner: make("corner", "Drag to resize the terminal; double-click to fill the tile"),
    };
    this.handles.corner.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.enabled) options.fill();
    });
    this.badge = document.createElement("span");
    this.badge.className = "resize-badge";
    this.ghost = document.createElement("div");
    this.ghost.className = "resize-ghost";
    this.ghost.hidden = true;
    this.ghost.appendChild(this.badge);
    options.host.appendChild(this.ghost);
    this.layout();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    for (const handle of Object.values(this.handles)) handle.hidden = !enabled;
  }

  /** Moves the handles onto the terminal's current right and bottom edges. */
  layout(): void {
    const geometry = this.options.geometry();
    if (!geometry) return;
    const { width, height } = geometry.screen;
    place(this.handles.right, width - EDGE / 2, 0, EDGE, Math.max(0, height - CORNER));
    place(this.handles.bottom, 0, height - EDGE / 2, Math.max(0, width - CORNER), EDGE);
    place(this.handles.corner, width - CORNER, height - CORNER, CORNER, CORNER);
  }

  dispose(): void {
    for (const handle of Object.values(this.handles)) handle.remove();
    this.ghost.remove();
  }

  private start(event: PointerEvent, handle: HTMLElement, axes: Axes): void {
    if (!this.enabled || this.dragging || event.button !== 0) return;
    const geometry = this.options.geometry();
    if (!geometry) return;
    // Keeps the terminal's focus and the page's text selection where they are.
    event.preventDefault();
    event.stopPropagation();
    this.dragging = true;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing");
    const origin = { x: event.clientX, y: event.clientY };
    let wanted = { cols: geometry.cols, rows: geometry.rows };

    const show = () => {
      this.ghost.style.width = `${wanted.cols * geometry.cell.width}px`;
      this.ghost.style.height = `${wanted.rows * geometry.cell.height}px`;
      this.badge.textContent = `${wanted.cols} × ${wanted.rows}`;
      this.ghost.hidden = false;
    };
    const move = (e: PointerEvent) => {
      const travel = { dx: e.clientX - origin.x, dy: e.clientY - origin.y };
      wanted = dragResize(geometry, travel, geometry.cell, geometry.area, axes);
      show();
    };
    const finish = (commit: boolean) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", cancel);
      handle.removeEventListener("lostpointercapture", cancel);
      window.removeEventListener("keydown", key, true);
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      document.body.classList.remove("resizing");
      this.ghost.hidden = true;
      this.dragging = false;
      if (commit && (wanted.cols !== geometry.cols || wanted.rows !== geometry.rows)) {
        this.options.commit(wanted.cols, wanted.rows);
      }
    };
    const up = (e: PointerEvent) => {
      move(e);
      finish(true);
    };
    const cancel = () => finish(false);
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", cancel);
    handle.addEventListener("lostpointercapture", cancel);
    window.addEventListener("keydown", key, true);
    show();
  }
}

function place(element: HTMLElement, left: number, top: number, width: number, height: number): void {
  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
  element.style.width = `${width}px`;
  element.style.height = `${height}px`;
}
