// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/headless";
import { expect, test } from "bun:test";
import { Engine } from "../src/daemon/engine.ts";

interface Internals {
  coreService: {
    isCursorHidden: boolean;
    decPrivateModes: { cursorStyle?: string; cursorBlink?: boolean };
  };
  coreMouseService: { activeEncoding: string };
  buffer: { scrollTop: number; scrollBottom: number };
}

function internals(term: Terminal): Internals {
  return (term as unknown as { _core: Internals })._core;
}

function makeEngine(cols = 80, rows = 24) {
  const replies: string[] = [];
  const events = { titles: [] as string[], bells: 0, notifications: [] as string[], cwds: [] as string[] };
  const engine = new Engine(
    { cols, rows, scrollback: 1000, reply: (data) => replies.push(data) },
    {
      onTitle: (title) => events.titles.push(title),
      onBell: () => events.bells++,
      onNotify: (kind, text) => events.notifications.push(`${kind}:${text}`),
      onCwd: (cwd) => events.cwds.push(cwd),
    },
  );
  const write = (data: string) => new Promise<void>((resolve) => engine.write(data, resolve));
  return { engine, replies, events, write };
}

/** A fresh terminal, like a browser that just connected, restored from a snapshot. */
function restore(snapshot: string, cols = 80, rows = 24): Promise<Terminal> {
  const term = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  return new Promise((resolve) => term.write(snapshot, () => resolve(term)));
}

function lines(term: Terminal, which: "normal" | "alternate"): string[] {
  const buffer = which === "normal" ? term.buffer.normal : term.buffer.alternate;
  const out: string[] = [];
  for (let i = 0; i < buffer.length; i++) out.push(buffer.getLine(i)?.translateToString(true) ?? "");
  return out;
}

test("private xterm.js state the engine reads is still where we expect it", () => {
  const { engine } = makeEngine();
  const core = internals(engine.term);
  expect(typeof core.coreService.isCursorHidden).toBe("boolean");
  expect(typeof core.coreService.decPrivateModes).toBe("object");
  expect(typeof core.coreMouseService.activeEncoding).toBe("string");
  expect(typeof core.buffer.scrollTop).toBe("number");
  expect(typeof core.buffer.scrollBottom).toBe("number");
});

test("a snapshot restores content, cursor and the modes SerializeAddon misses", async () => {
  const { engine, write } = makeEngine();
  await write("\x1b[31mred\x1b[0m plain\r\n中文 wide 🙂\r\n$ ");
  // Enter the alternate screen like a full-screen TUI, with SGR mouse, a scroll region,
  // a hidden bar cursor, focus reporting and bracketed paste.
  await write("\x1b[?1049h\x1b[2J\x1b[Halt screen\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[?1004h");
  await write("\x1b[?25l\x1b[5 q\x1b[3;20r\x1b[10;7H");

  const restored = await restore(engine.serialize());

  expect(restored.buffer.active.type).toBe("alternate");
  expect(lines(restored, "alternate")).toEqual(lines(engine.term, "alternate"));
  expect(lines(restored, "normal")).toEqual(lines(engine.term, "normal"));
  expect([restored.buffer.active.cursorX, restored.buffer.active.cursorY]).toEqual([6, 9]);
  expect(restored.modes).toEqual(engine.term.modes);

  const core = internals(restored);
  expect(core.coreMouseService.activeEncoding).toBe("SGR");
  expect(core.coreService.isCursorHidden).toBe(true);
  expect(core.coreService.decPrivateModes.cursorStyle).toBe("bar");
  expect(core.coreService.decPrivateModes.cursorBlink).toBe(true);
  expect([core.buffer.scrollTop, core.buffer.scrollBottom]).toEqual([2, 19]);
});

test("a snapshot of a plain shell screen restores the cursor exactly", async () => {
  const { engine, write } = makeEngine(40, 10);
  await write("line one\r\nline two\r\n$ echo hi\x1b[4D");
  const restored = await restore(engine.serialize(), 40, 10);
  expect(lines(restored, "normal")).toEqual(lines(engine.term, "normal"));
  expect([restored.buffer.active.cursorX, restored.buffer.active.cursorY]).toEqual([
    engine.term.buffer.active.cursorX,
    engine.term.buffer.active.cursorY,
  ]);
});

test("answers colour and version queries and reports notifications", async () => {
  const { replies, events, write } = makeEngine();
  await write("\x1b]11;?\x1b\\\x1b]10;?\x07\x1b[>q\x1b[c");
  expect(replies).toContain("\x1b]11;rgb:1f1f/1f1f/1f1f\x1b\\");
  expect(replies).toContain("\x1b]10;rgb:cccc/cccc/cccc\x1b\\");
  expect(replies.some((reply) => reply.startsWith("\x1bP>|spectraweaver("))).toBe(true);
  expect(replies).toContain("\x1b[?1;2c");

  await write("\x1b]9;4;1;50\x07\x1b]9;build done\x07\x1b]777;notify;Claude;needs input\x07");
  await write("\x1b]7;file://host/tmp/x%20y\x07\x1b]0;my title\x07\x07");
  expect(events.notifications).toEqual(["osc9:build done", "osc777:Claude: needs input"]);
  expect(events.cwds).toEqual(["/tmp/x y"]);
  expect(events.titles).toEqual(["my title"]);
  expect(events.bells).toBe(1);
});
