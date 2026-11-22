// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { expect, test } from "bun:test";
import {
  type DaemonMessage,
  type DaemonResponse,
  decodeJson,
  encodeJsonFrame,
  FrameDecoder,
  type HelloResult,
  KIND_JSON,
  PROTOCOL_VERSION,
} from "../src/common/protocol.ts";
import { startDaemon } from "../src/daemon/daemon.ts";
import { tempPaths, TEST_SHELL, until } from "./helpers.ts";

test("the daemon names what it can do, and answers a request it does not know with an error", async () => {
  const { paths, cleanup } = tempPaths();
  const daemon = await startDaemon({ paths, shellArgv: TEST_SHELL, log: () => {} });
  try {
    const responses: DaemonResponse[] = [];
    const decoder = new FrameDecoder((kind, payload) => {
      if (kind !== KIND_JSON) return;
      const message = decodeJson<DaemonMessage>(payload);
      if (message.t === "res") responses.push(message);
    });
    const socket = await Bun.connect({
      unix: paths.daemonSocket,
      socket: { data: (_socket, chunk) => decoder.push(chunk) },
    });
    socket.write(encodeJsonFrame({ t: "req", id: 1, op: "hello", protocol: PROTOCOL_VERSION, client: "test" }));
    // A newer server or CLI may ask for something this daemon has never heard of.
    socket.write(encodeJsonFrame({ t: "req", id: 2, op: "nonsense" }));
    await until(() => responses.length === 2, "two answers");
    const hello = responses[0]!;
    expect(hello.ok).toBe(true);
    expect((hello.ok ? (hello.result as HelloResult) : null)?.features).toContain("resize");
    expect(responses[1]).toMatchObject({ id: 2, ok: false, error: "unknown request: nonsense" });
    socket.end();
  } finally {
    await daemon.stop();
    cleanup();
  }
});

test("two quick resizes both take, and an unsubscribe sent before the snapshot sticks", async () => {
  const { paths, cleanup } = tempPaths();
  const daemon = await startDaemon({ paths, shellArgv: TEST_SHELL, log: () => {} });
  try {
    const responses = new Map<number, DaemonResponse>();
    let outputs = 0;
    const decoder = new FrameDecoder((kind, payload) => {
      if (kind !== KIND_JSON) {
        outputs++;
        return;
      }
      const message = decodeJson<DaemonMessage>(payload);
      if (message.t === "res") responses.set(message.id, message);
    });
    const socket = await Bun.connect({
      unix: paths.daemonSocket,
      socket: { data: (_socket, chunk) => decoder.push(chunk) },
    });
    const send = (id: number, request: object) => socket.write(encodeJsonFrame({ t: "req", id, ...request }));
    send(1, { op: "create", cols: 80, rows: 24 });
    await until(() => responses.has(1), "the session");
    const id = ((responses.get(1) as { result: { id: string } }).result).id;

    // The second asks for the size the session has now; it must not be taken for no change.
    send(2, { op: "resize", session: id, cols: 100, rows: 30 });
    send(3, { op: "resize", session: id, cols: 80, rows: 24 });
    await until(() => responses.has(2) && responses.has(3), "both resizes");
    expect([...responses.keys()].filter((key) => key === 2 || key === 3)).toEqual([2, 3]); // answered in order
    expect(responses.get(3)).toMatchObject({ ok: true, result: { cols: 80, rows: 24 } });
    send(4, { op: "list" });
    await until(() => responses.has(4), "the list");
    const listed = (responses.get(4) as { result: Array<{ id: string; cols: number; rows: number }> }).result;
    expect(listed.find((session) => session.id === id)).toMatchObject({ cols: 80, rows: 24 });

    // Subscribed and unsubscribed at once: the snapshot comes, but no output after it.
    send(5, { op: "subscribe", session: id });
    send(6, { op: "unsubscribe", session: id });
    await until(() => responses.has(5) && responses.has(6), "both answers");
    outputs = 0;
    send(0, { op: "input", session: id, data: "echo hello\r" });
    await Bun.sleep(300);
    expect(outputs).toBe(0);
    socket.end();
  } finally {
    await daemon.stop();
    cleanup();
  }
});
