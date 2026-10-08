// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { SIZE_LIMITS } from "../common/protocol.ts";
import { el } from "./dom.ts";
import { type Area, cellAt, cellsThatFit, coverage, type FontMetrics, fitTextPx } from "./sizing.ts";
import { SNAP_SLACK_PX } from "./windows.ts";

/** The text sizes the dialog accepts, in CSS px: the renderer's own range, give or take. */
const MIN_DIALOG_TEXT_PX = 4;
const MAX_DIALOG_TEXT_PX = 72;

/** The terminal a resize dialog edits, measured by the tile that opens it. */
export interface ResizeTarget {
  /** The terminal's banner, title or id, for the heading. */
  name: string;
  cols: number;
  rows: number;
  /** The tile's terminal area in this browser. */
  area: Area;
  /** The font's cell shape, from the font itself (measureFont). */
  font: FontMetrics;
  /** The text size as drawn now, in CSS px; the dialog starts from it. */
  textPx: number;
  /** Resize to cols x rows and show the text at textPx (the fit of that grid in the area). */
  commit(cols: number, rows: number, textPx: number): void;
}

/**
 * Exact numbers for a resize, for those who want them instead of dragging the edges, and the
 * warning that goes with resizing: programs are told and redraw. The size can be given either
 * way: as columns x rows, which shows the text size they imply in this tile, or as a text size
 * in pixels, which fills the tile with the most cells at that size. Submitting applies both, so
 * the tile shows exactly what the dialog said (DESIGN.md §4.3).
 */
export function createResizeDialog(): { element: HTMLDialogElement; open(target: ResizeTarget): void } {
  const cols = el("input", {
    type: "number",
    min: String(SIZE_LIMITS.minCols),
    max: String(SIZE_LIMITS.maxCols),
    step: "1",
    class: "size-input",
    "aria-label": "columns",
  });
  const rows = el("input", {
    type: "number",
    min: String(SIZE_LIMITS.minRows),
    max: String(SIZE_LIMITS.maxRows),
    step: "1",
    class: "size-input",
    "aria-label": "rows",
  });
  const text = el("input", {
    type: "number",
    min: String(MIN_DIALOG_TEXT_PX),
    max: String(MAX_DIALOG_TEXT_PX),
    step: "0.25",
    class: "size-input",
    "aria-label": "text size in pixels",
  });
  const hint = el("p", { class: "hint" });
  const error = el("p", { class: "error" });
  const cancel = el("button", { type: "button" }, ["Cancel"]);
  const heading = el("h2", {}, ["Resize terminal"]);
  const form = el("form", { method: "dialog" }, [
    heading,
    el("div", { class: "field" }, [
      el("span", {}, ["Size in columns × rows"]),
      el("div", { class: "size-row" }, [cols, el("span", {}, ["×"]), rows]),
    ]),
    el("div", { class: "field" }, [
      el("span", {}, ["Text size, in pixels (fills the terminal's area with the most cells at that size)"]),
      el("div", { class: "size-row" }, [text, el("span", {}, ["px"])]),
      hint,
    ]),
    el("p", { class: "hint" }, [
      "The program is told the new size and redraws. Full-screen programs redraw cleanly; inline tools " +
        "that reprint their output when the width changes (Codex, Gemini CLI) clear the screen and lose " +
        "their scrollback.",
    ]),
    error,
    el("div", { class: "actions" }, [cancel, el("button", { type: "submit", class: "primary" }, ["Resize"])]),
  ]);
  const dialog = el("dialog", { class: "resize-dialog" }, [form]);
  let target: ResizeTarget | null = null;

  /** The area a window leaves its cells (a snapped window keeps SNAP_SLACK_PX after them). */
  const room = (): Area | null =>
    target ? { width: Math.max(10, target.area.width - SNAP_SLACK_PX), height: Math.max(10, target.area.height - SNAP_SLACK_PX) } : null;
  const size = (): [number, number] | null => {
    const c = Number(cols.value);
    const r = Number(rows.value);
    const ok =
      Number.isInteger(c) &&
      Number.isInteger(r) &&
      c >= SIZE_LIMITS.minCols &&
      c <= SIZE_LIMITS.maxCols &&
      r >= SIZE_LIMITS.minRows &&
      r <= SIZE_LIMITS.maxRows;
    return ok ? [c, r] : null;
  };
  const textSize = (): number | null => {
    const px = Number(text.value);
    return Number.isFinite(px) && px >= MIN_DIALOG_TEXT_PX && px <= MAX_DIALOG_TEXT_PX ? px : null;
  };
  const updateHint = () => {
    const chosen = size();
    const area = room();
    if (!target || !chosen || !area || target.area.width < 10 || target.area.height < 10) {
      hint.textContent = "";
      return;
    }
    const covered = coverage(area, chosen[0], chosen[1], target.font);
    const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;
    hint.textContent = `Fills ${percent(covered.width)} of the area's width and ${percent(covered.height)} of its height.`;
  };
  // Columns x rows and the text size describe the same thing in this area; editing one sets the other.
  const fromCells = () => {
    const chosen = size();
    const area = room();
    if (target && chosen && area) text.value = fitTextPx(area, chosen[0], chosen[1], target.font).toFixed(2);
    updateHint();
  };
  const fromText = () => {
    const px = textSize();
    const area = room();
    if (target && px && area) {
      const fit = cellsThatFit(area, cellAt(target.font, px));
      cols.value = String(fit.cols);
      rows.value = String(fit.rows);
    }
    updateHint();
  };

  cols.addEventListener("input", fromCells);
  rows.addEventListener("input", fromCells);
  text.addEventListener("input", fromText);
  cancel.addEventListener("click", () => dialog.close());
  form.addEventListener("submit", (event) => {
    const chosen = size();
    const area = room();
    if (!chosen || !target || !area) {
      event.preventDefault();
      error.textContent =
        `Columns must be ${SIZE_LIMITS.minCols}–${SIZE_LIMITS.maxCols} ` +
        `and rows ${SIZE_LIMITS.minRows}–${SIZE_LIMITS.maxRows}.`;
      return;
    }
    const px = textSize() ?? fitTextPx(area, chosen[0], chosen[1], target.font);
    target.commit(chosen[0], chosen[1], px);
  });

  return {
    element: dialog,
    open(next) {
      target = next;
      heading.textContent = `Resize ${next.name}`;
      cols.value = String(next.cols);
      rows.value = String(next.rows);
      text.value = next.textPx.toFixed(2);
      error.textContent = "";
      updateHint();
      dialog.showModal();
      text.focus();
      text.select();
    },
  };
}
