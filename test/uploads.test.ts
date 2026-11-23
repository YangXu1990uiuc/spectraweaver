// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { saveUpload, uploadDir } from "../src/server/uploads.ts";

let base: string;
let dir: string;
const bytes = new Uint8Array([1, 2, 3]);

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "sw-uploads-"));
  dir = uploadDir(base);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

test("uploads older than a week are removed when the next one comes", () => {
  const first = saveUpload(dir, bytes, "old.png", "image/png");
  const recent = saveUpload(dir, bytes, "recent.png", "image/png");
  const eightDaysAgo = (Date.now() - 8 * 24 * 3600_000) / 1000;
  utimesSync(first, eightDaysAgo, eightDaysAgo);
  saveUpload(dir, bytes, "new.png", "image/png");
  expect(existsSync(first)).toBe(false);
  expect(existsSync(recent)).toBe(true);
});

test("a directory someone else could open, or a link, is refused", () => {
  mkdirSync(dirname(dir), { mode: 0o700 });
  mkdirSync(dir, { mode: 0o755 });
  expect(() => saveUpload(dir, bytes, "a.png", "image/png")).toThrow("not a directory only this user can open");
  rmSync(dir, { recursive: true });
  const elsewhere = join(base, "elsewhere");
  mkdirSync(elsewhere, { mode: 0o700 });
  symlinkSync(elsewhere, dir);
  expect(() => saveUpload(dir, bytes, "a.png", "image/png")).toThrow("not a directory only this user can open");
});

test("an extension comes from the name, else from the type", () => {
  expect(saveUpload(dir, bytes, "notes.MD", "")).toMatch(/-notes-[0-9a-f]{6}\.md$/);
  expect(saveUpload(dir, bytes, "image", "image/webp")).toMatch(/-image-[0-9a-f]{6}\.webp$/);
  expect(saveUpload(dir, bytes, "blob", "application/x-unknown")).toMatch(/-blob-[0-9a-f]{6}\.bin$/);
});
