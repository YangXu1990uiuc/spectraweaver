// Copyright 2026 The workstreams Authors
// SPDX-License-Identifier: Apache-2.0
// Part of workstreams: https://github.com/YangXu1990uiuc/workstreams

import "@xterm/xterm/css/xterm.css";
import {
  type ClientMessage,
  decodeOutputPayload,
  type ServerMessage,
  type SessionView,
} from "../common/protocol.ts";
import { detectPlatform } from "./keymap.ts";
import { TermView } from "./term-view.ts";

const platform = detectPlatform();
const GRID_PRESETS = ["1x1", "2x1", "2x2", "3x2", "4x2", "3x3", "4x3"];
const SIZE_PRESETS = ["80x24", "100x30", "120x36", "160x48"];
// Browsers cap live WebGL contexts per page (about 16 in Chrome); later tiles use the DOM renderer.
const MAX_WEBGL_TILES = 12;
const GRID_GAP = 4;

const sessions = new Map<string, SessionView>();
const tiles = new Map<string, Tile>();
let socket: WebSocket | null = null;
let connected = false;
let daemonUp = false;
let reconnectDelay = 250;
let createdHereAt = 0;

// ---- small DOM helper ------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

function loadSetting(key: string, fallback: string): string {
  try {
    return localStorage.getItem(`workstreams.${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}

function saveSetting(key: string, value: string): void {
  try {
    localStorage.setItem(`workstreams.${key}`, value);
  } catch {
    // Storage unavailable; the setting just won't persist.
  }
}

function parseSize(text: string): [number, number] | null {
  const match = /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i.exec(text);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

function send(message: ClientMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function focusedSessionId(): string | null {
  return new URLSearchParams(location.hash.slice(1)).get("s");
}

// ---- login -----------------------------------------------------------------------------

const app = document.getElementById("app") as HTMLDivElement;

async function login(token: string): Promise<boolean> {
  const response = await fetch("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  return response.ok;
}

async function isLoggedIn(): Promise<boolean> {
  try {
    return (await fetch("/api/me")).ok;
  } catch {
    return false;
  }
}

async function ensureLogin(): Promise<void> {
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get("token");
  if (token) {
    // Take the token out of the address bar and history before anything else.
    params.delete("token");
    const rest = params.toString();
    history.replaceState(null, "", `${location.pathname}${location.search}${rest ? `#${rest}` : ""}`);
    await login(token);
  }
  while (!(await isLoggedIn())) await showLoginForm();
}

function showLoginForm(): Promise<void> {
  return new Promise((resolve) => {
    const input = el("input", { type: "password", placeholder: "token", autocomplete: "current-password" });
    const error = el("p", { class: "error" });
    const form = el("form", { class: "login" }, [
      el("h1", {}, ["workstreams"]),
      el("p", {}, [
        "Paste the token printed by ",
        el("code", {}, ["workstreams up"]),
        " (or run ",
        el("code", {}, ["workstreams token"]),
        ").",
      ]),
      input,
      el("button", { type: "submit", class: "primary" }, ["Sign in"]),
      error,
    ]);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void login(input.value.trim()).then((ok) => {
        if (ok) {
          form.remove();
          resolve();
        } else {
          error.textContent = "That token is not valid.";
        }
      });
    });
    app.replaceChildren(form);
    input.focus();
  });
}

// ---- chrome ----------------------------------------------------------------------------

const statusDot = el("span", { class: "status down", title: "Connecting…" });
const backButton = el("button", { class: "back", hidden: "" }, ["← All terminals"]);
const gridSelect = el(
  "select",
  { title: "Grid layout (columns × rows per screen)" },
  GRID_PRESETS.map((preset) => el("option", { value: preset }, [preset.replace("x", " × ")])),
);
const newButton = el("button", { class: "primary" }, ["+ New terminal"]);
const topbar = el("header", { class: "topbar" }, [
  el("span", { class: "brand" }, ["workstreams"]),
  statusDot,
  backButton,
  el("span", { class: "spacer" }),
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
topbar.append(gridSelect, newButton);

const notice = el("div", { class: "notice", hidden: "" });
const grid = el("main", { class: "grid" });
const empty = el("div", { class: "empty", hidden: "" });
const toastBox = el("div", { class: "toast", hidden: "" });

gridSelect.value = loadSetting("grid", "2x2");
gridSelect.addEventListener("change", () => {
  saveSetting("grid", gridSelect.value);
  layoutGrid();
});
backButton.addEventListener("click", () => {
  location.hash = "";
});
new ResizeObserver(() => layoutGrid()).observe(grid);
window.addEventListener("hashchange", () => render());

function layoutGrid(): void {
  const focusMode = focusedSessionId() !== null;
  const [cols, rows] = focusMode ? [1, 1] : (parseSize(gridSelect.value) ?? [2, 2]);
  const available = grid.clientHeight - 2 * GRID_GAP - (rows - 1) * GRID_GAP;
  grid.style.setProperty("--cols", String(cols));
  grid.style.setProperty("--row-h", `${Math.max(80, Math.floor(available / rows))}px`);
}

function setStatus(): void {
  statusDot.className = `status ${connected ? (daemonUp ? "ok" : "warn") : "down"}`;
  statusDot.title = connected ? (daemonUp ? "Connected" : "Daemon not running") : "Reconnecting…";
  if (!connected) notice.textContent = "Connection to the server lost. Reconnecting…";
  else if (!daemonUp) notice.textContent = "The daemon is not running. Start it with `workstreams up`.";
  notice.hidden = connected && daemonUp;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(message: string): void {
  toastBox.textContent = message;
  toastBox.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastBox.hidden = true;
  }, 5000);
}

function updateDocumentTitle(): void {
  const waiting = [...tiles.values()].filter((tile) => tile.belled).length;
  document.title = waiting > 0 ? `(${waiting}) workstreams` : "workstreams";
}

// ---- new-terminal dialog ---------------------------------------------------------------

const sizeSelect = el(
  "select",
  {},
  [...SIZE_PRESETS, "custom"].map((preset) =>
    el("option", { value: preset }, [preset === "custom" ? "Custom…" : preset.replace("x", " × ")]),
  ),
);
const customSize = el("input", { placeholder: "cols x rows, e.g. 132x50", hidden: "" });
const cwdInput = el("input", { placeholder: "~ (home)", spellcheck: "false" });
const cmdInput = el("input", { placeholder: "optional, e.g. claude", spellcheck: "false" });
const dialogError = el("p", { class: "error" });
const dialogForm = el("form", { method: "dialog" }, [
  el("h2", {}, ["New terminal"]),
  el("label", { class: "field" }, [
    "Size (fixed for the life of the terminal)",
    sizeSelect,
    customSize,
  ]),
  el("label", { class: "field" }, ["Working directory", cwdInput]),
  el("label", { class: "field" }, ["Startup command", cmdInput]),
  dialogError,
  el("div", { class: "actions" }, [
    el("button", { type: "button", value: "cancel", class: "cancel" }, ["Cancel"]),
    el("button", { type: "submit", class: "primary" }, ["Create"]),
  ]),
]);
const newDialog = el("dialog", { class: "new-dialog" }, [dialogForm]);

sizeSelect.addEventListener("change", () => {
  customSize.hidden = sizeSelect.value !== "custom";
});
dialogForm.querySelector(".cancel")?.addEventListener("click", () => newDialog.close());
newButton.addEventListener("click", () => {
  const lastSize = loadSetting("size", "120x36");
  sizeSelect.value = SIZE_PRESETS.includes(lastSize) ? lastSize : "custom";
  customSize.value = SIZE_PRESETS.includes(lastSize) ? "" : lastSize;
  customSize.hidden = sizeSelect.value !== "custom";
  cwdInput.value = loadSetting("cwd", "");
  cmdInput.value = "";
  dialogError.textContent = "";
  newDialog.showModal();
});
dialogForm.addEventListener("submit", (event) => {
  const sizeText = sizeSelect.value === "custom" ? customSize.value : sizeSelect.value;
  const size = parseSize(sizeText);
  if (!size || size[0] < 2 || size[1] < 1 || size[0] > 1000 || size[1] > 500) {
    event.preventDefault();
    dialogError.textContent = "Size must look like 120x36.";
    return;
  }
  saveSetting("size", `${size[0]}x${size[1]}`);
  saveSetting("cwd", cwdInput.value.trim());
  createdHereAt = Date.now();
  send({
    t: "create",
    cols: size[0],
    rows: size[1],
    cwd: cwdInput.value.trim() || undefined,
    cmd: cmdInput.value.trim() || undefined,
  });
});

// ---- tiles -----------------------------------------------------------------------------

class Tile {
  readonly root: HTMLElement;
  belled = false;
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
      location.hash = focusedSessionId() === this.session.id ? "" : `s=${this.session.id}`;
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
        if (focused) this.clearBell();
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
    this.focusButton.textContent = focusedSessionId() === session.id ? "⤡" : "⤢";
  }

  bell(): void {
    if (this.view?.hasFocus) return;
    this.belled = true;
    this.root.classList.add("bell");
    updateDocumentTitle();
  }

  clearBell(): void {
    if (!this.belled) return;
    this.belled = false;
    this.root.classList.remove("bell");
    updateDocumentTitle();
  }

  dispose(): void {
    send({ t: "unsub", session: this.session.id });
    this.view?.dispose();
    this.root.remove();
  }
}

function render(): void {
  const focusId = focusedSessionId();
  const ordered = [...sessions.values()].sort((a, b) => a.createdAt - b.createdAt);
  const visible = focusId ? ordered.filter((session) => session.id === focusId) : ordered;
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

  backButton.hidden = !focusId;
  empty.hidden = visible.length > 0;
  empty.textContent = focusId
    ? "This terminal no longer exists."
    : "No terminals yet. Create one with “+ New terminal”.";
  layoutGrid();
  updateDocumentTitle();
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
    case "sessions":
      sessions.clear();
      for (const session of message.sessions) sessions.set(session.id, session);
      render();
      return;
    case "session":
      sessions.set(message.session.id, message.session);
      render();
      return;
    case "removed":
      sessions.delete(message.session);
      render();
      return;
    case "snapshot":
      tiles.get(message.snapshot.session)?.terminal?.applySnapshot(message.snapshot);
      return;
    case "bell":
      tiles.get(message.session)?.bell();
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
      await ensureLogin();
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
  app.replaceChildren(topbar, notice, main, newDialog, toastBox);
  setStatus();
  render();
}

await ensureLogin();
showApp();
connect();
