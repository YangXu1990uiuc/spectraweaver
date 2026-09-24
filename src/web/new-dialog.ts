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
  const recommend = el("button", { type: "button", class: "link-btn" });
  const hint = el("p", { class: "hint" });
  const cwd = el("input", { placeholder: "~ (home)", spellcheck: "false" });
  const cmd = el("input", { placeholder: "optional, e.g. claude", spellcheck: "false" });
  const error = el("p", { class: "error" });
  const cancel = el("button", { type: "button" }, ["Cancel"]);
  const form = el("form", { method: "dialog" }, [
    el("h2", {}, ["New terminal"]),
    el("div", { class: "field" }, [
      el("span", {}, ["Size in columns × rows (fixed for the life of the terminal)"]),
      el("div", { class: "size-row" }, [cols, el("span", {}, ["×"]), rows, recommend]),
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
  const updateHint = () => {
    const chosen = size();
    if (!chosen || tile.area.width < 10 || tile.area.height < 10) {
      hint.textContent = "";
      return;
    }
    const px = fitTextPx(tile.area, chosen[0], chosen[1], font);
    const covered = coverage(tile.area, chosen[0], chosen[1], font);
    const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;
    hint.textContent =
      `≈ ${px.toFixed(1)} px text in one tile of the ${formatGrid(tile.grid)} grid · ` +
      `fills ${percent(covered.width)} of its width and ${percent(covered.height)} of its height`;
  };
  const fillRecommended = () => {
    const recommended = recommendSize(tile.area, font, preferredTextPx());
    cols.value = String(recommended.cols);
    rows.value = String(recommended.rows);
    updateHint();
  };

  cols.addEventListener("input", updateHint);
  rows.addEventListener("input", updateHint);
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
      const px = fitTextPx(tile.area, chosen[0], chosen[1], font);
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
      cols.focus();
      cols.select();
    },
  };
}
