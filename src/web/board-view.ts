// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

// A tab's task board as a window (DESIGN.md §8.7): the tasks a coordinating agent pushed, as a
// graph of what waits for what, each card coloured by the status the agent gave it and marked
// with the live state of the terminal working on it. A click shows a task's details; a double
// click opens its terminal. The window moves, resizes and goes to the taskbar like a terminal's.

import type { BoardDirection, BoardTask, Frame, SessionView, TabView, TaskStatus } from "../common/protocol.ts";
import { type BoardLayout, type Direction, fitScale, layoutBoard, type Size } from "./board-layout.ts";
import { agoText, type TaskLive, taskLive } from "./board-live.ts";
import { el, loadSetting, saveSetting } from "./dom.ts";
import { WindowChrome } from "./window-chrome.ts";

const CARD: Size = { width: 192, height: 60 };
/** Past this many tasks, cards take one line. */
const COMPACT_AFTER = 30;
const COMPACT_CARD: Size = { width: 192, height: 34 };
/** "Fit" shrinks a large board to show all of it, but no smaller than this; past that, it scrolls. */
const MIN_SCALE = 0.3;
/** Zooming by hand: Ctrl + wheel, or Ctrl + = / - (0 fits the window again). */
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3;
const KEY_ZOOM = 1.2;
/** A press on the background that moves less than this is a click, not a pan. */
const PAN_THRESHOLD_PX = 4;
/** A tab's board window before anyone places it: the left of the tab. */
export const DEFAULT_BOARD_FRAME: Omit<Frame, "z"> = { x: 0, y: 0, w: 0.6, h: 1 };

const STATUS_LABEL: Record<TaskStatus, string> = { todo: "to do", wip: "in progress", done: "done", blocked: "blocked" };

/** The line a person gives an agent to make it keep the board. */
export const LEAD_PROMPT =
  "Use spectraweaver to run worker terminals and keep this tab's task board; run `spectraweaver board --help` first.";

export interface BoardWindowOptions {
  /** The element windows are positioned in. */
  workspace: HTMLElement;
  snap(): boolean;
  /** A task was double-clicked: show its terminal, or say why not. */
  openTerminal(task: BoardTask): void;
  /** Show a terminal (the lead's). */
  showTerminal(sessionId: string): void;
  hide(): void;
  /** Which way the graph runs, for every browser; "auto" lets the window's shape decide. */
  setDirection(direction: BoardDirection | "auto"): void;
  commit(frame: Frame): void;
  raise(): void;
  copy(text: string): void;
}

/**
 * A board's alarms: tasks marked red and amber, and of the red ones those no terminal window
 * shows (in progress, with no one working on them), which the tab's mark counts on top of its
 * terminals'.
 */
export function boardAlarms(
  tab: TabView,
  sessions: ReadonlyMap<string, SessionView>,
  now: number,
): { red: number; amber: number; unshown: number } {
  const counts = { red: 0, amber: 0, unshown: 0 };
  for (const task of tab.board?.tasks ?? []) {
    const session = task.session ? sessions.get(task.session) : undefined;
    const alarm = taskLive(task, session, now)?.alarm;
    if (alarm === "amber") counts.amber++;
    if (alarm !== "red") continue;
    counts.red++;
    if (!session || session.exited || !session.agent) counts.unshown++;
  }
  return counts;
}

export class BoardWindow {
  readonly root: HTMLElement;
  private readonly title: HTMLSpanElement;
  private readonly redCount: HTMLSpanElement;
  private readonly amberCount: HTMLSpanElement;
  private readonly summary: HTMLDivElement;
  private readonly progress: HTMLSpanElement;
  private readonly doneText: HTMLSpanElement;
  private readonly updated: HTMLSpanElement;
  private readonly leadButton: HTMLButtonElement;
  private readonly zoomLabel: HTMLButtonElement;
  private readonly directionButton: HTMLButtonElement;
  private readonly graph: HTMLDivElement;
  private readonly sizer: HTMLDivElement;
  private readonly canvas: HTMLDivElement;
  private readonly edges: { done: SVGPathElement; doneHeads: SVGPathElement; waiting: SVGPathElement; waitingHeads: SVGPathElement };
  private readonly svg: SVGSVGElement;
  private readonly detail: HTMLDivElement;
  private readonly empty: HTMLDivElement;
  private readonly cards = new Map<string, HTMLButtonElement>();
  private readonly chrome: WindowChrome;
  private readonly observer: ResizeObserver;
  private frame: Frame | null = null;
  private tab: TabView;
  private sessions: ReadonlyMap<string, SessionView> = new Map();
  private selected: string | null = null;
  private layout: BoardLayout | null = null;
  /** The board laid out both ways, for the tasks and dependencies it was laid out for. */
  private layouts: { key: string; ways: Record<Direction, BoardLayout> } | null = null;
  /** The zoom chosen by hand, per browser like a terminal's text size; null fits the window. */
  private zoom: number | null;
  /** The scale the graph is drawn at now. */
  private scale = 1;
  /** A pan just ended: the click that ends it does not clear the selection. */
  private panned = false;

  constructor(
    tab: TabView,
    private readonly options: BoardWindowOptions,
  ) {
    this.tab = tab;
    this.title = el("span", { class: "board-name" });
    this.redCount = el("span", { class: "badge agent stopped", hidden: "" });
    this.amberCount = el("span", { class: "badge agent waiting", hidden: "" });
    const hideButton = el("button", { class: "icon-btn", title: "Put away in the taskbar" }, ["—"]);
    hideButton.addEventListener("click", () => options.hide());
    const header = el("div", { class: "tile-header" }, [
      el("span", { class: "board-icon", "aria-hidden": "true" }, ["▦"]),
      this.title,
      el("span", { class: "spacer" }),
      this.redCount,
      this.amberCount,
      hideButton,
    ]);

    this.progress = el("span", { class: "board-progress", role: "img" });
    this.doneText = el("span", { class: "board-muted" });
    this.updated = el("span", { class: "board-muted" });
    this.leadButton = el("button", { class: "board-lead", hidden: "" });
    this.leadButton.addEventListener("click", () => {
      const lead = this.tab.board?.lead;
      if (lead) options.showTerminal(lead);
    });
    const zoomOut = el("button", { class: "icon-btn", title: "Zoom out (Ctrl + − or Ctrl + wheel)", "aria-label": "Zoom out" }, ["−"]);
    const zoomIn = el("button", { class: "icon-btn", title: "Zoom in (Ctrl + = or Ctrl + wheel)", "aria-label": "Zoom in" }, ["+"]);
    this.zoomLabel = el("button", { class: "board-zoom", title: "Fit the window (Ctrl + 0)" });
    zoomOut.addEventListener("click", () => this.zoomTo(this.scale / KEY_ZOOM));
    zoomIn.addEventListener("click", () => this.zoomTo(this.scale * KEY_ZOOM));
    this.zoomLabel.addEventListener("click", () => this.zoomTo(null));
    this.directionButton = el("button", { class: "board-direction" });
    this.directionButton.addEventListener("click", () => {
      const now = this.tab.boardWindow?.direction;
      options.setDirection(now === undefined ? "down" : now === "down" ? "right" : "auto");
    });
    this.summary = el("div", { class: "board-summary" }, [
      this.progress,
      this.doneText,
      el("span", { class: "spacer" }),
      this.updated,
      this.leadButton,
      el("span", { class: "board-view" }, [this.directionButton, zoomOut, this.zoomLabel, zoomIn]),
    ]);

    const svgNs = "http://www.w3.org/2000/svg";
    this.svg = document.createElementNS(svgNs, "svg");
    this.svg.setAttribute("class", "board-edges");
    this.svg.setAttribute("aria-hidden", "true");
    const path = (className: string) => {
      const element = document.createElementNS(svgNs, "path");
      element.setAttribute("class", className);
      this.svg.appendChild(element);
      return element;
    };
    this.edges = {
      waiting: path("edge waiting"),
      waitingHeads: path("edge-head waiting"),
      done: path("edge done"),
      doneHeads: path("edge-head done"),
    };
    this.canvas = el("div", { class: "board-canvas" });
    this.canvas.appendChild(this.svg);
    this.sizer = el("div", { class: "board-sizer" }, [this.canvas]);
    this.graph = el("div", { class: "board-graph", tabindex: "0", "aria-label": "Task graph" }, [this.sizer]);
    // A click on the background clears the selection; a drag there pans.
    this.graph.addEventListener("click", (event) => {
      if (this.panned) {
        this.panned = false;
        return;
      }
      if (event.target === this.graph || event.target === this.sizer || event.target === this.canvas) this.select(null);
    });
    this.graph.addEventListener("pointerdown", (event) => this.startPan(event));
    this.graph.addEventListener(
      "wheel",
      (event) => {
        if (!event.ctrlKey && !event.metaKey) return; // a plain wheel scrolls
        event.preventDefault();
        const rect = this.graph.getBoundingClientRect();
        // Pixel deltas from a trackpad pinch are small and many; line deltas from a wheel, few and large.
        const step = event.deltaMode === 1 ? 0.05 : 0.0015;
        this.zoomTo(this.scale * Math.exp(-event.deltaY * step), { x: event.clientX - rect.left, y: event.clientY - rect.top });
      },
      { passive: false },
    );
    this.detail = el("div", { class: "board-detail" });

    const prompt = el("textarea", { class: "board-prompt", readonly: "", rows: "2", "aria-label": "A line for the agent's prompt" });
    prompt.value = LEAD_PROMPT;
    const copyButton = el("button", {}, ["Copy"]);
    copyButton.addEventListener("click", () => {
      prompt.select();
      options.copy(LEAD_PROMPT);
    });
    this.empty = el("div", { class: "board-empty" }, [
      el("strong", {}, ["No board yet"]),
      el("p", {}, [
        "An agent coordinating others keeps this board: the tasks, what each waits for, and which terminal works on it. ",
        "Start one in a terminal of this tab (claude or codex) and add this to its prompt:",
      ]),
      el("div", { class: "board-prompt-row" }, [prompt, copyButton]),
      el("p", { class: "board-muted" }, [
        "How the work is split, where it is tracked and how often the board is pushed are for that prompt; SpectraWeaver only shows the board.",
      ]),
    ]);

    const body = el("div", { class: "board-body" }, [this.summary, this.graph, this.detail, this.empty]);
    this.root = el("section", { class: "tile board-window", "aria-label": "Task board" }, [header, body]);
    // Ctrl + = / - / 0 zoom the graph while anything in the board has the focus.
    this.root.addEventListener("keydown", (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || !["=", "+", "-", "_", "0"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "0") this.zoomTo(null);
      else this.zoomTo(event.key === "-" || event.key === "_" ? this.scale / KEY_ZOOM : this.scale * KEY_ZOOM);
    });
    const stored = Number(loadSetting(`boardZoom.${tab.id}`, ""));
    this.zoom = stored > 0 ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, stored)) : null;
    this.root.style.setProperty("--tile-color", "#90a4ae");
    this.chrome = new WindowChrome({
      root: this.root,
      header,
      body,
      workspace: options.workspace,
      frame: () => this.frame,
      cell: () => null,
      size: () => ({ cols: 0, rows: 0 }),
      snap: options.snap,
      commit: (frame) => {
        this.setFrame(frame);
        options.commit(frame);
      },
      restore: () => this.setFrame(this.frame),
      raise: options.raise,
    });
    this.observer = new ResizeObserver(() => this.relayout());
    this.observer.observe(this.graph);
  }

  get windowFrame(): Frame | null {
    return this.frame;
  }

  setFrame(frame: Frame | null): void {
    this.frame = frame;
    const style = this.root.style;
    if (frame) {
      style.left = `${(frame.x * 100).toFixed(2)}%`;
      style.top = `${(frame.y * 100).toFixed(2)}%`;
      style.width = `${(frame.w * 100).toFixed(2)}%`;
      style.height = `${(frame.h * 100).toFixed(2)}%`;
      style.zIndex = String(frame.z + 1);
    }
    this.chrome.setEnabled(frame !== null);
  }

  /** Shows the tab's board as it is now, with the terminals as they are now. */
  update(tab: TabView, sessions: ReadonlyMap<string, SessionView>): void {
    this.tab = tab;
    this.sessions = sessions;
    this.render();
  }

  /** Times shown relative to now ("3 min ago", "idle 12m") move on. */
  refresh(): void {
    this.render();
  }

  dispose(): void {
    this.observer.disconnect();
    this.chrome.dispose();
    this.root.remove();
  }

  private render(): void {
    const board = this.tab.board;
    const now = Date.now();
    this.title.textContent = board?.title || `${this.tab.name} board`;
    this.summary.hidden = !board;
    this.graph.hidden = !board;
    this.detail.hidden = !board;
    this.empty.hidden = board !== undefined;
    if (!board) {
      this.redCount.hidden = this.amberCount.hidden = true;
      return;
    }

    const lives = new Map<string, TaskLive | null>();
    for (const task of board.tasks) lives.set(task.id, taskLive(task, task.session ? this.sessions.get(task.session) : undefined, now));
    const { red, amber } = boardAlarms(this.tab, this.sessions, now);
    this.redCount.hidden = red === 0;
    this.redCount.textContent = `⚠ ${red} stopped`;
    this.redCount.title = "Tasks whose terminal stopped, or that are in progress with no one working on them";
    this.amberCount.hidden = amber === 0;
    this.amberCount.textContent = `${amber} waiting`;
    this.amberCount.title = "Tasks whose agent waits for an answer";

    this.renderSummary(now);
    this.relayout();
    this.renderCards(lives);
    this.renderDetail(lives);
  }

  private renderSummary(now: number): void {
    const board = this.tab.board!;
    const total = board.tasks.length;
    const count = (status: TaskStatus) => board.tasks.filter((task) => task.status === status).length;
    const done = count("done");
    this.progress.replaceChildren(
      ...(["done", "wip", "blocked"] as const).map((status) => {
        const segment = el("span", { class: `status-${status}` });
        segment.style.width = `${total > 0 ? (count(status) / total) * 100 : 0}%`;
        return segment;
      }),
    );
    this.progress.setAttribute(
      "aria-label",
      (["done", "wip", "blocked", "todo"] as const).map((status) => `${count(status)} ${STATUS_LABEL[status]}`).join(", "),
    );
    this.doneText.textContent = `${done}/${total} done`;
    const lead = board.lead ? this.sessions.get(board.lead) : undefined;
    this.updated.textContent = `${board.lead ? "lead updated" : "updated"} ${agoText(now - board.updatedAt)}`;
    this.updated.title = new Date(board.updatedAt).toLocaleString();
    this.leadButton.hidden = !lead;
    if (lead) {
      const live = taskLive({ id: "", title: "", status: "todo", session: lead.id }, lead, now);
      const badge = el("span", { class: `badge agent ${live?.kind ?? "idle"}` }, [live?.text || "shell"]);
      this.leadButton.replaceChildren(lead.banner || "lead", badge);
      this.leadButton.title = "Show the lead's terminal";
      this.leadButton.classList.toggle("alarm", live?.alarm === "red");
    }
  }

  /**
   * Lays the graph out again when its tasks or dependencies changed (both ways, which is the
   * costly part), takes the way that fits the window better, draws the arrows (their colour
   * follows the statuses) and fits the graph to the window.
   */
  private relayout(): void {
    const board = this.tab.board;
    if (!board || this.graph.hidden) return;
    const compact = board.tasks.length > COMPACT_AFTER;
    const key = JSON.stringify([compact, board.tasks.map((task) => [task.id, task.after ?? []])]);
    if (this.layouts?.key !== key) {
      const card = compact ? COMPACT_CARD : CARD;
      this.layouts = { key, ways: { down: layoutBoard(board.tasks, card, "down"), right: layoutBoard(board.tasks, card, "right") } };
    }
    const { down, right } = this.layouts.ways;
    const area = this.area();
    const chosen = this.tab.boardWindow?.direction;
    const next = chosen ? this.layouts.ways[chosen] : fitScale(right, area) > fitScale(down, area) + 0.01 ? right : down;
    this.directionButton.textContent = `${next.direction === "down" ? "↓" : "→"}${chosen ? "" : " auto"}`;
    this.directionButton.title = chosen
      ? `The graph runs ${chosen === "down" ? "top to bottom" : "left to right"} for everyone. Click: ${
          chosen === "down" ? "left to right" : "whichever fits the window"
        }.`
      : "The graph runs whichever way fits the window better. Click: top to bottom.";
    this.layout = next;
    this.root.classList.toggle("compact", compact);
    const done = new Set(board.tasks.filter((task) => task.status === "done").map((task) => task.id));
    const paths = { done: "", doneHeads: "", waiting: "", waitingHeads: "" };
    for (const edge of next.edges) {
      const kind = done.has(edge.from) ? "done" : "waiting";
      paths[kind] += `${edge.path} `;
      paths[`${kind}Heads`] += `${edge.head} `;
    }
    for (const [name, element] of Object.entries(this.edges)) element.setAttribute("d", paths[name as keyof typeof paths]);
    this.svg.setAttribute("width", String(next.width));
    this.svg.setAttribute("height", String(next.height));
    this.canvas.style.width = `${next.width}px`;
    this.canvas.style.height = `${next.height}px`;
    for (const [id, card] of this.cards) {
      const placed = next.cards.get(id);
      if (placed) {
        card.style.left = `${placed.x}px`;
        card.style.top = `${placed.y}px`;
      }
    }
    this.fit(area);
  }

  /** The room the graph has, in CSS px. */
  private area(): Size {
    return { width: Math.max(200, this.graph.clientWidth - 4), height: Math.max(150, this.graph.clientHeight - 4) };
  }

  /** Draws the graph at the zoom chosen by hand, or shrunk to fit the window (down to MIN_SCALE). */
  private fit(area: Size): void {
    if (!this.layout) return;
    this.scale = this.zoom ?? Math.max(MIN_SCALE, fitScale(this.layout, area));
    this.canvas.style.transform = this.scale !== 1 ? `scale(${this.scale})` : "";
    this.sizer.style.width = `${this.layout.width * this.scale}px`;
    this.sizer.style.height = `${this.layout.height * this.scale}px`;
    this.zoomLabel.textContent = this.zoom === null ? "Fit" : `${Math.round(this.scale * 100)}%`;
  }

  /**
   * Zooms to `next` (null fits the window), keeping the point under `anchor` (in px from the
   * graph's top-left; its middle by default) where it is.
   */
  private zoomTo(next: number | null, anchor?: { x: number; y: number }): void {
    if (!this.layout) return;
    const point = anchor ?? { x: this.graph.clientWidth / 2, y: this.graph.clientHeight / 2 };
    const before = this.scale;
    const x = (this.graph.scrollLeft + point.x - this.sizer.offsetLeft) / before;
    const y = (this.graph.scrollTop + point.y - this.sizer.offsetTop) / before;
    this.zoom = next === null ? null : Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    saveSetting(`boardZoom.${this.tab.id}`, this.zoom === null ? "" : this.zoom.toFixed(3));
    this.fit(this.area());
    this.graph.scrollLeft = x * this.scale + this.sizer.offsetLeft - point.x;
    this.graph.scrollTop = y * this.scale + this.sizer.offsetTop - point.y;
  }

  /** A drag on the background moves the view, as a map does. */
  private startPan(event: PointerEvent): void {
    if ((event.button !== 0 && event.button !== 1) || (event.target as HTMLElement).closest(".task")) return;
    if (event.button === 1) event.preventDefault(); // no autoscroll
    const graph = this.graph;
    const start = { x: event.clientX, y: event.clientY, left: graph.scrollLeft, top: graph.scrollTop };
    let moved = false;
    graph.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < PAN_THRESHOLD_PX) return;
      moved = true;
      graph.classList.add("panning");
      graph.scrollLeft = start.left - dx;
      graph.scrollTop = start.top - dy;
    };
    const end = () => {
      graph.removeEventListener("pointermove", move);
      graph.removeEventListener("pointerup", end);
      graph.removeEventListener("pointercancel", end);
      if (graph.hasPointerCapture(event.pointerId)) graph.releasePointerCapture(event.pointerId);
      graph.classList.remove("panning");
      this.panned = moved;
    };
    graph.addEventListener("pointermove", move);
    graph.addEventListener("pointerup", end);
    graph.addEventListener("pointercancel", end);
  }

  private renderCards(lives: Map<string, TaskLive | null>): void {
    const board = this.tab.board!;
    const layout = this.layout!;
    const compact = board.tasks.length > COMPACT_AFTER;
    const ids = new Set(board.tasks.map((task) => task.id));
    for (const [id, card] of this.cards) {
      if (!ids.has(id)) {
        card.remove();
        this.cards.delete(id);
      }
    }
    if (this.selected && !ids.has(this.selected)) this.selected = null;
    for (const task of board.tasks) {
      let card = this.cards.get(task.id);
      if (!card) {
        card = this.createCard(task.id);
        this.cards.set(task.id, card);
        this.canvas.appendChild(card);
      }
      const placed = layout.cards.get(task.id)!;
      card.style.left = `${placed.x}px`;
      card.style.top = `${placed.y}px`;
      const live = lives.get(task.id) ?? null;
      card.className = `task status-${task.status}${live?.alarm === "red" ? " alarm" : live?.alarm === "amber" ? " asking" : ""}${
        this.selected === task.id ? " selected" : ""
      }`;
      const id = el("span", { class: "task-id" }, [task.id]);
      const title = el("span", { class: "task-title" }, [task.title]);
      if (compact) {
        const mark = live?.alarm ? [el("span", { class: `badge agent ${live.kind}` }, [live.alarm === "red" ? "⚠" : "!"])] : [];
        card.replaceChildren(el("span", { class: "task-line" }, [id, " ", title]), ...mark);
      } else {
        const second = live
          ? [el("span", { class: "task-term" }, [live.terminal]), ...(live.text ? [el("span", { class: `badge agent ${live.kind}` }, [live.text])] : [])]
          : [el("span", { class: "task-note" }, [task.note ? `${STATUS_LABEL[task.status]}: ${task.note}` : STATUS_LABEL[task.status]])];
        card.replaceChildren(el("span", { class: "task-line" }, [id, " ", title]), el("span", { class: "task-live" }, second));
      }
      card.title = [
        `${task.id} ${task.title}`,
        STATUS_LABEL[task.status] + (task.note ? `: ${task.note}` : ""),
        live && `terminal ${live.terminal}${live.text ? `: ${live.text}` : ""}`,
        live?.detail,
      ]
        .filter(Boolean)
        .join("\n");
      card.setAttribute("aria-label", card.title.replace(/\n/g, ", "));
    }
  }

  private createCard(id: string): HTMLButtonElement {
    const card = el("button", { class: "task", type: "button" });
    card.addEventListener("click", () => this.select(id));
    card.addEventListener("dblclick", () => this.open(id));
    card.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      this.open(id);
    });
    return card;
  }

  private select(id: string | null): void {
    if (this.selected === id) return;
    this.selected = id;
    this.render();
  }

  private open(id: string): void {
    const task = this.tab.board?.tasks.find((candidate) => candidate.id === id);
    if (!task) return;
    this.select(id);
    this.options.openTerminal(task);
  }

  private renderDetail(lives: Map<string, TaskLive | null>): void {
    const board = this.tab.board!;
    const task = this.selected ? board.tasks.find((candidate) => candidate.id === this.selected) : undefined;
    if (!task) {
      this.detail.replaceChildren(
        el("span", { class: "board-muted" }, ["Click a task to see it; double-click to open its terminal."]),
      );
      return;
    }
    const status = new Map(board.tasks.map((candidate) => [candidate.id, candidate.status]));
    const parts: Array<Node | string> = [
      el("strong", {}, [`${task.id} ${task.title}`]),
      el("span", { class: `status-pill status-${task.status}` }, [STATUS_LABEL[task.status]]),
    ];
    if (task.after?.length) {
      const waits = task.after.map((id) => `${id}${status.get(id) === "done" ? " ✓" : ""}`).join(", ");
      parts.push(el("span", { class: "board-muted" }, [`after ${waits}`]));
    }
    if (task.note) parts.push(el("span", {}, [task.note]));
    if (task.link) parts.push(el("a", { href: task.link, target: "_blank", rel: "noopener noreferrer" }, ["link ↗"]));
    const live = lives.get(task.id);
    parts.push(el("span", { class: "spacer" }));
    parts.push(
      el("span", { class: "board-muted" }, [
        live ? `terminal ${live.terminal}${live.text ? ` · ${live.text}` : ""} · double-click to open` : "no terminal",
      ]),
    );
    this.detail.replaceChildren(...parts);
  }
}
