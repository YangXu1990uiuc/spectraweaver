// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { el, formatGrid, type Grid, loadSetting, saveSetting } from "./dom.ts";
import {
  type Area,
  coverage,
  DEFAULT_TEXT_PX,
  type FontMetrics,
  fitTextPx,
  MAX_TEXT_PX,
  MIN_TEXT_PX,
  recommendSize,
} from "./sizing.ts";

export interface NewTerminalContext {
  /** The tile area of the current tab's grid, and that grid. */
  tile(): { area: Area; grid: Grid };
  font(): FontMetrics;
  create(request: { cols: number; rows: number; cwd?: string; cmd?: string }): void;
}

const MAX_COLS = 1000;
const MAX_ROWS = 500;

/**
 * The size fields are pre-filled with a recommendation: the shape of the current layout's
 * tiles at the user's preferred text size, which is learned from the sizes they create.
 */
export function createNewTerminalDialog(context: NewTerminalContext): {
  element: HTMLDialogElement;
  open(): void;
} {
  const cols = el("input", { type: "number", min: "20", max: String(MAX_COLS), step: "1", class: "size-input", "aria-label": "columns" });
  const rows = el("input", { type: "number", min: "5", max: String(MAX_ROWS), step: "1", class: "size-input", "aria-label": "rows" });
  // A text size describes the same choice as columns x rows in one tile; editing either sets the other.
  const text = el("input", { type: "number", min: "4", max: "72", step: "0.25", class: "size-input", "aria-label": "text size in pixels" });
  const recommend = el("button", { type: "button", class: "link-btn" });
  const hint = el("p", { class: "hint" });
  const cwd = el("input", { placeholder: "~ (home)", spellcheck: "false" });
  const cmd = el("input", { placeholder: "optional, e.g. claude", spellcheck: "false" });
  const error = el("p", { class: "error" });
  const cancel = el("button", { type: "button" }, ["Cancel"]);
  const form = el("form", { method: "dialog" }, [
    el("h2", {}, ["New terminal"]),
    el("div", { class: "field" }, [
      el("span", {}, ["Size in columns × rows (changed later by resizing the terminal)"]),
      el("div", { class: "size-row" }, [cols, el("span", {}, ["×"]), rows, recommend]),
    ]),
    el("div", { class: "field" }, [
      el("span", {}, ["Text size, in pixels, in one tile of the current grid"]),
      el("div", { class: "size-row" }, [text, el("span", {}, ["px"])]),
      hint,
    ]),
    el("label", { class: "field" }, ["Working directory", cwd]),
    el("label", { class: "field" }, ["Startup command", cmd]),
    error,
    el("div", { class: "actions" }, [cancel, el("button", { type: "submit", class: "primary" }, ["Create"])]),
  ]);
  const dialog = el("dialog", { class: "new-dialog" }, [form]);

  let tile = context.tile();
  let font = context.font();

  const preferredTextPx = () => {
    const value = Number(loadSetting("textPx", String(DEFAULT_TEXT_PX)));
    return Number.isFinite(value) ? Math.min(MAX_TEXT_PX, Math.max(MIN_TEXT_PX, value)) : DEFAULT_TEXT_PX;
  };
  const size = (): [number, number] | null => {
    const c = Number(cols.value);
    const r = Number(rows.value);
    return Number.isInteger(c) && Number.isInteger(r) && c >= 2 && r >= 1 && c <= MAX_COLS && r <= MAX_ROWS
      ? [c, r]
      : null;
  };
  const textSize = (): number | null => {
    const px = Number(text.value);
    return Number.isFinite(px) && px >= 4 && px <= 72 ? px : null;
  };
  const updateHint = () => {
    const chosen = size();
    if (!chosen || tile.area.width < 10 || tile.area.height < 10) {
      hint.textContent = "";
      return;
    }
    const covered = coverage(tile.area, chosen[0], chosen[1], font);
    const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;
    hint.textContent = `Fills ${percent(covered.width)} of a ${formatGrid(tile.grid)} tile's width and ${percent(covered.height)} of its height.`;
  };
  const fromCells = () => {
    const chosen = size();
    if (chosen && tile.area.width >= 10 && tile.area.height >= 10) text.value = fitTextPx(tile.area, chosen[0], chosen[1], font).toFixed(2);
    updateHint();
  };
  const fromText = () => {
    const px = textSize();
    if (px) {
      const recommended = recommendSize(tile.area, font, px);
      cols.value = String(recommended.cols);
      rows.value = String(recommended.rows);
    }
    updateHint();
  };
  const fillRecommended = () => {
    text.value = preferredTextPx().toFixed(2);
    fromText();
  };

  cols.addEventListener("input", fromCells);
  rows.addEventListener("input", fromCells);
  text.addEventListener("input", fromText);
  recommend.addEventListener("click", fillRecommended);
  cancel.addEventListener("click", () => dialog.close());
  form.addEventListener("submit", (event) => {
    const chosen = size();
    if (!chosen) {
      event.preventDefault();
      error.textContent = `Columns must be 2–${MAX_COLS} and rows 1–${MAX_ROWS}.`;
      return;
    }
    // Remember the text size this choice implies, so the next recommendation matches it
    // even in a different layout.
    if (tile.area.width >= 10 && tile.area.height >= 10) {
      const px = textSize() ?? fitTextPx(tile.area, chosen[0], chosen[1], font);
      saveSetting("textPx", String(Math.min(MAX_TEXT_PX, Math.max(MIN_TEXT_PX, px)).toFixed(2)));
    }
    saveSetting("cwd", cwd.value.trim());
    context.create({
      cols: chosen[0],
      rows: chosen[1],
      cwd: cwd.value.trim() || undefined,
      cmd: cmd.value.trim() || undefined,
    });
  });

  return {
    element: dialog,
    open() {
      tile = context.tile();
      font = context.font();
      recommend.textContent = `↺ Recommended for the ${formatGrid(tile.grid)} grid`;
      fillRecommended();
      cwd.value = loadSetting("cwd", "");
      cmd.value = "";
      error.textContent = "";
      dialog.showModal();
      text.focus();
      text.select();
    },
  };
}
