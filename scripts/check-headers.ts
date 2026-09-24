// Copyright 2026 The workstreams Authors
// SPDX-License-Identifier: Apache-2.0
// Part of workstreams: https://github.com/YangXu1990uiuc/workstreams

// Fails if a source file lacks the license header (DESIGN.md §10).

import { Glob } from "bun";

const REQUIRED = [
  /Copyright \d{4} The workstreams Authors/,
  /SPDX-License-Identifier: Apache-2\.0/,
  /Part of workstreams: https:\/\/github\.com\/YangXu1990uiuc\/workstreams/,
];

const missing: string[] = [];
for (const pattern of ["src/**/*.{ts,css,html}", "test/**/*.ts", "scripts/**/*.ts"]) {
  for await (const file of new Glob(pattern).scan(".")) {
    const head = (await Bun.file(file).text()).split("\n").slice(0, 8).join("\n");
    if (!REQUIRED.every((line) => line.test(head))) missing.push(file);
  }
}

if (missing.length > 0) {
  console.error(`Missing license header:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}
console.log("All source files carry the license header.");
