// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

// Files a person drops on a terminal's window, or pastes into it (a screenshot), from the browser
// (DESIGN.md §6.7). They are written on this machine, where the terminals' programs can read
// them, and the browser types the path into the terminal. Kept a week, in a directory only this
// user can open: under the temporary directory rather than home, which is often small.

import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** Extensions for types a browser names but a pasted screenshot's file name may lack. */
const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "text/plain": "txt",
};

/** Where uploads go: spectraweaver-<uid>/uploads under the temporary directory. */
export function uploadDir(base = tmpdir()): string {
  return join(base, `spectraweaver-${process.getuid?.() ?? "user"}`, "uploads");
}

/**
 * Makes a directory only this user can open, or checks that it is one: in a temporary directory
 * shared with other users, someone else could have made it first, or left a link there.
 */
function privateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
    throw new Error(`${dir} is not a directory only this user can open; remove it and try again`);
  }
}

/**
 * Writes an upload and returns its path: the time, the file's own name made safe for a command
 * line, and a few random letters, so names never collide and need no quoting. Files older than
 * a week go first.
 */
export function saveUpload(dir: string, bytes: Uint8Array, name: string, type: string, now = Date.now()): string {
  privateDir(join(dir, ".."));
  privateDir(dir);
  prune(dir, now);
  const own = extname(name).slice(1).toLowerCase();
  const extension = /^[a-z0-9]{1,10}$/.test(own) ? own : (EXTENSIONS[type.split(";")[0]!.trim().toLowerCase()] ?? "bin");
  const stem =
    name
      .slice(0, name.length - extname(name).length)
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 40) || "upload";
  const at = new Date(now);
  const two = (value: number) => String(value).padStart(2, "0");
  const stamp = `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
  const path = join(dir, `${stamp}-${stem}-${randomBytes(3).toString("hex")}.${extension}`);
  writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
  return path;
}

/** Removes uploads older than a week; one that cannot be removed stays. */
function prune(dir: string, now: number): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    try {
      const stat = lstatSync(path);
      if (stat.isFile() && now - stat.mtimeMs > KEEP_MS) unlinkSync(path);
    } catch {
      // gone meanwhile, or not ours to remove
    }
  }
}
