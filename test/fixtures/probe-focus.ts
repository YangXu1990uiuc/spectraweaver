// Copyright 2026 The workstreams Authors
// SPDX-License-Identifier: Apache-2.0
// Part of workstreams: https://github.com/YangXu1990uiuc/workstreams

// Turns on focus reporting and records the focus-in/out reports it receives.

process.stdin.setRawMode(true);
let received = "";
process.stdin.on("data", (chunk: Buffer) => {
  received += chunk.toString("latin1");
});
process.stdout.write("\x1b[?1004h");
setTimeout(() => process.stdout.write("READY\r\n"), 100);
setTimeout(() => {
  process.stdout.write(`\r\nFOCUS:${JSON.stringify(received)}\r\n`);
  process.exit(0);
}, 1500);

export {};
