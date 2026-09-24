// Copyright 2026 The workstreams Authors
// SPDX-License-Identifier: Apache-2.0
// Part of workstreams: https://github.com/YangXu1990uiuc/workstreams

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateFlatState } from "../src/common/config.ts";
import { networkFilesystem } from "../src/common/files.ts";
import { hostKey, resolvePaths } from "../src/common/paths.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir().length > 40 ? "/tmp" : tmpdir(), "ws-paths-"));
  dirs.push(dir);
  return dir;
}

test("state goes in a per-host directory, so hosts sharing an NFS home don't collide", () => {
  const base = scratch();
  const paths = resolvePaths({ XDG_CONFIG_HOME: join(base, "cfg"), XDG_STATE_HOME: join(base, "st") });
  expect(paths.stateBase).toBe(join(base, "st", "workstreams"));
  expect(paths.stateDir).toBe(join(base, "st", "workstreams", hostKey()));
  expect(paths.daemonSocket).toBe(join(paths.stateDir, "daemon.sock"));
  expect(paths.stateSource).toBe("default");
  expect(paths.configDir).toBe(join(base, "cfg", "workstreams"));
});

test("`config state-dir` (stateDir in config.json) moves state out of a small home", () => {
  const base = scratch();
  const configDir = join(base, "cfg");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ stateDir: join(base, "big-disk") }));
  const paths = resolvePaths({ WORKSTREAMS_CONFIG_DIR: configDir });
  expect(paths.stateDir).toBe(join(base, "big-disk", hostKey()));
  expect(paths.stateSource).toContain("config.json");
});

test("environment variables take precedence, in order", () => {
  const base = scratch();
  const configDir = join(base, "cfg");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ stateDir: join(base, "setting") }));

  const home = resolvePaths({ WORKSTREAMS_HOME: join(base, "wh") });
  expect(home.configDir).toBe(join(base, "wh", "config"));
  expect(home.stateDir).toBe(join(base, "wh", "state", hostKey()));

  const explicit = resolvePaths({ WORKSTREAMS_CONFIG_DIR: configDir, WORKSTREAMS_STATE_DIR: join(base, "env") });
  expect(explicit.stateDir).toBe(join(base, "env", hostKey()));
  expect(explicit.stateSource).toBe("$WORKSTREAMS_STATE_DIR");
});

test("a daemon from the old flat layout keeps its directory until it exits", () => {
  const base = scratch();
  const stateBase = join(base, "st");
  mkdirSync(stateBase, { recursive: true });
  writeFileSync(join(stateBase, "daemon.pid"), `${process.pid}\n`); // alive: this process
  const env = { WORKSTREAMS_CONFIG_DIR: join(base, "cfg"), WORKSTREAMS_STATE_DIR: stateBase };
  expect(resolvePaths(env).stateDir).toBe(stateBase);

  writeFileSync(join(stateBase, "daemon.pid"), "999999999\n"); // no such process
  writeFileSync(join(stateBase, "meta.json"), "{}");
  const paths = resolvePaths(env);
  expect(paths.stateDir).toBe(join(stateBase, hostKey()));
  expect(migrateFlatState(paths)).toEqual(["meta.json"]);
  expect(existsSync(join(paths.stateDir, "meta.json"))).toBe(true);
  expect(existsSync(join(stateBase, "meta.json"))).toBe(false);
});

test("a state path too long for a Unix socket is refused with advice", () => {
  const long = `/tmp/${"x".repeat(120)}`;
  expect(() => resolvePaths({ WORKSTREAMS_CONFIG_DIR: "/tmp/cfg", WORKSTREAMS_STATE_DIR: long })).toThrow(
    /too long for a Unix socket/,
  );
});

test("local directories are not reported as network filesystems", () => {
  expect(networkFilesystem(scratch())).toBeNull();
});
