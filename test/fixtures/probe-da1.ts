// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

// Asks the terminal for its primary device attributes (DA1) and reports every byte that
// comes back on stdin, so tests can count how many replies arrived.

process.stdin.setRawMode(true);
let received = "";
process.stdin.on("data", (chunk: Buffer) => {
  received += chunk.toString("latin1");
});
process.stdout.write("\x1b[c");
setTimeout(() => {
  process.stdout.write(`\r\nPROBE:${JSON.stringify(received)}\r\n`);
  process.exit(0);
}, 800);

export {};
