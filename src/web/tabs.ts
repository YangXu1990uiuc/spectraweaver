// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { TAB_COLORS, type TabView } from "../common/protocol.ts";
import { el } from "./dom.ts";

/** Drag type for moving a session's tile onto a tab. */
export const SESSION_DRAG_TYPE = "application/x-spectraweaver-session";
const TAB_DRAG_TYPE = "application/x-spectraweaver-tab";

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

interface TabItem {
  root: HTMLDivElement;
  name: HTMLSpanElement;
  count: HTMLSpanElement;
  alert: HTMLSpanElement;
  more: HTMLButtonElement;
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
  private readonly items = new Map<string, TabItem>();
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

  /**
   * Updates the tabs in place. Agents change their terminal titles many times a second, and
   * each change re-renders; replacing the elements would swallow clicks and drops on them,
   * because the element under the pointer would be gone before the button is released.
   */
  render(state: TabStripState): void {
    const activeChanged = state.activeId !== this.state.activeId;
    this.state = state;
    if (this.editing) return; // don't yank the input away mid-rename
    this.element.style.setProperty("--tab-count", String(state.tabs.length));
    const ids = new Set(state.tabs.map((tab) => tab.id));
    for (const [id, item] of this.items) {
      if (!ids.has(id)) {
        item.root.remove();
        this.items.delete(id);
      }
    }
    state.tabs.forEach((tab, index) => {
      let item = this.items.get(tab.id);
      if (!item) {
        item = this.createItem(tab.id);
        this.items.set(tab.id, item);
      }
      this.updateItem(item, tab);
      // Move only elements that are out of place: moving one also swallows a click on it.
      if (this.list.children[index] !== item.root) this.list.insertBefore(item.root, this.list.children[index] ?? null);
    });
    if (activeChanged) this.list.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (this.renameWhenShown && ids.has(this.renameWhenShown)) {
      const id = this.renameWhenShown;
      this.renameWhenShown = null;
      this.startRename(id);
    }
  }

  private updateItem(item: TabItem, tab: TabView): void {
    const active = tab.id === this.state.activeId;
    const count = String(this.state.counts.get(tab.id) ?? 0);
    const title = `${tab.name} (${count} terminal${count === "1" ? "" : "s"})`;
    item.root.classList.toggle("active", active);
    item.root.setAttribute("aria-selected", String(active));
    if (item.root.title !== title) item.root.title = title;
    item.root.style.setProperty("--tab-color", tab.color);
    if (item.name.textContent !== tab.name) item.name.textContent = tab.name;
    if (item.count.textContent !== count) item.count.textContent = count;
    item.alert.hidden = !this.state.alerts.has(tab.id);
  }

  /** Builds a tab's elements once; its handlers look the tab up when they run. */
  private createItem(id: string): TabItem {
    const name = el("span", { class: "tab-name" });
    const count = el("span", { class: "tab-count" });
    const alert = el("span", { class: "tab-alert", title: "A terminal here wants attention", hidden: "" }, ["●"]);
    const more = el("button", { class: "tab-more", title: "Tab options" }, ["⋯"]);
    const root = el("div", { class: "tab", role: "tab", draggable: "true", "data-id": id }, [name, count, alert, more]);
    const current = () => this.state.tabs.find((tab) => tab.id === id);

    root.addEventListener("click", (event) => {
      if (event.target !== more) this.handlers.select(id);
    });
    root.addEventListener("dblclick", () => this.startRename(id));
    root.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const tab = current();
      if (tab) this.openMenu(tab, event.clientX, event.clientY);
    });
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      const tab = current();
      const rect = more.getBoundingClientRect();
      if (tab) this.openMenu(tab, rect.left, rect.bottom + 2);
    });

    root.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData(TAB_DRAG_TYPE, id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    root.addEventListener("dragover", (event) => {
      const types = event.dataTransfer?.types ?? [];
      if (!types.includes(TAB_DRAG_TYPE) && !types.includes(SESSION_DRAG_TYPE)) return;
      event.preventDefault();
      root.classList.add("drop-target");
    });
    root.addEventListener("dragleave", () => root.classList.remove("drop-target"));
    root.addEventListener("drop", (event) => {
      event.preventDefault();
      root.classList.remove("drop-target");
      const sessionId = event.dataTransfer?.getData(SESSION_DRAG_TYPE);
      if (sessionId) {
        this.handlers.moveSession(sessionId, id);
        return;
      }
      const draggedTab = event.dataTransfer?.getData(TAB_DRAG_TYPE);
      if (draggedTab && draggedTab !== id) {
        this.handlers.move(draggedTab, this.state.tabs.findIndex((tab) => tab.id === id));
      }
    });
    return { root, name, count, alert, more };
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
      // The input replaced the tab's contents: build the tab afresh.
      this.items.get(id)?.root.remove();
      this.items.delete(id);
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
        swatch.style.background = `color-mix(in srgb, ${color} 50%, white)`; // the tint the tab gets
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
