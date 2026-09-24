// Copyright 2026 The workstreams Authors
// SPDX-License-Identifier: Apache-2.0
// Part of workstreams: https://github.com/YangXu1990uiuc/workstreams

// Builds single-file executables with the UI embedded. Pass targets to build a subset:
//   bun run scripts/build.ts bun-linux-arm64

const TARGETS = [
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-linux-x64-musl",
  "bun-linux-arm64-musl",
  "bun-darwin-arm64",
  "bun-darwin-x64",
];

const requested = process.argv.slice(2);
for (const target of requested.length > 0 ? requested : TARGETS) {
  if (!TARGETS.includes(target)) {
    console.error(`unknown target ${target}; choose from ${TARGETS.join(", ")}`);
    process.exit(1);
  }
  const outfile = `dist/workstreams-${target.replace(/^bun-/, "")}`;
  console.log(`building ${outfile}`);
  const result = Bun.spawnSync(
    [process.execPath, "build", "--compile", "--minify", `--target=${target}`, "src/cli.ts", "--outfile", outfile],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
}
