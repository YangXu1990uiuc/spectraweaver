// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import type { Frame } from "../common/protocol.ts";
import type { Area } from "./sizing.ts";
import { DRAG_THRESHOLD_PX, type Edges, moveRect, type Rect, rectToFrame, resizeRect } from "./windows.ts";

/** What a window's chrome needs from the tile it belongs to. */
export interface WindowChromeOptions {
  /** The window itself, positioned by its frame; the handles are appended to it. */
  root: HTMLElement;
  /** Dragging it moves the window. Buttons and the ⠿ grip (drag-and-drop onto a tab) keep their jobs. */
  header: HTMLElement;
  /** The banner input: a press that does not become a drag focuses it for editing. */
  banner: HTMLInputElement;
  /** The terminal area, to measure what the window adds around it. */
  body: HTMLElement;
  /** The element the windows are positioned in; the resize outline is drawn there. */
  workspace: HTMLElement;
  /** The window's frame, or null while its tab is a grid (the chrome is idle then). */
  frame(): Frame | null;
  /** One terminal cell as drawn, to resize the terminal with the window; null resizes the window alone. */
  cell(): Area | null;
  /** The terminal's size now, for the badge and the axes a handle leaves alone. */
  size(): { cols: number; rows: number };
  /** A drag ended on a new place or size; with `cells`, the terminal is to take that size too. */
  commit(frame: Frame, cells: { cols: number; rows: number } | null): void;
  /** A move was cancelled (Escape) or went nowhere: lay the window out from its frame again. */
  restore(): void;
  /** The window was pressed: bring it to the front. */
  raise(): void;
}

type Side = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const SIDES: Record<Side, Edges> = {
  n: { top: true, bottom: false, left: false, right: false },
  s: { top: false, bottom: true, left: false, right: false },
  e: { top: false, bottom: false, left: false, right: true },
  w: { top: false, bottom: false, left: true, right: false },
  ne: { top: true, bottom: false, left: false, right: true },
  nw: { top: true, bottom: false, left: true, right: false },
  se: { top: false, bottom: true, left: false, right: true },
  sw: { top: false, bottom: true, left: true, right: false },
};

/**
 * The chrome of a terminal's window under the "windows" layout (DESIGN.md §4.5): the header
 * moves it, the edges and corners resize it, as a window manager does. A move shows live; a
 * resize shows a dashed outline with the size it will take (whole cells at the current text
 * size when the terminal resizes with the window) and applies on release. Pointer capture keeps
 * a drag going when the pointer leaves the window; Escape cancels.
 */
export class WindowChrome {
  private readonly handles: HTMLDivElement[] = [];
  private readonly ghost: HTMLDivElement;
  private readonly badge: HTMLSpanElement;
  private enabled = false;
  private dragging = false;

  constructor(private readonly options: WindowChromeOptions) {
    for (const side of Object.keys(SIDES) as Side[]) {
      const handle = document.createElement("div");
      handle.className = `win-edge win-${side}`;
      handle.hidden = true;
      handle.addEventListener("pointerdown", (event) => this.startResize(event, handle, SIDES[side]));
      options.root.appendChild(handle);
      this.handles.push(handle);
    }
    this.badge = document.createElement("span");
    this.badge.className = "resize-badge";
    this.ghost = document.createElement("div");
    this.ghost.className = "win-ghost";
    this.ghost.hidden = true;
    this.ghost.appendChild(this.badge);
    options.header.addEventListener("pointerdown", (event) => this.startMove(event));
    // Any press on the window brings it to the front, before the target handles the press.
    options.root.addEventListener(
      "pointerdown",
      () => {
        if (this.enabled) options.raise();
      },
      true,
    );
  }

  /** On while the tab is laid out as windows. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    for (const handle of this.handles) handle.hidden = !enabled;
  }

  dispose(): void {
    for (const handle of this.handles) handle.remove();
    this.ghost.remove();
  }

  private workspaceArea(): Area | null {
    const { clientWidth: width, clientHeight: height } = this.options.workspace;
    return width >= 10 && height >= 10 ? { width, height } : null;
  }

  /** The window as laid out now, in CSS px within the workspace. */
  private currentRect(): Rect {
    const { offsetLeft: left, offsetTop: top, offsetWidth: width, offsetHeight: height } = this.options.root;
    return { left, top, width, height };
  }

  private startMove(event: PointerEvent): void {
    if (!this.enabled || this.dragging || event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, select, .grip")) return;
    const frame = this.options.frame();
    const workspace = this.workspaceArea();
    if (!frame || !workspace) return;
    const { header, banner, root } = this.options;
    const onBanner = target === banner || banner.contains(target);
    // No focus change or text selection on the press; a click on the banner edits it on release.
    event.preventDefault();
    this.dragging = true;
    header.setPointerCapture(event.pointerId);
    const origin = { x: event.clientX, y: event.clientY };
    const start = this.currentRect();
    let rect = start;
    let moved = false;

    const move = (e: PointerEvent) => {
      const travel = { dx: e.clientX - origin.x, dy: e.clientY - origin.y };
      if (!moved && Math.hypot(travel.dx, travel.dy) < DRAG_THRESHOLD_PX) return;
      if (!moved) {
        moved = true;
        document.body.classList.add("moving-window");
      }
      rect = moveRect(start, travel, workspace);
      root.style.left = `${rect.left}px`;
      root.style.top = `${rect.top}px`;
    };
    const finish = (commit: boolean) => {
      header.removeEventListener("pointermove", move);
      header.removeEventListener("pointerup", up);
      header.removeEventListener("pointercancel", cancel);
      header.removeEventListener("lostpointercapture", cancel);
      window.removeEventListener("keydown", key, true);
      if (header.hasPointerCapture(event.pointerId)) header.releasePointerCapture(event.pointerId);
      document.body.classList.remove("moving-window");
      this.dragging = false;
      if (moved) {
        if (commit && (rect.left !== start.left || rect.top !== start.top)) {
          this.options.commit(rectToFrame(rect, workspace, frame.z), null);
        } else {
          this.options.restore();
        }
      } else if (commit && onBanner) {
        banner.focus();
        banner.select();
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
    header.addEventListener("pointermove", move);
    header.addEventListener("pointerup", up);
    header.addEventListener("pointercancel", cancel);
    header.addEventListener("lostpointercapture", cancel);
    window.addEventListener("keydown", key, true);
  }

  private startResize(event: PointerEvent, handle: HTMLElement, edges: Edges): void {
    if (!this.enabled || this.dragging || event.button !== 0) return;
    const frame = this.options.frame();
    const workspace = this.workspaceArea();
    if (!frame || !workspace) return;
    event.preventDefault();
    event.stopPropagation();
    this.dragging = true;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing");
    const origin = { x: event.clientX, y: event.clientY };
    const start = this.currentRect();
    const { body } = this.options;
    const current = this.options.size();
    const limits = {
      workspace,
      chrome: { width: start.width - body.clientWidth, height: start.height - body.clientHeight },
      cell: this.options.cell(),
      current,
    };
    let result = resizeRect(start, { dx: 0, dy: 0 }, edges, limits);

    const show = () => {
      const { rect, cells } = result;
      this.ghost.style.left = `${rect.left}px`;
      this.ghost.style.top = `${rect.top}px`;
      this.ghost.style.width = `${rect.width}px`;
      this.ghost.style.height = `${rect.height}px`;
      this.badge.textContent = cells
        ? `${cells.cols} × ${cells.rows}`
        : `${Math.round(rect.width)} × ${Math.round(rect.height)} px`;
      if (this.ghost.parentElement !== this.options.workspace) this.options.workspace.appendChild(this.ghost);
      this.ghost.hidden = false;
    };
    const move = (e: PointerEvent) => {
      result = resizeRect(start, { dx: e.clientX - origin.x, dy: e.clientY - origin.y }, edges, limits);
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
      const { rect, cells } = result;
      const sameRect =
        rect.left === start.left && rect.top === start.top && rect.width === start.width && rect.height === start.height;
      if (!commit || sameRect) return;
      const resized = cells && (cells.cols !== current.cols || cells.rows !== current.rows) ? cells : null;
      this.options.commit(rectToFrame(rect, workspace, frame.z), resized);
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
