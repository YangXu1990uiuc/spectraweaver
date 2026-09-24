// Copyright 2026 The workstreams Authors
// SPDX-License-Identifier: Apache-2.0
// Part of workstreams: https://github.com/YangXu1990uiuc/workstreams

export function portIsFree(host: string, port: number): boolean {
  try {
    const listener = Bun.listen({ hostname: host, port, socket: { data() {} } });
    listener.stop(true);
    return true;
  } catch {
    return false;
  }
}

/** On a shared machine each user's instance needs its own port; take the first free one. */
export function pickFreePort(host: string, first: number, count: number): number | null {
  for (let port = first; port < first + count; port++) {
    if (portIsFree(host, port)) return port;
  }
  return null;
}

export function isLoopbackAddress(host: string): boolean {
  return host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host);
}
