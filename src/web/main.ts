// Copyright 2026 The workstreams Authors
// SPDX-License-Identifier: Apache-2.0
// Part of workstreams: https://github.com/YangXu1990uiuc/workstreams

import "@xterm/xterm/css/xterm.css";
import {
  type ClientMessage,
  decodeOutputPayload,
  GRID_PATTERN,
  type ServerMessage,
  type SessionView,
  TAB_COLORS,
  type TabView,
} from "../common/protocol.ts";
import { el, formatGrid, type Grid, loadSetting, parseGrid, randomId, saveSetting } from "./dom.ts";
import { detectPlatform } from "./keymap.ts";
import { createSettingsDialog, ensureLogin } from "./login.ts";
import { createNewTerminalDialog } from "./new-dialog.ts";
import { measureFont } from "./sizing.ts";
import { SESSION_DRAG_TYPE, TabStrip } from "./tabs.ts";
import { FONT_FAMILY, TermView } from "./term-view.ts";

// Refuse to run inside another site's frame, so a page cannot overlay the terminal and trick
// clicks or keystrokes into it (clickjacking). SameSite=Strict cookies already keep a framed
// copy signed out.
if (window.top !== window.self) {
  document.body.textContent = "workstreams cannot be shown inside another page.";
  throw new Error("workstreams refuses to run in a frame");
}

const platform = detectPlatform();
// Matrix order, rows x columns: "2x3" is 2 rows of 3 tiles.
const GRID_PRESETS = ["1x1", "1x2", "1x3", "2x2", "2x3", "2x4", "3x3", "3x4"];
// Browsers cap live WebGL contexts per page (about 16 in Chrome); later tiles use the DOM renderer.
const MAX_WEBGL_TILES = 12;
const GRID_GAP = 4;
const TILE_BORDER = 1;

const sessions = new Map<string, SessionView>();
let tabs: TabView[] = [];
const tiles = new Map<string, Tile>();
/** Sessions that rang the bell since this browser last looked at them. */
const belled = new Set<string>();
let socket: WebSocket | null = null;
let connected = false;
let daemonUp = false;
let reconnectDelay = 250;
let createdHereAt = 0;

function send(message: ClientMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

// ---- routing: #t=<tab> shows a tab, #s=<session> focuses one terminal --------------------

interface View {
  tab: TabView | null;
  focus: string | null;
}

function currentView(): View {
  const params = new URLSearchParams(location.hash.slice(1));
  const focus = params.get("s");
  if (focus) {
    const tabId = sessions.get(focus)?.tab ?? params.get("t");
    return { tab: tabs.find((tab) => tab.id === tabId) ?? tabs[0] ?? null, focus };
  }
  const wanted = params.get("t") ?? loadSetting("lastTab", "");
  return { tab: tabs.find((tab) => tab.id === wanted) ?? tabs[0] ?? null, focus: null };
}

function showTab(id: string): void {
  location.hash = `t=${id}`;
}

// ---- chrome ----------------------------------------------------------------------------

const app = document.getElementById("app") as HTMLDivElement;
const statusDot = el("span", { class: "status down", title: "Connecting…" });
const gridSelect = el(
  "select",
  { title: "Tiles per screen in this tab: rows × columns" },
  GRID_PRESETS.map((preset) => el("option", { value: preset }, [formatGrid(parseGrid(preset)!)])),
);
const newButton = el("button", { class: "primary" }, ["+ New terminal"]);
const settingsButton = el("button", { class: "icon-btn settings-btn", title: "Settings" }, ["⚙"]);
const notice = el("div", { class: "notice", hidden: "" });
const grid = el("main", { class: "grid" });
const empty = el("div", { class: "empty", hidden: "" });
const toastBox = el("div", { class: "toast", hidden: "" });
const favicon = el("link", { rel: "icon" });
document.head.appendChild(favicon);

const tabStrip = new TabStrip({
  select: (id) => showTab(id),
  create: () => {
    const id = randomId();
    const color = TAB_COLORS[(tabs.length + 6) % TAB_COLORS.length]!;
    send({ t: "tab-create", id, name: `Tab ${tabs.length + 1}`, color, grid: currentView().tab?.grid ?? "2x2" });
    tabStrip.renameOnArrival(id);
    showTab(id);
  },
  rename: (id, name) => send({ t: "tab-update", id, name }),
  recolor: (id, color) => send({ t: "tab-update", id, color }),
  remove: (id) => {
    const index = tabs.findIndex((tab) => tab.id === id);
    const tab = tabs[index];
    if (!tab || tabs.length <= 1) return;
    const neighbour = tabs[index > 0 ? index - 1 : 1]!;
    const count = [...sessions.values()].filter((session) => session.tab === id).length;
    const moved = count > 0 ? ` Its ${count} terminal${count === 1 ? "" : "s"} will move to “${neighbour.name}”.` : "";
    if (!confirm(`Delete tab “${tab.name}”?${moved}`)) return;
    send({ t: "tab-delete", id });
    if (currentView().tab?.id === id) showTab(neighbour.id);
  },
  move: (id, index) => send({ t: "tab-move", id, index }),
  openInWindow: (id) => window.open(`${location.pathname}#t=${id}`, "_blank"),
  moveSession: (sessionId, tabId) => send({ t: "session-move", session: sessionId, tab: tabId }),
});

const topbar = el("header", { class: "topbar" }, [
  el("span", { class: "brand" }, ["workstreams"]),
  statusDot,
  tabStrip.element,
]);
if (!window.isSecureContext) {
  topbar.append(
    el(
      "span",
      {
        class: "warning",
        title:
          "Plain HTTP: programs cannot write to your clipboard and desktop notifications are off. " +
          "Use an SSH tunnel to localhost or HTTPS.",
      },
      ["⚠ HTTP"],
    ),
  );
}
topbar.append(gridSelect, newButton, settingsButton);

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(message: string): void {
  toastBox.textContent = message;
  toastBox.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastBox.hidden = true;
  }, 5000);
}

const settings = createSettingsDialog(toast);
settingsButton.addEventListener("click", () => settings.open());

gridSelect.addEventListener("change", () => {
  const tab = currentView().tab;
  if (tab && GRID_PATTERN.test(gridSelect.value)) send({ t: "tab-update", id: tab.id, grid: gridSelect.value });
});
new ResizeObserver(() => layoutGrid()).observe(grid);
window.addEventListener("hashchange", () => render());

function gridOf(tab: TabView | null): Grid {
  return parseGrid(tab?.grid ?? "") ?? { rows: 2, cols: 2 };
}

function layoutGrid(): void {
  const view = currentView();
  const { rows, cols } = view.focus ? { rows: 1, cols: 1 } : gridOf(view.tab);
  const available = grid.clientHeight - 2 * GRID_GAP - (rows - 1) * GRID_GAP;
  grid.style.setProperty("--cols", String(cols));
  grid.style.setProperty("--row-h", `${Math.max(80, Math.floor(available / rows))}px`);
}

/** The terminal area of one tile in the current tab's grid (even when focused on one). */
function tileArea(): { area: { width: number; height: number }; grid: Grid } {
  const layout = gridOf(currentView().tab);
  const header = document.querySelector(".tile-header")?.getBoundingClientRect().height ?? 29;
  const width = (grid.clientWidth - 2 * GRID_GAP - (layout.cols - 1) * GRID_GAP) / layout.cols - 2 * TILE_BORDER;
  const rowHeight = Math.max(
    80,
    Math.floor((grid.clientHeight - 2 * GRID_GAP - (layout.rows - 1) * GRID_GAP) / layout.rows),
  );
  return { area: { width, height: rowHeight - header - 2 * TILE_BORDER }, grid: layout };
}

const newDialog = createNewTerminalDialog({
  tile: tileArea,
  font: () => measureFont(FONT_FAMILY),
  create: (request) => {
    createdHereAt = Date.now();
    send({ t: "create", ...request, tab: currentView().tab?.id });
  },
});
newButton.addEventListener("click", () => newDialog.open());

function setStatus(): void {
  statusDot.className = `status ${connected ? (daemonUp ? "ok" : "warn") : "down"}`;
  statusDot.title = connected ? (daemonUp ? "Connected" : "Daemon not running") : "Reconnecting…";
  if (!connected) notice.textContent = "Connection to the server lost. Reconnecting…";
  else if (!daemonUp) notice.textContent = "The daemon is not running. Start it with `workstreams up`.";
  notice.hidden = connected && daemonUp;
}

/** Browser-tab title and icon show the workspace, so several open windows are easy to tell apart. */
function updateWindowIdentity(tab: TabView | null): void {
  const waiting = belled.size;
  document.title = `${waiting > 0 ? `(${waiting}) ` : ""}${tab ? `${tab.name} · ` : ""}workstreams`;
  const color = tab?.color ?? "#3794ff";
  const dot = waiting > 0 ? '<circle cx="12" cy="4" r="3.5" fill="#cca700" stroke="#1f1f1f" stroke-width="1"/>' : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="1" y="2" width="14" height="12" rx="3" fill="${color}"/><path d="M4 6l2.5 2L4 10M8 10h4" stroke="#1f1f1f" stroke-width="1.5" fill="none"/>${dot}</svg>`;
  favicon.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// ---- tiles -----------------------------------------------------------------------------

class Tile {
  readonly root: HTMLElement;
  private view: TermView | null = null;
  private session: SessionView;
  private readonly body: HTMLDivElement;
  private readonly banner: HTMLInputElement;
  private readonly subtitle: HTMLSpanElement;
  private readonly size: HTMLSpanElement;
  private readonly exitBadge: HTMLSpanElement;
  private readonly focusButton: HTMLButtonElement;

  constructor(session: SessionView) {
    this.session = session;
    const grip = el("span", { class: "grip", draggable: "true", title: "Drag onto a tab to move this terminal" }, ["⠿"]);
    this.banner = el("input", { class: "banner", placeholder: "What is this terminal doing?", spellcheck: "false" });
    this.subtitle = el("span", { class: "subtitle" });
    this.size = el("span", { class: "meta" });
    this.exitBadge = el("span", { class: "badge exited", hidden: "" });
    this.focusButton = el("button", { class: "icon-btn", title: "Focus this terminal" }, ["⤢"]);
    const windowButton = el("button", { class: "icon-btn", title: "Open in a new window" }, ["↗"]);
    const closeButton = el("button", { class: "icon-btn", title: "Close terminal" }, ["✕"]);
    this.body = el("div", { class: "tile-body" });
    this.root = el("section", { class: "tile" }, [
      el("div", { class: "tile-header" }, [
        grip,
        el("span", { class: "bell-dot", title: "Wants attention" }, ["●"]),
        this.banner,
        this.subtitle,
        this.exitBadge,
        this.size,
        this.focusButton,
        windowButton,
        closeButton,
      ]),
      this.body,
    ]);

    grip.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData(SESSION_DRAG_TYPE, this.session.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    this.banner.addEventListener("change", () => {
      send({ t: "banner", session: this.session.id, banner: this.banner.value.trim() });
    });
    this.banner.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        // Without preventDefault the Enter's keypress lands in the terminal once it has focus.
        event.preventDefault();
        this.banner.blur();
        setTimeout(() => this.view?.focus(), 0);
      } else if (event.key === "Escape") {
        this.banner.value = this.session.banner;
        this.banner.blur();
      }
    });
    this.focusButton.addEventListener("click", () => {
      if (currentView().focus === this.session.id) showTab(this.session.tab);
      else location.hash = `s=${this.session.id}`;
    });
    windowButton.addEventListener("click", () => {
      window.open(`${location.pathname}#s=${this.session.id}`, "_blank");
    });
    closeButton.addEventListener("click", () => {
      if (!this.session.exited && !confirm("Close this terminal? Its program will be terminated.")) return;
      send({ t: "close", session: this.session.id });
    });
    this.update(session);
  }

  /** Mounts the terminal once the tile is in the document, so xterm.js can measure fonts. */
  start(useWebgl: boolean): void {
    if (this.view) return;
    this.view = new TermView({
      session: this.session,
      platform,
      useWebgl,
      send,
      onFocusChange: (focused) => {
        this.root.classList.toggle("focused", focused);
        if (focused && belled.delete(this.session.id)) render();
      },
    });
    this.view.mount(this.body);
    send({ t: "sub", session: this.session.id });
  }

  get terminal(): TermView | null {
    return this.view;
  }

  update(session: SessionView): void {
    this.session = session;
    if (document.activeElement !== this.banner) this.banner.value = session.banner;
    this.subtitle.textContent = session.title;
    this.subtitle.title = session.title;
    this.size.textContent = `${session.cols}×${session.rows}`;
    this.size.title = `Fixed size · ${session.cwd}`;
    const exited = session.exited;
    this.exitBadge.hidden = !exited;
    if (exited) this.exitBadge.textContent = exited.signal ? `exited (${exited.signal})` : `exited ${exited.code ?? ""}`;
    this.focusButton.textContent = currentView().focus === session.id ? "⤡" : "⤢";
    this.root.classList.toggle("bell", belled.has(session.id));
  }

  dispose(): void {
    send({ t: "unsub", session: this.session.id });
    this.view?.dispose();
    this.root.remove();
  }
}

function render(): void {
  const view = currentView();
  const params = new URLSearchParams(location.hash.slice(1));
  if (view.tab) {
    // Show the tab's own URL in the address bar (bookmarkable), without a history entry.
    if (!view.focus && !params.has("t")) history.replaceState(null, "", `${location.pathname}#t=${view.tab.id}`);
    saveSetting("lastTab", view.tab.id);
  }

  const counts = new Map<string, number>();
  const alerts = new Set<string>();
  for (const session of sessions.values()) {
    counts.set(session.tab, (counts.get(session.tab) ?? 0) + 1);
    if (belled.has(session.id)) alerts.add(session.tab);
  }
  tabStrip.render({ tabs, activeId: view.tab?.id ?? null, counts, alerts });

  const ordered = [...sessions.values()].sort((a, b) => a.createdAt - b.createdAt);
  const visible = view.focus
    ? ordered.filter((session) => session.id === view.focus)
    : ordered.filter((session) => session.tab === view.tab?.id);
  const visibleIds = new Set(visible.map((session) => session.id));

  for (const [id, tile] of tiles) {
    if (!visibleIds.has(id)) {
      tile.dispose();
      tiles.delete(id);
    }
  }
  visible.forEach((session, index) => {
    let tile = tiles.get(session.id);
    const isNew = !tile;
    if (!tile) {
      tile = new Tile(session);
      tiles.set(session.id, tile);
    } else {
      tile.update(session);
    }
    if (grid.children[index] !== tile.root) grid.insertBefore(tile.root, grid.children[index] ?? null);
    if (isNew) {
      tile.start(tiles.size <= MAX_WEBGL_TILES);
      if (createdHereAt && Date.now() - createdHereAt < 5000) {
        createdHereAt = 0;
        const created = tile;
        requestAnimationFrame(() => created.terminal?.focus());
      }
    }
  });

  if (view.tab) gridSelect.value = view.tab.grid;
  gridSelect.disabled = view.focus !== null;
  empty.hidden = visible.length > 0;
  empty.textContent = view.focus
    ? "This terminal no longer exists."
    : "No terminals in this tab yet. Create one with “+ New terminal”, or drag one here onto the tab.";
  layoutGrid();
  updateWindowIdentity(view.tab);
}

// ---- connection ------------------------------------------------------------------------

function onServerMessage(message: ServerMessage): void {
  switch (message.t) {
    case "hello":
      return;
    case "daemon":
      daemonUp = message.up;
      setStatus();
      return;
    case "tabs":
      tabs = message.tabs;
      render();
      return;
    case "sessions":
      sessions.clear();
      for (const session of message.sessions) sessions.set(session.id, session);
      for (const id of belled) if (!sessions.has(id)) belled.delete(id);
      render();
      return;
    case "session":
      sessions.set(message.session.id, message.session);
      render();
      return;
    case "removed":
      sessions.delete(message.session);
      belled.delete(message.session);
      render();
      return;
    case "snapshot":
      tiles.get(message.snapshot.session)?.terminal?.applySnapshot(message.snapshot);
      return;
    case "bell":
      if (tiles.get(message.session)?.terminal?.hasFocus) return;
      belled.add(message.session);
      render();
      return;
    case "error":
      toast(message.message);
      return;
  }
}

function onOutput(bytes: Uint8Array): void {
  const { sessionId, offset, data } = decodeOutputPayload(bytes);
  tiles.get(sessionId)?.terminal?.write(offset, data);
}

function connect(): void {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`);
  ws.binaryType = "arraybuffer";
  ws.addEventListener("open", () => {
    socket = ws;
    connected = true;
    reconnectDelay = 250;
    setStatus();
    // Subscriptions belong to a connection; existing tiles ask again for fresh snapshots.
    for (const tile of tiles.values()) tile.terminal?.resync();
  });
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string") onServerMessage(JSON.parse(event.data) as ServerMessage);
    else onOutput(new Uint8Array(event.data as ArrayBuffer));
  });
  ws.addEventListener("close", () => {
    if (socket === ws) socket = null;
    connected = false;
    setStatus();
    setTimeout(() => void reconnect(), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 5000);
  });
}

async function reconnect(): Promise<void> {
  try {
    const response = await fetch("/api/me");
    if (response.status === 401) {
      await ensureLogin(app);
      showApp();
    } else if (!response.ok) {
      throw new Error(`server answered ${response.status}`);
    }
    connect();
  } catch {
    setTimeout(() => void reconnect(), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 5000);
  }
}

function showApp(): void {
  const main = el("div", { class: "main" }, [grid, empty]);
  app.replaceChildren(topbar, notice, main, newDialog.element, settings.element, toastBox);
  setStatus();
  render();
}

await ensureLogin(app);
showApp();
connect();
