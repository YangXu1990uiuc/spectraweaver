// Copyright 2026 The workstreams Authors
// SPDX-License-Identifier: Apache-2.0
// Part of workstreams: https://github.com/YangXu1990uiuc/workstreams

import { TAB_COLORS, type TabView } from "../common/protocol.ts";
import { el } from "./dom.ts";

/** Drag type for moving a session's tile onto a tab. */
export const SESSION_DRAG_TYPE = "application/x-workstreams-session";
const TAB_DRAG_TYPE = "application/x-workstreams-tab";

export interface TabStripHandlers {
  select(id: string): void;
  create(): void;
  rename(id: string, name: string): void;
  recolor(id: string, color: string): void;
  remove(id: string): void;
  move(id: string, index: number): void;
  openInWindow(id: string): void;
  moveSession(sessionId: string, tabId: string): void;
}

export interface TabStripState {
  tabs: TabView[];
  activeId: string | null;
  counts: Map<string, number>;
  alerts: Set<string>;
}

/** The workspace tabs in the top bar. */
export class TabStrip {
  readonly element: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private state: TabStripState = { tabs: [], activeId: null, counts: new Map(), alerts: new Set() };
  private menu: HTMLDivElement | null = null;
  private editing: string | null = null;
  private renameWhenShown: string | null = null;

  constructor(private readonly handlers: TabStripHandlers) {
    this.list = el("div", { class: "tab-list", role: "tablist" });
    const add = el("button", { class: "tab-add", title: "New tab" }, ["+"]);
    add.addEventListener("click", () => handlers.create());
    this.element = el("div", { class: "tabs" }, [this.list, add]);
    // A plain mouse wheel scrolls the tab strip sideways when tabs overflow.
    this.list.addEventListener(
      "wheel",
      (event) => {
        if (event.deltaX !== 0 || this.list.scrollWidth <= this.list.clientWidth) return;
        event.preventDefault();
        this.list.scrollLeft += event.deltaY;
      },
      { passive: false },
    );
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (this.menu && !this.menu.contains(event.target as Node)) this.closeMenu();
      },
      true,
    );
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.closeMenu();
    });
  }

  /** Starts renaming the tab once it appears (after the server confirms it). */
  renameOnArrival(id: string): void {
    this.renameWhenShown = id;
  }

  render(state: TabStripState): void {
    this.state = state;
    if (this.editing) return; // don't yank the input away mid-rename
    this.list.replaceChildren(...state.tabs.map((tab, index) => this.renderTab(tab, index)));
    this.list.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (this.renameWhenShown && state.tabs.some((tab) => tab.id === this.renameWhenShown)) {
      const id = this.renameWhenShown;
      this.renameWhenShown = null;
      this.startRename(id);
    }
  }

  private renderTab(tab: TabView, index: number): HTMLElement {
    const active = tab.id === this.state.activeId;
    const count = this.state.counts.get(tab.id) ?? 0;
    const item = el(
      "div",
      {
        class: active ? "tab active" : "tab",
        role: "tab",
        "aria-selected": String(active),
        draggable: "true",
        title: `${tab.name} (${count} terminal${count === 1 ? "" : "s"})`,
        "data-id": tab.id,
      },
      [
        el("span", { class: "tab-name" }, [tab.name]),
        el("span", { class: "tab-count" }, [String(count)]),
      ],
    );
    item.style.setProperty("--tab-color", tab.color);
    if (this.state.alerts.has(tab.id)) {
      item.append(el("span", { class: "tab-alert", title: "A terminal here wants attention" }, ["●"]));
    }
    const more = el("button", { class: "tab-more", title: "Tab options" }, ["⋯"]);
    item.append(more);

    item.addEventListener("click", (event) => {
      if (event.target !== more) this.handlers.select(tab.id);
    });
    item.addEventListener("dblclick", () => this.startRename(tab.id));
    item.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.openMenu(tab, event.clientX, event.clientY);
    });
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      const rect = more.getBoundingClientRect();
      this.openMenu(tab, rect.left, rect.bottom + 2);
    });

    item.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData(TAB_DRAG_TYPE, tab.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    item.addEventListener("dragover", (event) => {
      const types = event.dataTransfer?.types ?? [];
      if (!types.includes(TAB_DRAG_TYPE) && !types.includes(SESSION_DRAG_TYPE)) return;
      event.preventDefault();
      item.classList.add("drop-target");
    });
    item.addEventListener("dragleave", () => item.classList.remove("drop-target"));
    item.addEventListener("drop", (event) => {
      event.preventDefault();
      item.classList.remove("drop-target");
      const sessionId = event.dataTransfer?.getData(SESSION_DRAG_TYPE);
      if (sessionId) {
        this.handlers.moveSession(sessionId, tab.id);
        return;
      }
      const draggedTab = event.dataTransfer?.getData(TAB_DRAG_TYPE);
      if (draggedTab && draggedTab !== tab.id) this.handlers.move(draggedTab, index);
    });
    return item;
  }

  private startRename(id: string): void {
    const item = this.list.querySelector<HTMLElement>(`.tab[data-id="${id}"]`);
    const tab = this.state.tabs.find((candidate) => candidate.id === id);
    if (!item || !tab) return;
    this.closeMenu();
    this.editing = id;
    const input = el("input", { class: "tab-rename", value: tab.name, maxlength: "60", spellcheck: "false" });
    item.draggable = false;
    item.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      this.editing = null;
      const name = input.value.trim();
      if (commit && name && name !== tab.name) this.handlers.rename(id, name);
      this.render(this.state);
    };
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") finish(true);
      else if (event.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", (event) => event.stopPropagation());
  }

  private openMenu(tab: TabView, x: number, y: number): void {
    this.closeMenu();
    const item = (label: string, action: () => void, disabled = false) => {
      const button = el("button", { class: "item" }, [label]);
      button.disabled = disabled;
      button.addEventListener("click", () => {
        this.closeMenu();
        action();
      });
      return button;
    };
    const swatches = el(
      "div",
      { class: "swatches" },
      TAB_COLORS.map((color) => {
        const swatch = el("button", { class: color === tab.color ? "swatch selected" : "swatch", title: color });
        swatch.style.background = color;
        swatch.addEventListener("click", () => {
          this.closeMenu();
          this.handlers.recolor(tab.id, color);
        });
        return swatch;
      }),
    );
    const menu = el("div", { class: "menu", role: "menu" }, [
      item("Rename", () => this.startRename(tab.id)),
      swatches,
      item("Open in new window", () => this.handlers.openInWindow(tab.id)),
      item("Delete tab…", () => this.handlers.remove(tab.id), this.state.tabs.length <= 1),
    ]);
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
    this.menu = menu;
  }

  private closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
  }
}
