// Copyright 2026 The workstreams Authors
// SPDX-License-Identifier: Apache-2.0
// Part of workstreams: https://github.com/YangXu1990uiuc/workstreams

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Paths, resolvePaths } from "../src/common/paths.ts";

/** A plain, predictable shell for tests: no rc files, no prompt customisation. */
export const TEST_SHELL = ["bash", "--norc", "--noprofile"];

export function tempPaths(): { paths: Paths; cleanup(): void } {
  // Unix socket paths are limited to about 100 bytes, so keep the base directory short.
  const root = tmpdir().length > 40 ? "/tmp" : tmpdir();
  const base = mkdtempSync(join(root, "ws-test-"));
  const paths = resolvePaths({
    WORKSTREAMS_CONFIG_DIR: join(base, "config"),
    WORKSTREAMS_STATE_DIR: join(base, "state"),
  });
  return { paths, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

export async function until(check: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

export function fixture(name: string): string {
  return join(import.meta.dir, "fixtures", name);
}
