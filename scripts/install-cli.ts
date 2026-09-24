// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

// Installs a `spectraweaver` command that runs this checkout, so `git pull` updates it.
//   bun run install-cli [DIR]    (DIR defaults to ~/.local/bin)
// Not `bun link`: that makes src/cli.ts writable by everyone (mode 0777), and the daemon runs it.

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { writeFileAtomic } from "../src/common/files.ts";

const MARKER = "# Installed by `bun run install-cli` from a SpectraWeaver checkout.";

const dir = resolve(process.argv[2] ?? join(homedir(), ".local", "bin"));
const command = join(dir, "spectraweaver");
const cli = resolve(import.meta.dir, "..", "src", "cli.ts");

if (existsSync(command) && !(await Bun.file(command).slice(0, 256).text()).includes(MARKER)) {
  console.error(`${command} already exists and was not installed by this script; remove it first.`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true });
writeFileAtomic(command, `#!/bin/sh\n${MARKER}\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`, 0o755);
console.log(`installed ${command}, which runs ${cli}`);

const onPath = (process.env.PATH ?? "").split(delimiter).some((entry) => entry && resolve(entry) === dir);
if (!onPath) {
  console.log(`${dir} is not on your PATH. Add this line to your shell's startup file:\n  export PATH="${dir}:$PATH"`);
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
