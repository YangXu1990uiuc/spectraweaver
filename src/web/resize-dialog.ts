// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { SIZE_LIMITS } from "../common/protocol.ts";
import { el } from "./dom.ts";
import { type Area, coverage, type FontMetrics, fitTextPx } from "./sizing.ts";

/** The terminal a resize dialog edits, measured by the tile that opens it. */
export interface ResizeTarget {
  /** The terminal's banner, title or id, for the heading. */
  name: string;
  cols: number;
  rows: number;
  /** The tile's terminal area in this browser, for the hint. */
  area: Area;
  /** The font's cell shape as drawn now, for the hint. */
  font: FontMetrics;
  /** The size that fills the tile at the current text size. */
  fill: { cols: number; rows: number };
  commit(cols: number, rows: number): void;
}

/**
 * Exact numbers for a resize, for those who want them instead of dragging the terminal's
 * edges, and the warning that goes with resizing: programs are told and redraw.
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
  const fillButton = el("button", { type: "button", class: "link-btn" }, ["Fill the tile at this text size"]);
  const hint = el("p", { class: "hint" });
  const error = el("p", { class: "error" });
  const cancel = el("button", { type: "button" }, ["Cancel"]);
  const heading = el("h2", {}, ["Resize terminal"]);
  const form = el("form", { method: "dialog" }, [
    heading,
    el("div", { class: "field" }, [
      el("span", {}, ["Size in columns × rows"]),
      el("div", { class: "size-row" }, [cols, el("span", {}, ["×"]), rows, fillButton]),
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
  const updateHint = () => {
    const chosen = size();
    if (!target || !chosen || target.area.width < 10 || target.area.height < 10) {
      hint.textContent = "";
      return;
    }
    const px = fitTextPx(target.area, chosen[0], chosen[1], target.font);
    const covered = coverage(target.area, chosen[0], chosen[1], target.font);
    const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;
    hint.textContent =
      `≈ ${px.toFixed(1)} px text at 100% zoom in this tile · ` +
      `fills ${percent(covered.width)} of its width and ${percent(covered.height)} of its height`;
  };

  cols.addEventListener("input", updateHint);
  rows.addEventListener("input", updateHint);
  fillButton.addEventListener("click", () => {
    if (!target) return;
    cols.value = String(target.fill.cols);
    rows.value = String(target.fill.rows);
    updateHint();
  });
  cancel.addEventListener("click", () => dialog.close());
  form.addEventListener("submit", (event) => {
    const chosen = size();
    if (!chosen) {
      event.preventDefault();
      error.textContent =
        `Columns must be ${SIZE_LIMITS.minCols}–${SIZE_LIMITS.maxCols} ` +
        `and rows ${SIZE_LIMITS.minRows}–${SIZE_LIMITS.maxRows}.`;
      return;
    }
    target?.commit(chosen[0], chosen[1]);
  });

  return {
    element: dialog,
    open(next) {
      target = next;
      heading.textContent = `Resize ${next.name}`;
      cols.value = String(next.cols);
      rows.value = String(next.rows);
      error.textContent = "";
      updateHint();
      dialog.showModal();
      cols.focus();
      cols.select();
    },
  };
}
