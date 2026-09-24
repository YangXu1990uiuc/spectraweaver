// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "../src/common/version.ts";

const script = join(import.meta.dir, "..", "scripts", "install-cli.ts");
const install = (dir: string) => Bun.spawnSync([process.execPath, script, dir], { stdout: "pipe", stderr: "pipe" });

test("install-cli installs a spectraweaver command that runs this checkout", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-bin-"));
  try {
    expect(install(dir).exitCode).toBe(0);
    const command = join(dir, "spectraweaver");
    expect(statSync(command).mode & 0o777).toBe(0o755);
    expect(Bun.spawnSync([command, "version"]).stdout.toString().trim()).toBe(VERSION);

    // It replaces its own script, but never a file it did not install.
    expect(install(dir).exitCode).toBe(0);
    writeFileSync(command, "#!/bin/sh\necho something else\n");
    const refused = install(dir);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr.toString()).toContain("was not installed by this script");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
