// Copyright 2026 The workstreams Authors
// SPDX-License-Identifier: Apache-2.0
// Part of workstreams: https://github.com/YangXu1990uiuc/workstreams

import { expect, test } from "bun:test";
import {
  decodeJson,
  decodeOutputPayload,
  encodeJsonFrame,
  encodeOutputFrame,
  FrameDecoder,
  KIND_JSON,
  KIND_OUTPUT,
} from "../src/common/protocol.ts";

test("frames survive arbitrary chunking", () => {
  const frames = [
    encodeJsonFrame({ t: "req", id: 1, op: "list" }),
    encodeOutputFrame("abcd1234", 1234, new TextEncoder().encode("héllo \x1b[31mworld")),
    encodeJsonFrame({ t: "evt", ev: { type: "bell", session: "abcd1234" } }),
  ];
  const stream = new Uint8Array(frames.reduce((sum, frame) => sum + frame.length, 0));
  let at = 0;
  for (const frame of frames) {
    stream.set(frame, at);
    at += frame.length;
  }

  for (const chunkSize of [1, 3, 7, stream.length]) {
    const seen: Array<[number, Uint8Array]> = [];
    const decoder = new FrameDecoder((kind, payload) => seen.push([kind, payload]));
    for (let i = 0; i < stream.length; i += chunkSize) decoder.push(stream.subarray(i, i + chunkSize));

    expect(seen.map(([kind]) => kind)).toEqual([KIND_JSON, KIND_OUTPUT, KIND_JSON]);
    expect(decodeJson<unknown>(seen[0]![1])).toEqual({ t: "req", id: 1, op: "list" });
    const output = decodeOutputPayload(seen[1]![1]);
    expect(output.sessionId).toBe("abcd1234");
    expect(output.offset).toBe(1234);
    expect(new TextDecoder().decode(output.data)).toBe("héllo \x1b[31mworld");
  }
});

test("rejects absurd frame lengths", () => {
  const decoder = new FrameDecoder(() => {});
  expect(() => decoder.push(new Uint8Array([0xff, 0xff, 0xff, 0xff, 1]))).toThrow();
});
