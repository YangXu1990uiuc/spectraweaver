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
