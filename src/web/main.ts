// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import "@xterm/xterm/css/xterm.css";
import {
  type AgentStatus,
  type Board,
  type BoardTask,
  type ClientMessage,
  decodeOutputPayload,
  type Frame,
  type LostSession,
  MAX_UPLOAD_BYTES,
  type ServerMessage,
  type SessionView,
  TAB_COLORS,
  type TabView,
} from "../common/protocol.ts";
import { agentLive } from "./board-live.ts";
import { BoardWindow, boardAlarms, DEFAULT_BOARD_FRAME } from "./board-view.ts";
import { adoptFormerSettings, el, type Grid, loadSetting, parseGrid, randomId, saveSetting } from "./dom.ts";
import { detectPlatform } from "./keymap.ts";
import { createSettingsDialog, ensureLogin } from "./login.ts";
import { type MenuEntry, openMenu } from "./menu.ts";
import { createNewTerminalDialog, preferredTextPx, recommendedSize } from "./new-dialog.ts";
import { createResizeDialog } from "./resize-dialog.ts";
import { createRestoreDialog } from "./restore-dialog.ts";
import { cellAt, measureFont } from "./sizing.ts";
import { SESSION_DRAG_TYPE, TabStrip } from "./tabs.ts";
import { FONT_FAMILY, TermView } from "./term-view.ts";
import { WindowChrome } from "./window-chrome.ts";
import { placeWindow, SNAP_SLACK_PX, topZ } from "./windows.ts";

// Refuse to run inside another site's frame, so a page cannot overlay the terminal and trick
// clicks or keystrokes into it (clickjacking). SameSite=Strict cookies already keep a framed
// copy signed out.
if (window.top !== window.self) {
  document.body.textContent = "SpectraWeaver cannot be shown inside another page.";
  throw new Error("SpectraWeaver refuses to run in a frame");
}

adoptFormerSettings();

const platform = detectPlatform();
// Browsers cap live WebGL contexts per page (about 16 in Chrome); later tiles use the DOM renderer.
const MAX_WEBGL_TILES = 12;
const GRID_GAP = 4;
const TILE_BORDER = 1;
/** A window popping up from the board takes at least, and at most, these fractions of the tab. */
const POPUP_MIN = 0.3;
const POPUP_MAX = 0.9;

const sessions = new Map<string, SessionView>();
/** Terminals lost when the daemon stopped, waiting to be restored. */
let lost: LostSession[] = [];
let tabs: TabView[] = [];
const tiles = new Map<string, Tile>();
/** Sessions that rang the bell since this browser last looked at them. */
const belled = new Set<string>();

/** Its agent stopped, warns, or waits for an answer: someone has to look. */
function needsSomeone(session: SessionView): boolean {
  return session.agent !== undefined && agentLive("", session.agent, 0).alarm !== null;
}
let socket: WebSocket | null = null;
let connected = false;
let daemonUp = false;
/** What the daemon can do beyond the basics ("resize"), from the server's daemon message. */
let daemonFeatures = new Set<string>();
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
const newButton = el(
  "button",
  { class: "primary", title: "A new terminal in a free spot, in the directory of the terminal you last used" },
  ["+ New terminal"],
);
const newMoreButton = el(
  "button",
  { class: "primary", title: "New terminal with a directory, a startup command or an exact size", "aria-label": "New terminal with options" },
  ["▾"],
);
const newButtons = el("span", { class: "split-btn" }, [newButton, newMoreButton]);
// Per browser, like zoom: some like windows on grid lines, others free.
const snapBox = el("input", { type: "checkbox" });
snapBox.checked = loadSetting("snapToGrid", "0") === "1";
snapBox.addEventListener("change", () => saveSetting("snapToGrid", snapBox.checked ? "1" : "0"));
const snapToggle = el(
  "label",
  {
    class: "snap-toggle",
    title: "Windows land on grid lines (36ths of the workspace) when moved or resized. Hold Alt while dragging to do the opposite.",
    hidden: "",
  },
  [snapBox, "Snap to grid"],
);
const restoreButton = el("button", {}, ["↻ Restore"]);
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
    const from = currentView().tab;
    send({ t: "tab-create", id, name: `Tab ${tabs.length + 1}`, color, grid: from?.grid ?? "2x2" });
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
  showBoard: (id) => openBoard(id),
  moveSession: (sessionId, tabId) => send({ t: "session-move", session: sessionId, tab: tabId }),
});

const topbar = el("header", { class: "topbar" }, [
  el("span", { class: "brand" }, ["SpectraWeaver"]),
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
          "Plain HTTP: programs can copy to your clipboard only right after a key press or click, and " +
          "desktop notifications are off. An SSH tunnel to localhost, or HTTPS, lifts both limits.",
      },
      ["⚠ HTTP"],
    ),
  );
}
topbar.append(restoreButton, snapToggle, newButtons, settingsButton);

function updateRestoreButton(): void {
  restoreButton.textContent = lost.length > 0 ? `↻ Restore ${lost.length}` : "↻ Restore";
  restoreButton.classList.toggle("primary", lost.length > 0);
  restoreButton.title =
    lost.length > 0
      ? `${lost.length} terminal${lost.length === 1 ? " was" : "s were"} lost when the daemon stopped. ` +
        "Restore opens them again where they were, resuming their agents' conversations."
      : "Resume a recent Claude Code or Codex conversation in a new terminal";
}

function nameOf(sessionId: string): string {
  const session = sessions.get(sessionId);
  return session?.banner || session?.title || sessionId;
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

const settings = createSettingsDialog(toast);
settingsButton.addEventListener("click", () => settings.open());

new ResizeObserver(() => layoutGrid()).observe(grid);
// A page in the background stops receiving output after a while. Browsers throttle or
// freeze background pages, and catching up on minutes of agent output when coming back
// kept the terminals blank; a snapshot of each session is quicker and the same size however
// long the page was away.
const PAUSE_WHEN_HIDDEN_MS = 15_000;
// After sleep the connection can be dead without the browser noticing for minutes.
const SNAPSHOT_TIMEOUT_MS = 10_000;
let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
let arrivalCheck: ReturnType<typeof setTimeout> | undefined;
document.addEventListener("visibilitychange", () => {
  clearTimeout(hiddenTimer);
  clearTimeout(arrivalCheck);
  if (document.visibilityState === "hidden") {
    hiddenTimer = setTimeout(() => {
      for (const tile of tiles.values()) tile.terminal?.pause();
    }, PAUSE_WHEN_HIDDEN_MS);
    return;
  }
  for (const tile of tiles.values()) {
    tile.terminal?.resume();
    // The GPU may also have dropped what the terminals drew.
    tile.terminal?.repaint();
  }
  arrivalCheck = setTimeout(() => {
    const views = [...tiles.values()].map((tile) => tile.terminal).filter((view) => view !== null);
    const noneArrived = views.length > 0 && views.every((view) => view.waitingLongerThan(SNAPSHOT_TIMEOUT_MS - 500));
    if (noneArrived && daemonUp) reconnectNow();
  }, SNAPSHOT_TIMEOUT_MS);
});
window.addEventListener("hashchange", () => render());

function gridOf(tab: TabView | null): Grid {
  return parseGrid(tab?.grid ?? "") ?? { rows: 2, cols: 2 };
}

/**
 * Stores the places worked out for the shown tab's windows that have none yet (and the board's).
 * Such a window is put in front on every render; once another is raised above it, it must
 * keep its place in the stack instead of coming back on top.
 */
function pinUnplaced(): void {
  const tab = currentView().tab;
  for (const tile of tiles.values()) {
    const session = sessions.get(tile.sessionId);
    if (session && !session.frame && tile.windowFrame) send({ t: "session-frame", session: session.id, frame: tile.windowFrame });
  }
  if (tab && board && boardTab === tab.id && !tab.boardWindow?.frame && board.windowFrame) {
    send({ t: "board-window", tab: tab.id, frame: board.windowFrame });
  }
}

/** Brings a window in front of the others in its tab; the stacking is part of the shared layout. */
function raiseWindow(sessionId: string): void {
  const tile = tiles.get(sessionId);
  const mine = tile?.windowFrame;
  if (!tile || !mine) return;
  pinUnplaced();
  const others: Frame[] = [];
  for (const other of tiles.values()) if (other !== tile && other.windowFrame) others.push(other.windowFrame);
  if (board?.windowFrame) others.push(board.windowFrame);
  if (!others.some((frame) => frame.z >= mine.z)) return;
  const raised = { ...mine, z: topZ(others) + 1 };
  tile.setFrame(raised);
  send({ t: "session-frame", session: sessionId, frame: raised });
}

/** Brings the board's window in front of the terminals' windows. */
function raiseBoard(): void {
  const mine = board?.windowFrame;
  const tab = currentView().tab;
  if (!board || !mine || !tab || boardTab !== tab.id) return;
  pinUnplaced();
  const others = [...tiles.values()].flatMap((tile) => (tile.windowFrame ? [tile.windowFrame] : []));
  if (!others.some((frame) => frame.z >= mine.z)) return;
  const raised = { ...mine, z: topZ(others) + 1 };
  board.setFrame(raised);
  send({ t: "board-window", tab: tab.id, frame: raised });
}

/**
 * The highest window of a tab: its terminals' and its board's, as the server has them and, for
 * the tab shown, as shown here. A window raised here a moment ago (the board, by the first click
 * of a double click on a task) is above what the server has confirmed yet.
 */
function topOfTab(tabId: string): number {
  const frames = [...sessions.values()].flatMap((session) => (session.tab === tabId && session.frame ? [session.frame] : []));
  const boardFrame = tabs.find((tab) => tab.id === tabId)?.boardWindow?.frame;
  if (boardFrame) frames.push(boardFrame);
  if (boardTab === tabId && board?.windowFrame) frames.push(board.windowFrame);
  for (const tile of tiles.values()) {
    if (tile.windowFrame && sessions.get(tile.sessionId)?.tab === tabId) frames.push(tile.windowFrame);
  }
  return topZ(frames);
}

/**
 * Shows a terminal's window, in front, in its own tab; one put away comes out. One never placed
 * pops up over the middle of the tab, as a window opened from the board does on a desktop.
 */
function showTerminal(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) {
    toast("That terminal is closed.");
    return;
  }
  if (currentView().tab?.id !== session.tab || currentView().focus) showTab(session.tab);
  const step = [...sessions.values()].filter((other) => other.tab === session.tab && !other.hidden).length % 6;
  const frame = session.frame ?? popupFrame(session, step);
  send({ t: "session-frame", session: sessionId, frame: { ...frame, z: topOfTab(session.tab) + 1 } });
  if (session.hidden) send({ t: "session-hidden", session: sessionId, hidden: false });
}

/**
 * Where a terminal never placed pops up: towards the middle of the tab, stepped so several do not
 * cover each other exactly, and as large as its terminal at the preferred text size; past most of
 * the tab it keeps the terminal's shape and the text shrinks to fit.
 */
function popupFrame(session: SessionView, step: number): Frame {
  const room = { width: grid.clientWidth, height: grid.clientHeight };
  let w = 0.46;
  let h = 0.62;
  if (room.width > 0 && room.height > 0) {
    const cell = cellAt(measureFont(FONT_FAMILY), preferredTextPx());
    const header = document.querySelector(".tile-header")?.getBoundingClientRect().height ?? 29;
    const wanted = {
      w: (session.cols * cell.width + 2 * TILE_BORDER + SNAP_SLACK_PX) / room.width,
      h: (session.rows * cell.height + header + 2 * TILE_BORDER + SNAP_SLACK_PX) / room.height,
    };
    const scale = Math.min(1, POPUP_MAX / wanted.w, POPUP_MAX / wanted.h);
    w = Math.max(POPUP_MIN, wanted.w * scale);
    h = Math.max(POPUP_MIN, wanted.h * scale);
  }
  return { x: Math.min(0.3 + 0.025 * step, 1 - w), y: Math.min(0.06 + 0.035 * step, 1 - h), w, h, z: 0 };
}

/** Opens a tab's board window in front, from the tab's menu; an empty one says how to get a board. */
function openBoard(tabId: string): void {
  const tab = tabs.find((candidate) => candidate.id === tabId);
  if (!tab) return;
  if (currentView().tab?.id !== tabId || currentView().focus) showTab(tabId);
  else pinUnplaced();
  if (!tab.boardWindow?.open) send({ t: "board-window", tab: tabId, open: true });
  const frame = tab.boardWindow?.frame ?? { ...DEFAULT_BOARD_FRAME, z: 0 };
  send({ t: "board-window", tab: tabId, frame: { ...frame, z: topOfTab(tabId) + 1 } });
}

/** A task was double-clicked on the board. */
function openTask(task: BoardTask): void {
  if (!task.session) {
    toast(`No terminal works on ${task.id}.`);
    return;
  }
  showTerminal(task.session);
}

/** A tab's board, if it has one: only such a tab puts windows away, as their tasks bring them back. */
function boardOf(tabId: string): Board | undefined {
  return tabs.find((tab) => tab.id === tabId)?.board;
}

/** Whether a terminal is the lead that keeps a board: its window stays out, without ×. */
function isLead(sessionId: string): boolean {
  return tabs.some((tab) => tab.board?.lead === sessionId);
}

/** Puts a terminal's window away (in a tab with a board); one shown alone goes back to its tab. */
function putAway(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  send({ t: "session-hidden", session: sessionId, hidden: true });
  if (currentView().focus === sessionId) showTab(session.tab);
}

/** Ends a terminal's program once the person confirms, saying what it does on the board; an exited one just goes. */
function terminate(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (!session.exited) {
    const tasks = (boardOf(session.tab)?.tasks ?? []).filter((task) => task.session === sessionId).map((task) => task.id);
    const role = isLead(sessionId)
      ? "\nIt is the lead that keeps the board."
      : tasks.length > 0
        ? `\nIt works on ${tasks.join(", ")} on the board.`
        : "";
    if (!confirm(`Terminate “${nameOf(sessionId)}”?${role}\nIts program will be terminated.`)) return;
  }
  send({ t: "close", session: sessionId });
}

/**
 * A terminal's menu, on its window's header or (with `open`) on its task: bring it out, put it
 * away, or end it. Ending a program is only here (and × in a tab without a board).
 */
function terminalMenu(sessionId: string, open: boolean): MenuEntry[] {
  const session = sessions.get(sessionId);
  if (!session) return [{ label: "That terminal is closed", action: () => {}, disabled: true }];
  const entries: MenuEntry[] = [];
  if (open) entries.push({ label: "Open terminal", action: () => showTerminal(sessionId) });
  if (boardOf(session.tab) && !session.hidden && !isLead(sessionId)) {
    entries.push({ label: "Put away", action: () => putAway(sessionId) });
  }
  if (entries.length > 0) entries.push("-");
  entries.push({ label: session.exited ? "Remove terminal" : "Terminate…", danger: true, action: () => terminate(sessionId) });
  return entries;
}

/** Whether a drag carries files from outside the page (not a window's grip or a tab). */
function carriesFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes("Files") === true;
}

// Files dropped anywhere but on a terminal's window would make the browser leave the page to show them.
document.addEventListener("dragover", (event) => {
  if (carriesFiles(event)) event.preventDefault();
});
document.addEventListener("drop", (event) => {
  if (!carriesFiles(event) || event.defaultPrevented) return;
  event.preventDefault();
  toast("Drop files onto a terminal's window to upload them there.");
});

/**
 * Uploads files to the server's machine (POST /api/upload) and types their paths into a
 * terminal, after what is already in its input, without pressing Enter: an agent then reads
 * them as it would files dragged into a terminal there.
 */
async function uploadInto(sessionId: string, files: File[]): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session || session.exited) {
    toast("This terminal is not running.");
    return;
  }
  const limit = `${MAX_UPLOAD_BYTES / 1024 / 1024} MB`;
  const tooBig = files.find((file) => file.size > MAX_UPLOAD_BYTES);
  if (tooBig) toast(`${tooBig.name || "The file"} is over ${limit}; it was not uploaded.`);
  const wanted = files.filter((file) => file.size <= MAX_UPLOAD_BYTES);
  if (wanted.length === 0) return;
  toast(wanted.length === 1 ? `Uploading ${wanted[0]!.name || "the image"}…` : `Uploading ${wanted.length} files…`);
  const paths: string[] = [];
  for (const file of wanted) {
    try {
      const response = await fetch("/api/upload", {
        method: "POST",
        headers: { "content-type": file.type || "application/octet-stream", "x-file-name": encodeURIComponent(file.name) },
        body: file,
      });
      if (!response.ok) throw new Error((await response.text()) || `the server answered ${response.status}`);
      paths.push(((await response.json()) as { path: string }).path);
    } catch (error) {
      toast(`${file.name || "The file"} was not uploaded: ${(error as Error).message}`);
    }
  }
  if (paths.length === 0) return;
  const typed = `${paths.map(quotePath).join(" ")} `;
  const view = tiles.get(sessionId)?.terminal;
  if (view) {
    view.pasteText(typed);
    toast(paths.length === 1 ? `Uploaded to ${paths[0]}` : `Uploaded ${paths.length} files to ${paths[0]!.replace(/\/[^/]*$/, "")}`);
  } else {
    // Its window went away meanwhile: the path, to type in by hand.
    toast(`Uploaded to ${paths.join(" ")}`);
  }
}

/** A path as a shell reads it: as it is when it holds nothing a shell would take apart. */
function quotePath(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`;
}

/** The board's window for the tab shown, while it is open. */
let board: BoardWindow | null = null;
let boardTab: string | null = null;

function copyText(text: string): void {
  navigator.clipboard
    ?.writeText(text)
    .then(() => toast("Copied."))
    .catch(() => toast("Copying needs HTTPS or localhost; the text is selected, press Ctrl+C."));
  if (!navigator.clipboard) toast("Copying needs HTTPS or localhost; the text is selected, press Ctrl+C.");
}

/** What the tabs' marks and the board show of a terminal (titles change too often to redraw them for). */
function stateOf(session: SessionView): string {
  return JSON.stringify([session.agent, session.exited, session.atPrompt, session.banner, session.color]);
}

function sameFrame(a: Frame | undefined, b: Frame | undefined): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.z === b.z;
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
newButton.addEventListener("click", () => createTerminal());
newMoreButton.addEventListener("click", () => newDialog.open());

/** The terminal focused last, whose directory a new terminal starts in. */
let lastFocused: string | null = null;

/**
 * A new terminal at once, without the dialog: it takes a free cell of the tab's grid (or
 * cascades), sized to fill that window at the preferred text size, and starts in the current
 * directory of the terminal used last in this tab.
 */
function createTerminal(): void {
  const tab = currentView().tab?.id;
  const { cols, rows } = recommendedSize(tileArea().area, measureFont(FONT_FAMILY));
  const from = lastFocused !== null && sessions.get(lastFocused)?.tab === tab ? lastFocused : undefined;
  createdHereAt = Date.now();
  send({ t: "create", cols, rows, tab, cwdOf: from });
}
const resizeDialog = createResizeDialog();
const restoreDialog = createRestoreDialog({
  send,
  tabName: (id) => tabs.find((tab) => tab.id === id)?.name ?? "",
  open: (cwd, cmd) => {
    const { cols, rows } = recommendedSize(tileArea().area, measureFont(FONT_FAMILY));
    createdHereAt = Date.now();
    send({ t: "create", cols, rows, tab: currentView().tab?.id, cwd, cmd });
  },
});
restoreButton.addEventListener("click", () => restoreDialog.open());

function setStatus(): void {
  statusDot.className = `status ${connected ? (daemonUp ? "ok" : "warn") : "down"}`;
  statusDot.title = connected ? (daemonUp ? "Connected" : "Daemon not running") : "Reconnecting…";
  if (!connected) notice.textContent = "Connection to the server lost. Reconnecting…";
  else if (!daemonUp) notice.textContent = "The daemon is not running. Start it with `spectraweaver up`.";
  notice.hidden = connected && daemonUp;
}

let shownIcon = "";

/**
 * Browser-tab title and icon show the workspace, so several open windows are easy to tell apart;
 * `waiting` counts what needs someone, in every tab.
 */
function updateWindowIdentity(tab: TabView | null, waiting: number): void {
  document.title = `${waiting > 0 ? `(${waiting}) ` : ""}${tab ? `${tab.name} · ` : ""}SpectraWeaver`;
  const color = tab?.color ?? "#3794ff";
  const dot = waiting > 0 ? '<circle cx="12" cy="4" r="3.5" fill="#cca700" stroke="#1f1f1f" stroke-width="1"/>' : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="1" y="2" width="14" height="12" rx="3" fill="${color}"/><path d="M4 6l2.5 2L4 10M8 10h4" stroke="#1f1f1f" stroke-width="1.5" fill="none"/>${dot}</svg>`;
  if (svg === shownIcon) return;
  shownIcon = svg;
  favicon.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// ---- tiles -----------------------------------------------------------------------------

class Tile {
  readonly root: HTMLElement;
  private view: TermView | null = null;
  private session: SessionView;
  /** Its place as a window while the tab is laid out as windows; null in a grid. */
  private frame: Frame | null = null;
  private readonly chrome: WindowChrome;
  private readonly body: HTMLDivElement;
  private readonly banner: HTMLInputElement;
  private readonly subtitle: HTMLSpanElement;
  private readonly size: HTMLButtonElement;
  private readonly exitBadge: HTMLSpanElement;
  private readonly agentBadge: HTMLSpanElement;
  private readonly focusButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;

  constructor(session: SessionView) {
    this.session = session;
    const grip = el("span", { class: "grip", draggable: "true", title: "Drag onto a tab to move this terminal" }, ["⠿"]);
    this.banner = el("input", { class: "banner", placeholder: "What is this terminal doing?", spellcheck: "false" });
    this.subtitle = el("span", { class: "subtitle" });
    this.size = el("button", { class: "meta size-btn", type: "button" });
    this.exitBadge = el("span", { class: "badge exited", hidden: "" });
    this.agentBadge = el("span", { class: "badge agent", hidden: "" });
    this.focusButton = el("button", { class: "icon-btn", title: "Focus this terminal" }, ["⤢"]);
    const windowButton = el("button", { class: "icon-btn", title: "Open in a new window" }, ["↗"]);
    this.closeButton = el("button", { class: "icon-btn" }, ["✕"]);
    this.body = el("div", { class: "tile-body" });
    const header = el("div", { class: "tile-header" }, [
      grip,
      el("span", { class: "bell-dot", title: "Wants attention" }, ["●"]),
      this.banner,
      this.subtitle,
      this.agentBadge,
      this.exitBadge,
      this.size,
      this.focusButton,
      windowButton,
      this.closeButton,
    ]);
    this.root = el("section", { class: "tile" }, [header, this.body]);
    this.chrome = new WindowChrome({
      root: this.root,
      header,
      banner: this.banner,
      body: this.body,
      workspace: grid,
      frame: () => this.frame,
      // The terminal follows the window's size while it can be resized; otherwise only the window changes.
      cell: () => (this.resizable() ? (this.view?.cellSize() ?? null) : null),
      size: () => ({ cols: this.session.cols, rows: this.session.rows }),
      snap: () => snapBox.checked,
      commit: (frame, cells) => {
        this.setFrame(frame); // at once; the server's broadcast confirms it for every browser
        send({ t: "session-frame", session: this.session.id, frame });
        if (cells) this.view?.requestResize(cells.cols, cells.rows);
      },
      restore: () => this.setFrame(this.frame),
      raise: () => raiseWindow(this.session.id),
    });

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
    // In a tab with a board, × only puts the window away, as its task brings it back; ending
    // the program takes the header's menu (or the task's).
    this.closeButton.addEventListener("click", () => {
      if (boardOf(this.session.tab)) putAway(this.session.id);
      else terminate(this.session.id);
    });
    header.addEventListener("contextmenu", (event) => {
      if (event.target === this.banner) return; // the banner's own menu, to paste into it
      event.preventDefault();
      openMenu(terminalMenu(this.session.id, false), event.clientX, event.clientY);
    });
    // Files dropped on the window are uploaded, and their paths typed into the terminal.
    this.root.addEventListener("dragover", (event) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.dataTransfer!.dropEffect = "copy";
      this.root.classList.add("file-drop");
    });
    this.root.addEventListener("dragleave", (event) => {
      if (!this.root.contains(event.relatedTarget as Node | null)) this.root.classList.remove("file-drop");
    });
    this.root.addEventListener("drop", (event) => {
      this.root.classList.remove("file-drop");
      if (!carriesFiles(event)) return;
      event.preventDefault();
      void uploadInto(this.session.id, [...event.dataTransfer!.files]);
    });
    this.size.addEventListener("click", () => {
      const target = this.view?.resizeTarget(nameOf(this.session.id));
      if (target) resizeDialog.open(target);
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
        if (focused) lastFocused = this.session.id;
        this.root.classList.toggle("focused", focused);
        if (focused && belled.delete(this.session.id)) render();
      },
      notify: toast,
      upload: (files) => void uploadInto(this.session.id, files),
    });
    this.view.mount(this.body);
    this.view.setResizable(this.resizable());
    send({ t: "sub", session: this.session.id });
  }

  get terminal(): TermView | null {
    return this.view;
  }

  get sessionId(): string {
    return this.session.id;
  }

  get windowFrame(): Frame | null {
    return this.frame;
  }

  /**
   * Places the tile as a window (null puts it back in the grid). As a window, its edges resize
   * the window and the terminal together, so the terminal's own handles hide.
   */
  setFrame(frame: Frame | null): void {
    this.frame = frame;
    // While it is being dragged, the window is where the pointer put it; the drag's end lays it
    // out from its frame again.
    if (this.chrome.active) return;
    const style = this.root.style;
    if (frame) {
      style.left = `${(frame.x * 100).toFixed(2)}%`;
      style.top = `${(frame.y * 100).toFixed(2)}%`;
      style.width = `${(frame.w * 100).toFixed(2)}%`;
      style.height = `${(frame.h * 100).toFixed(2)}%`;
      style.zIndex = String(frame.z + 1);
    } else {
      style.left = style.top = style.width = style.height = style.zIndex = "";
    }
    this.root.classList.toggle("window", frame !== null);
    this.chrome.setEnabled(frame !== null);
    this.view?.setResizable(this.resizable());
  }

  update(session: SessionView): void {
    this.session = session;
    this.root.style.setProperty("--tile-color", session.color);
    if (document.activeElement !== this.banner) this.banner.value = session.banner;
    this.subtitle.textContent = session.title;
    this.subtitle.title = session.title;
    this.size.textContent = `${session.cols}×${session.rows}`;
    const resizable = this.resizable();
    this.size.disabled = !resizable;
    this.size.title = `${
      resizable
        ? this.frame
          ? "Columns × rows. Click to resize, or drag the window's edges or corners."
          : "Columns × rows. Click to resize, or drag the terminal's right edge, bottom edge or corner."
        : session.exited
          ? "Columns × rows."
          : "Columns × rows. Resizing needs a restarted daemon: spectraweaver down --all (every session ends), then spectraweaver up."
    }\n${session.cwd}`;
    this.view?.setResizable(resizable);
    const exited = session.exited;
    this.exitBadge.hidden = !exited;
    if (exited) this.exitBadge.textContent = exited.signal ? `exited (${exited.signal})` : `exited ${exited.code ?? ""}`;
    this.focusButton.textContent = currentView().focus === session.id ? "⤡" : "⤢";
    // The lead's window stays out; a worker's × puts it away; elsewhere × ends the terminal.
    this.closeButton.hidden = isLead(session.id);
    const board = boardOf(session.tab);
    this.closeButton.title = !board
      ? "Close terminal"
      : `Put away; it keeps running. ${
          board.tasks.some((task) => task.session === session.id)
            ? "Double-click its task on the board to bring it back."
            : "The board lists it (“off the board”) to bring it back."
        }\nRight-click the header to terminate it.`;
    this.root.classList.toggle("bell", belled.has(session.id));
    this.showAgent(session.agent);
  }

  /** What the terminal's coding agent is doing; a stop or a warning turns the window red. */
  private showAgent(agent: AgentStatus | undefined): void {
    const badge = this.agentBadge;
    badge.hidden = !agent;
    // The same words as on the board, without the idle time, which a window does not keep up to date.
    const live = agent ? agentLive("", agent, Date.now(), false) : null;
    this.root.classList.toggle("alarm", live?.alarm === "red");
    this.root.classList.toggle("asking", live?.alarm === "amber");
    if (!agent || !live) return;
    if (badge.textContent !== live.text) badge.textContent = live.text;
    badge.className = `badge agent ${live.kind}`;
    const reason = agent.reason ? ` (${agent.reason})` : "";
    badge.title = [
      `${agent.name}: ${agent.activity}${reason}`,
      agent.warning && `warning: ${agent.warning}`,
      agent.detail,
      agent.resetsAt !== undefined && `the limit lifts ${new Date(agent.resetsAt).toLocaleString()}`,
      agent.model && `model: ${agent.model}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  /** The daemon message changed: the terminal's controls follow what the daemon can do. */
  refresh(): void {
    this.update(this.session);
  }

  /** Whether this terminal can be resized: the daemon must know how, and the program must be running. */
  private resizable(): boolean {
    return daemonFeatures.has("resize") && !this.session.exited;
  }

  dispose(): void {
    send({ t: "unsub", session: this.session.id });
    this.view?.dispose();
    this.chrome.dispose();
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

  const ordered = [...sessions.values()].sort((a, b) => a.createdAt - b.createdAt);
  // As windows, placed terminals sit where their frames say; the others take a free cell of the
  // tab's grid, or cascade, worked out the same way in every browser. Windows put away are not
  // shown (nor subscribed to) until their task brings them out. Only a tab with a board puts
  // windows away, so in one without (a board cleared, say) every window shows.
  const windowed = !view.focus; // focusing one terminal shows it alone, filling the page
  const putAwayHere = view.tab?.board !== undefined;
  const visible = view.focus
    ? ordered.filter((session) => session.id === view.focus)
    : ordered.filter((session) => session.tab === view.tab?.id && !(session.hidden && putAwayHere));
  const visibleIds = new Set(visible.map((session) => session.id));
  grid.classList.toggle("windows", windowed);
  snapToggle.hidden = !windowed;
  const placed: Frame[] = windowed ? visible.flatMap((session) => (session.frame ? [session.frame] : [])) : [];
  let unplaced = 0;

  // The board's window: always while the tab has a board; an empty one once opened from the tab's menu.
  const boardOpen = windowed && !!view.tab && (view.tab.board !== undefined || view.tab.boardWindow?.open === true);
  if (board && (!boardOpen || boardTab !== view.tab?.id)) {
    board.dispose();
    board = null;
    boardTab = null;
  }
  if (boardOpen && view.tab) {
    const tabId = view.tab.id;
    if (!board) {
      board = new BoardWindow(view.tab, {
        workspace: grid,
        snap: () => snapBox.checked,
        openTerminal: openTask,
        showTerminal,
        terminalMenu: (sessionId) => terminalMenu(sessionId, true),
        close: () => send({ t: "board-window", tab: tabId, open: false }),
        setDirection: (direction) => send({ t: "board-window", tab: tabId, direction }),
        commit: (frame) => send({ t: "board-window", tab: tabId, frame }),
        raise: () => raiseBoard(),
        copy: copyText,
      });
      boardTab = tabId;
      grid.appendChild(board.root);
    }
    const frame = view.tab.boardWindow?.frame ?? { ...DEFAULT_BOARD_FRAME, z: topZ(placed) + 1 };
    board.setFrame(frame);
    placed.push(frame);
  }

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
    let frame: Frame | null = null;
    if (windowed) {
      frame = session.frame ?? placeWindow(gridOf(view.tab), placed, unplaced++);
      if (!session.frame) placed.push(frame);
    }
    tile.setFrame(frame);
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

  empty.hidden = visible.length > 0 || board !== null;
  empty.textContent = view.focus
    ? "This terminal no longer exists."
    : lost.length > 0
      ? `${lost.length} terminal${lost.length === 1 ? " was" : "s were"} lost when the daemon stopped. Open them again with “↻ Restore”.`
      : "No terminals in this tab yet. Create one with “+ New terminal”, or drag one here onto the tab.";
  layoutGrid();
  updateRestoreButton();
  renderStatus();
}

/**
 * What follows the terminals' states: the tabs' marks and counts, the browser tab's title and
 * the board. Runs when a terminal's state changes (not its title); each part
 * updates in place, and the board only when what it shows changed.
 */
function renderStatus(): void {
  const view = currentView();
  const now = Date.now();
  const counts = new Map<string, number>();
  const alerts = new Set<string>();
  let waiting = 0;
  for (const session of sessions.values()) {
    counts.set(session.tab, (counts.get(session.tab) ?? 0) + 1);
    if (belled.has(session.id) || needsSomeone(session)) {
      alerts.add(session.tab);
      waiting++;
    }
  }
  for (const tab of tabs) {
    const { unshown } = boardAlarms(tab, sessions, now);
    if (unshown > 0) alerts.add(tab.id);
    waiting += unshown;
  }
  tabStrip.render({ tabs, activeId: view.tab?.id ?? null, counts, alerts });
  if (board && view.tab && boardTab === view.tab.id) board.update(view.tab, sessions);
  updateWindowIdentity(view.tab, waiting);
}

// Times on the board ("3 min ago", "idle 12m") move on.
setInterval(() => board?.refresh(), 30_000);

// ---- connection ------------------------------------------------------------------------

function onServerMessage(message: ServerMessage): void {
  switch (message.t) {
    case "hello":
      return;
    case "daemon":
      daemonUp = message.up;
      daemonFeatures = new Set(message.features ?? []);
      setStatus();
      for (const tile of tiles.values()) tile.refresh();
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
    case "session": {
      const previous = sessions.get(message.session.id);
      sessions.set(message.session.id, message.session);
      // Agents retitle their terminals many times a second: unless the session changed tabs, was
      // put away or came out, or its window moved (which can move the unplaced windows too), only
      // its own tile, and what follows its state, need updating.
      if (
        previous?.tab === message.session.tab &&
        previous.hidden === message.session.hidden &&
        sameFrame(previous.frame, message.session.frame)
      ) {
        tiles.get(message.session.id)?.update(message.session);
        if (stateOf(previous) !== stateOf(message.session)) renderStatus();
      } else {
        render();
      }
      return;
    }
    case "removed":
      sessions.delete(message.session);
      belled.delete(message.session);
      render();
      return;
    case "snapshot":
      tiles.get(message.snapshot.session)?.terminal?.applySnapshot(message.snapshot);
      return;
    case "bell": {
      // Notifications arrive as bells too, often: a terminal already marked needs nothing more.
      if (tiles.get(message.session)?.terminal?.hasFocus || belled.has(message.session)) return;
      belled.add(message.session);
      const session = sessions.get(message.session);
      if (session) tiles.get(message.session)?.update(session);
      renderStatus();
      return;
    }
    case "lost":
      lost = message.sessions;
      restoreDialog.setLost(lost);
      render();
      return;
    case "conversations":
      restoreDialog.setConversations(message.conversations, message.flags);
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

/** The newest connection; events from older ones are ignored. */
let current: WebSocket | null = null;

/** The next attempt to reconnect, while one is waiting: there is never more than one. */
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleReconnect(): void {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => void reconnect(), reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 5000);
}

function connect(): void {
  clearTimeout(reconnectTimer);
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`);
  // The connection this replaces, if it is still open or opening, would go on receiving
  // every terminal's output that no one reads.
  const previous = current;
  current = ws;
  if (previous && previous.readyState <= WebSocket.OPEN) previous.close();
  ws.binaryType = "arraybuffer";
  ws.addEventListener("open", () => {
    if (ws !== current) return ws.close();
    socket = ws;
    connected = true;
    reconnectDelay = 250;
    setStatus();
    // Subscriptions belong to a connection; existing tiles ask again for fresh snapshots.
    for (const tile of tiles.values()) tile.terminal?.resync();
  });
  ws.addEventListener("message", (event) => {
    if (ws !== current) return;
    if (typeof event.data === "string") onServerMessage(JSON.parse(event.data) as ServerMessage);
    else onOutput(new Uint8Array(event.data as ArrayBuffer));
  });
  ws.addEventListener("close", () => {
    if (ws !== current) return;
    socket = null;
    connected = false;
    setStatus();
    scheduleReconnect();
  });
}

/** Gives up on a connection that stopped answering and opens a new one right away. */
function reconnectNow(): void {
  const stale = current;
  current = null;
  socket = null;
  connected = false;
  setStatus();
  stale?.close();
  clearTimeout(reconnectTimer);
  reconnectDelay = 250;
  void reconnect();
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
    scheduleReconnect();
  }
}

function showApp(): void {
  const main = el("div", { class: "main" }, [grid, empty]);
  app.replaceChildren(
    topbar,
    notice,
    main,
    newDialog.element,
    resizeDialog.element,
    restoreDialog.element,
    settings.element,
    toastBox,
  );
  setStatus();
  render();
}

await ensureLogin(app);
showApp();
connect();
