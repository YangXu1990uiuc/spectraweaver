// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TabView, TILE_COLORS } from "../src/common/protocol.ts";
import { MetaStore } from "../src/server/meta.ts";
import { tempPaths } from "./helpers.ts";

const stores: MetaStore[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  // Write pending saves before the directory goes away.
  for (const meta of stores.splice(0)) meta.flush();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function store(contents?: unknown): { meta: MetaStore; file: string } {
  const { paths, cleanup } = tempPaths();
  cleanups.push(cleanup);
  const file = join(paths.configDir, "..", "meta.json");
  if (contents !== undefined) writeFileSync(file, JSON.stringify(contents));
  const meta = new MetaStore(file);
  stores.push(meta);
  return { meta, file };
}

test("there is always a tab, and unassigned sessions live in the first one", () => {
  const { meta } = store();
  expect(meta.tabs()).toHaveLength(1);
  expect(meta.tabOf("s1")).toBe(meta.tabs()[0]!.id);
});

test("reads version-1 files (banners only) and keeps the banners", () => {
  const { meta } = store({ version: 1, sessions: { s1: { banner: "auth refactor" } } });
  expect(meta.banner("s1")).toBe("auth refactor");
  expect(meta.tabs()).toHaveLength(1);
});

test("tabs can be created, renamed, recoloured, regridded and reordered", () => {
  const { meta, file } = store();
  const first = meta.tabs()[0]!.id;
  expect(meta.createTab({ id: "aaaaaaaa", name: "  agents  ", color: "#2ea043", grid: "2x3" })).toBe(true);
  expect(meta.createTab({ id: "aaaaaaaa", name: "dup", color: "#2ea043", grid: "2x3" })).toBe(false);
  expect(meta.createTab({ id: "not-hex!", name: "bad", color: "#2ea043", grid: "2x3" })).toBe(false);
  expect(meta.updateTab("aaaaaaaa", { name: "infra", color: "#f14c4c", grid: "2x4" })).toBe(true);
  expect(meta.updateTab("aaaaaaaa", { color: "red", grid: "1x10" })).toBe(true); // ignored: invalid values
  expect(meta.tabs()[1]).toEqual({ id: "aaaaaaaa", name: "infra", color: "#f14c4c", grid: "2x4" });
  expect(meta.moveTab("aaaaaaaa", 0)).toBe(true);
  expect(meta.tabs().map((tab) => tab.id)).toEqual(["aaaaaaaa", first]);

  meta.flush();
  expect(new MetaStore(file).tabs().map((tab) => tab.name)).toEqual(["infra", "Main"]);
});

test("deleting a tab moves its sessions to the neighbour and never deletes the last tab", () => {
  const { meta } = store();
  const main = meta.tabs()[0]!.id;
  meta.createTab({ id: "bbbbbbbb", name: "agents", color: "#2ea043", grid: "2x3" });
  meta.setSessionTab("s1", "bbbbbbbb");
  meta.setSessionTab("s2", "bbbbbbbb");
  expect(meta.setSessionTab("s3", "missing0")).toBe(false);

  expect(meta.deleteTab("bbbbbbbb", ["s1", "s2", "s3"])).toEqual(["s1", "s2"]);
  expect(meta.tabOf("s1")).toBe(main);
  expect(meta.deleteTab(main, ["s1"])).toBeNull();
});

test("each new terminal in a tab takes the colour its tab uses least, and keeps it", () => {
  const { meta } = store();
  const live: string[] = [];
  const colors = ["s1", "s2", "s3", "s4"].map((id) => {
    live.push(id);
    return meta.colorOf(id, live);
  });
  expect(colors).toEqual(TILE_COLORS.slice(0, 4));
  expect(meta.colorOf("s2", live)).toBe(TILE_COLORS[1]!);

  // A closed terminal frees its colour for the next one.
  meta.forget("s2");
  live.splice(live.indexOf("s2"), 1);
  live.push("s5");
  expect(meta.colorOf("s5", live)).toBe(TILE_COLORS[1]!);
});

test("a terminal moved to another tab keeps its colour unless that tab already uses it", () => {
  const { meta } = store();
  meta.createTab({ id: "aaaaaaaa", name: "Other", color: TILE_COLORS[0]!, grid: "2x2" });
  const live = ["s1", "s2", "o1"];
  meta.colorOf("s1", live); // first tab: TILE_COLORS[0]
  meta.colorOf("s2", live); // first tab: TILE_COLORS[1]
  meta.setSessionTab("o1", "aaaaaaaa", live);
  expect(meta.colorOf("o1", live)).toBe(TILE_COLORS[0]!); // alone in its tab

  meta.setSessionTab("s2", "aaaaaaaa", live); // TILE_COLORS[1] is free there: kept
  expect(meta.colorOf("s2", live)).toBe(TILE_COLORS[1]!);
  meta.setSessionTab("s1", "aaaaaaaa", live); // TILE_COLORS[0] is taken by o1: recoloured
  expect(meta.colorOf("s1", live)).toBe(TILE_COLORS[2]!);
});

test("a window frame is stored checked, survives a restart, and goes when the terminal changes tab", () => {
  const { meta, file } = store();
  const main = meta.tabs()[0]!.id;
  expect(meta.frameOf("s1")).toBeUndefined();
  expect(meta.setSessionFrame("s1", { x: 0.123456, y: 0.2, w: 0.5, h: 0.25, z: 2 })).toBe(true);
  const stored = { x: 0.1235, y: 0.2, w: 0.5, h: 0.25, z: 2 };
  expect(meta.frameOf("s1")).toEqual(stored);
  expect(meta.setSessionFrame("s1", { x: 0.1, y: 0.2, w: "wide", h: 0.25, z: 2 })).toBe(false);
  expect(meta.setSessionFrame("s1", "nope")).toBe(false);
  expect(meta.frameOf("s1")).toEqual(stored); // the bad ones changed nothing
  meta.flush();
  expect(new MetaStore(file).frameOf("s1")).toEqual(stored);

  meta.createTab({ id: "cccccccc", name: "other", color: "#2ea043", grid: "2x2" });
  meta.setSessionTab("s1", main); // the tab it is already in: the window stays
  expect(meta.frameOf("s1")).toEqual(stored);
  meta.setSessionTab("s1", "cccccccc"); // another tab: no window there yet
  expect(meta.frameOf("s1")).toBeUndefined();
  meta.setSessionFrame("s1", { x: 0, y: 0, w: 0.5, h: 0.5, z: 1 });
  meta.deleteTab("cccccccc", ["s1"]); // moved to the neighbour: likewise
  expect(meta.frameOf("s1")).toBeUndefined();
});

test("a session missing from the same daemon was closed; from a new daemon, it was lost", () => {
  const { meta, file } = store();
  const revival = { cwd: "/work", cols: 80, rows: 24 };
  meta.reconcile(new Set(["a", "b", "c"]), "daemon-1");
  for (const id of ["a", "b"]) meta.setRevival(id, revival);
  meta.setBanner("a", "auth refactor");
  meta.setBanner("c", "no revival noted");

  // The same daemon: "b" was closed while the server was away.
  meta.reconcile(new Set(["a", "c"]), "daemon-1");
  expect(meta.revival("b")).toBeUndefined();
  expect(meta.lostIds()).toEqual([]);

  // A new daemon: "a" is lost and kept; "c" had nothing to restore it from.
  meta.reconcile(new Set(), "daemon-2");
  expect(meta.lostIds()).toEqual(["a"]);
  expect(meta.banner("c")).toBe("");
  // Lost terminals stay through later reconnects, and across server restarts.
  meta.reconcile(new Set(["d"]), "daemon-2");
  meta.flush();
  const reread = new MetaStore(file);
  expect(reread.lostIds()).toEqual(["a"]);

  // Restoring hands the lost terminal's banner, colour and window to the new one.
  const color = meta.colorOf("a", []);
  meta.adopt("d", "a");
  expect(meta.lostIds()).toEqual([]);
  expect(meta.banner("d")).toBe("auth refactor");
  expect(meta.colorOf("d", ["d"])).toBe(color);
});

test("revival notes are written only when they change", async () => {
  const { meta, file } = store();
  const revival = { cwd: "/work", cols: 80, rows: 24, agent: { name: "claude", flags: [], pid: 7 } };
  meta.setRevival("a", revival);
  meta.flush();
  writeFileSync(file, "untouched");
  meta.setRevival("a", { ...revival, agent: { ...revival.agent } }); // noted again every few seconds
  await Bun.sleep(250);
  expect(readFileSync(file, "utf8")).toBe("untouched");
  meta.setRevival("a", undefined); // its program exited
  expect(meta.revival("a")).toBeUndefined();
});

test("a tab's board, its window, and windows put away are kept", () => {
  const { meta, file } = store();
  const tab = meta.tabs()[0]!.id;
  const board = { tasks: [{ id: "T1", title: "x", status: "todo" as const }], updatedAt: 1 };
  expect(meta.setBoard(tab, board)).toBe(true); // the first board opens its window
  expect(meta.setBoard(tab, { ...board, updatedAt: 2 })).toBe(false);
  expect(meta.tabs()[0]!.boardWindow).toEqual({ open: true });
  expect(meta.setBoardWindow(tab, { frame: { x: 0, y: 0, w: 0.6, h: 1, z: 3 } })).toBe(true);
  expect(meta.setBoardWindow(tab, { frame: "nonsense" })).toBe(false);
  expect(meta.setBoardWindow(tab, { direction: "right" })).toBe(true);
  expect(meta.setBoardWindow(tab, { direction: "sideways" })).toBe(false);
  meta.setHidden("s1", true);
  meta.flush();

  const again = new MetaStore(file);
  stores.push(again);
  expect(again.board(tab)?.updatedAt).toBe(2);
  expect(again.tabs()[0]!.boardWindow).toEqual({ open: true, frame: { x: 0, y: 0, w: 0.6, h: 1, z: 3 }, direction: "right" });
  expect(again.setBoardWindow(tab, { direction: "auto" })).toBe(true);
  expect(again.tabs()[0]!.boardWindow?.direction).toBeUndefined();
  expect(again.hiddenOf("s1")).toBe(true);
  // A window moved to another tab comes out of the taskbar there.
  expect(again.createTab({ id: "bbbbbbbb", name: "other", color: "#2ea043", grid: "2x2" })).toBe(true);
  again.setSessionTab("s1", "bbbbbbbb");
  expect(again.hiddenOf("s1")).toBe(false);
  expect(again.clearBoard(tab)).toBe(true);
  expect(again.board(tab)).toBeUndefined();
  expect(again.tabs()[0]!.boardWindow?.open).toBe(false);
});

test("a board that is not well formed is dropped when read, not trusted", () => {
  const { meta } = store({
    version: 2,
    sessions: {},
    tabs: [{ id: "aaaaaaaa", name: "x", color: "#2ea043", grid: "2x2", board: { tasks: "nope" }, boardWindow: { open: "yes" } }],
  });
  expect(meta.tabs()[0]).toEqual({ id: "aaaaaaaa", name: "x", color: "#2ea043", grid: "2x2" });
});
