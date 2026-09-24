// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { Terminal } from "@xterm/headless";
import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { Session, type Subscriber } from "../src/daemon/session.ts";
import { suppressQueryReplies } from "../src/web/queries.ts";
import { fixture, TEST_SHELL, until } from "./helpers.ts";

const DA1_REPLY = "\x1b[?1;2c";
const sessions: Session[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
});

function makeSession(): Session {
  const session = new Session({
    id: "test",
    cols: 80,
    rows: 24,
    cwd: tmpdir(),
    cmd: null,
    argv: TEST_SHELL,
    env: process.env,
    scrollback: 1000,
    emit: () => {},
    onExited: () => {},
  });
  sessions.push(session);
  return session;
}

/** Collects raw output without running a terminal, so it never answers queries. */
class Recorder implements Subscriber {
  closed = false;
  text = "";
  private readonly decoder = new TextDecoder();
  sendOutput(_sessionId: string, _offset: number, data: Uint8Array): void {
    this.text += this.decoder.decode(data, { stream: true });
  }
}

/** Stands in for a browser tab: a terminal whose own replies go back as "typed" input. */
class Viewer implements Subscriber {
  closed = false;
  private readonly term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  private expectedOffset = 0;

  constructor(
    private readonly session: Session,
    suppress: boolean,
  ) {
    if (suppress) suppressQueryReplies(this.term);
    this.term.onData((data) => session.writeInput(data));
  }

  attach(): Promise<void> {
    return new Promise((resolve) =>
      this.session.subscribe(this, (snapshot) => {
        this.term.write(snapshot.data);
        this.expectedOffset = snapshot.offset;
        resolve();
      }),
    );
  }

  sendOutput(_sessionId: string, offset: number, data: Uint8Array): void {
    // The stream after a snapshot must continue exactly at the snapshot's offset.
    if (offset !== this.expectedOffset) throw new Error(`gap: expected ${this.expectedOffset}, got ${offset}`);
    this.expectedOffset += data.length;
    this.term.write(data);
  }
}

function subscribe(session: Session, recorder: Recorder): Promise<void> {
  return new Promise((resolve) =>
    session.subscribe(recorder, (snapshot) => {
      recorder.text += snapshot.data;
      resolve();
    }),
  );
}

async function runProbe(viewers: number, suppress: boolean): Promise<string> {
  const session = makeSession();
  const recorder = new Recorder();
  await subscribe(session, recorder);
  for (let i = 0; i < viewers; i++) await new Viewer(session, suppress).attach();
  session.writeInput(`${process.execPath} ${fixture("probe-da1.ts")}\r`);
  const pattern = /PROBE:(".*")\r*\n/;
  await until(() => pattern.test(recorder.text), "the probe's report");
  return JSON.parse(pattern.exec(recorder.text)![1]!) as string;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test("a query gets exactly one reply with no viewer attached", async () => {
  expect(count(await runProbe(0, true), DA1_REPLY)).toBe(1);
}, 20_000);

test("a query gets exactly one reply with two viewers attached", async () => {
  expect(count(await runProbe(2, true), DA1_REPLY)).toBe(1);
}, 20_000);

test("without suppression, every viewer would reply too", async () => {
  // Documents the failure mode suppressQueryReplies exists for.
  expect(count(await runProbe(2, false), DA1_REPLY)).toBe(3);
}, 20_000);

test("focus reports are aggregated across viewers", async () => {
  const session = makeSession();
  const recorder = new Recorder();
  await subscribe(session, recorder);
  session.writeInput(`${process.execPath} ${fixture("probe-focus.ts")}\r`);
  await until(() => recorder.text.includes("READY"), "focus reporting to be on");

  session.setFocus("tab-a", true); // first viewer focuses: focus-in
  session.setFocus("tab-b", true); // still focused: nothing
  session.setFocus("tab-a", false); // tab-b still focused: nothing
  session.dropFocusWithPrefix("tab-b"); // last viewer gone: focus-out

  const pattern = /FOCUS:(".*")\r*\n/;
  await until(() => pattern.test(recorder.text), "the focus probe's report");
  expect(JSON.parse(pattern.exec(recorder.text)![1]!)).toBe("\x1b[I\x1b[O");
}, 20_000);

test("a startup command is typed into the shell, which stays afterwards", async () => {
  const session = new Session({
    id: "cmd",
    cols: 80,
    rows: 24,
    cwd: tmpdir(),
    cmd: "echo started-$((20+22))",
    argv: TEST_SHELL,
    env: process.env,
    scrollback: 1000,
    emit: () => {},
    onExited: () => {},
  });
  sessions.push(session);
  const recorder = new Recorder();
  await subscribe(session, recorder);
  await until(() => recorder.text.includes("started-42"), "the startup command's output");
  expect(session.exited).toBe(false);
}, 20_000);
