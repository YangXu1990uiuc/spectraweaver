// Copyright 2026 The workstreams Authors
// SPDX-License-Identifier: Apache-2.0
// Part of workstreams: https://github.com/YangXu1990uiuc/workstreams

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "../common/files.ts";
import { isLoopbackAddress } from "../common/net.ts";
import { ensurePrivateDir } from "../common/paths.ts";

export const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 1024;

export function cookieName(instanceId: string): string {
  return `workstreams_${instanceId}`;
}

/** Tokens are 32 characters; a shorter one is replaced at startup and refused afterwards. */
const MIN_TOKEN_LENGTH = 32;

export function loadOrCreateToken(file: string): string {
  if (existsSync(file)) {
    const token = readFileSync(file, "utf8").trim();
    if (token.length >= MIN_TOKEN_LENGTH) return token;
  }
  return rotateToken(file);
}

/** Replaces the token. Old login links and every existing browser login stop working. */
export function rotateToken(file: string): string {
  ensurePrivateDir(dirname(file));
  const token = randomBytes(24).toString("base64url");
  writeFileAtomic(file, `${token}\n`);
  return token;
}

export function validatePassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `use at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > MAX_PASSWORD_LENGTH) return "that password is too long";
  return null;
}

export async function setPassword(file: string, password: string): Promise<void> {
  const problem = validatePassword(password);
  if (problem) throw new Error(problem);
  const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
  ensurePrivateDir(dirname(file));
  writeFileAtomic(file, `${hash}\n`);
}

export function clearPassword(file: string): void {
  rmSync(file, { force: true });
}

/** Re-reads a small file only when it changes, so CLI edits apply without a restart. */
class WatchedFile {
  private stamp = "";
  private value: string | null = null;

  constructor(private readonly file: string) {}

  read(): string | null {
    const stat = statSync(this.file, { throwIfNoEntry: false });
    const stamp = stat ? `${stat.mtimeMs}:${stat.size}` : "missing";
    if (stamp !== this.stamp) {
      this.stamp = stamp;
      this.value = stat ? readFileSync(this.file, "utf8").trim() || null : null;
    }
    return this.value;
  }
}

/**
 * The token and the optional password hash. The login cookie is derived from both instead
 * of being stored, so logins survive server restarts, while rotating the token or changing
 * the password logs every browser out. If the token file disappears while the server runs
 * (deleted, or its directory moved), nothing signs in until it is back.
 */
export class Credentials {
  private readonly tokenFile: WatchedFile;
  private readonly passwordFile: WatchedFile;

  constructor(tokenPath: string, passwordPath: string) {
    loadOrCreateToken(tokenPath);
    this.tokenFile = new WatchedFile(tokenPath);
    this.passwordFile = new WatchedFile(passwordPath);
  }

  /** Null when the token file is missing or truncated: never an empty key that anyone can match. */
  token(): string | null {
    const token = this.tokenFile.read();
    return token !== null && token.length >= MIN_TOKEN_LENGTH ? token : null;
  }

  passwordHash(): string | null {
    return this.passwordFile.read();
  }

  cookieValue(): string | null {
    const token = this.token();
    if (token === null) return null;
    return createHmac("sha256", token)
      .update(`workstreams-cookie-v2\0${this.passwordHash() ?? ""}`)
      .digest("base64url");
  }

  async verifyPassword(password: string): Promise<boolean> {
    const hash = this.passwordHash();
    if (!hash || password.length > MAX_PASSWORD_LENGTH) return false;
    return Bun.password.verify(password, hash);
  }
}

/**
 * Limits password guessing. Every local user reaches the server from 127.0.0.1, so the
 * limit is global: after five straight failures each further attempt waits out a lockout
 * that doubles, up to 15 minutes. Token logins are not limited; tokens cannot be guessed.
 */
export class LoginThrottle {
  private failures = 0;
  private lockedUntil = 0;

  retryAfterMs(now = Date.now()): number {
    return Math.max(0, this.lockedUntil - now);
  }

  failed(now = Date.now()): void {
    this.failures++;
    if (this.failures >= 5) {
      this.lockedUntil = now + Math.min(15 * 60_000, 30_000 * 2 ** (this.failures - 5));
    }
  }

  succeeded(): void {
    this.failures = 0;
    this.lockedUntil = 0;
  }
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

/**
 * When the server binds a specific non-loopback address, browsers send that address as the
 * Host header, so it must be allowed. Wildcards (0.0.0.0, ::) need explicit --allow-host.
 */
export function boundHostAllowlist(host: string): string[] {
  if (isLoopbackAddress(host) || host === "0.0.0.0" || host === "::" || host === "") return [];
  return [host.includes(":") && !host.startsWith("[") ? `[${host}]` : host];
}

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
