// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

// The page's small menus (a tab's, a window's, a task's), one open at a time. A press anywhere
// outside, Escape, or the page losing focus closes it.

import { el } from "./dom.ts";

export interface MenuItem {
  label: string;
  action(): void;
  disabled?: boolean;
  /** It ends something: shown in red. */
  danger?: boolean;
  /** A terminal's colour, as a mark before the label. */
  color?: string;
  /** A few muted words after the label, such as a terminal's state. */
  note?: string;
}

/** An item, "-" for a line between groups, or an element shown as it is. */
export type MenuEntry = MenuItem | "-" | HTMLElement;

let shown: HTMLElement | null = null;

export function closeMenu(): void {
  shown?.remove();
  shown = null;
}

/** Opens a menu with its top-left at (x, y) in the viewport, moved in to fit it. */
export function openMenu(entries: readonly MenuEntry[], x: number, y: number): void {
  closeMenu();
  const menu = el("div", { class: "menu", role: "menu" });
  for (const entry of entries) {
    if (entry === "-") menu.appendChild(el("div", { class: "menu-sep", role: "separator" }));
    else if (entry instanceof HTMLElement) menu.appendChild(entry);
    else menu.appendChild(button(entry));
  }
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  shown = menu;
}

function button(item: MenuItem): HTMLButtonElement {
  const button = el("button", { class: item.danger ? "item danger" : "item", role: "menuitem", type: "button" });
  if (item.color) {
    const swatch = el("span", { class: "menu-swatch" });
    swatch.style.background = `color-mix(in srgb, ${item.color} 50%, white)`;
    button.appendChild(swatch);
  }
  button.appendChild(el("span", { class: "menu-label" }, [item.label]));
  if (item.note) button.appendChild(el("span", { class: "menu-note" }, [item.note]));
  button.disabled = item.disabled === true;
  button.addEventListener("click", () => {
    closeMenu();
    item.action();
  });
  return button;
}

document.addEventListener(
  "pointerdown",
  (event) => {
    if (shown && !shown.contains(event.target as Node)) closeMenu();
  },
  true,
);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenu();
});
window.addEventListener("blur", () => closeMenu());
window.addEventListener("resize", () => closeMenu());
