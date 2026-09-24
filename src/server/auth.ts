// Copyright 2026 The workstreams Authors
// SPDX-License-Identifier: Apache-2.0
// Part of workstreams: https://github.com/YangXu1990uiuc/workstreams

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ensurePrivateDir } from "../common/paths.ts";

export const COOKIE_NAME = "workstreams_auth";

export function loadOrCreateToken(file: string): string {
  if (existsSync(file)) {
    const token = readFileSync(file, "utf8").trim();
    if (token.length >= 32) return token;
  }
  ensurePrivateDir(dirname(file));
  const token = randomBytes(24).toString("base64url");
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

/**
 * The cookie is derived from the token rather than stored server-side, so logins survive
 * server restarts and rotating the token invalidates every cookie.
 */
export function deriveCookieValue(token: string): string {
  return createHmac("sha256", token).update("workstreams-cookie-v1").digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

export function hostnameOf(hostHeader: string): string {
  const host = hostHeader.trim().toLowerCase();
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  return host.split(":")[0] ?? "";
}

/**
 * The Host allowlist blocks DNS rebinding. The same-origin check blocks cross-site
 * requests, including WebSocket hijacking (CORS does not cover WebSocket handshakes).
 * Any port is accepted because port forwarders (SSH, VS Code) often remap it.
 */
export class RequestGuard {
  private readonly hosts: Set<string>;

  constructor(extraHosts: string[] = []) {
    this.hosts = new Set([...LOOPBACK_HOSTS, ...extraHosts.map((host) => host.toLowerCase())]);
  }

  check(request: Request, requireOrigin: boolean): boolean {
    const host = request.headers.get("host");
    if (!host || !this.hosts.has(hostnameOf(host))) return false;
    const origin = request.headers.get("origin");
    if (!origin) return !requireOrigin;
    try {
      return new URL(origin).host === host.trim().toLowerCase();
    } catch {
      return false;
    }
  }
}
