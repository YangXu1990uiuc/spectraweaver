// Copyright 2026 The workstreams Authors
// SPDX-License-Identifier: Apache-2.0
// Part of workstreams: https://github.com/YangXu1990uiuc/workstreams

import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
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
