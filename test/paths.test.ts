// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateOlderState } from "../src/common/config.ts";
import { networkFilesystem } from "../src/common/files.ts";
import { hostKey, resolvePaths } from "../src/common/paths.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir().length > 40 ? "/tmp" : tmpdir(), "sw-paths-"));
  dirs.push(dir);
  return dir;
}

test("host directory names are short, readable and distinct", () => {
  expect(hostKey("devbox-01")).toBe("devbox-01");
  expect(hostKey("node7.cluster.example.com")).toBe("node7");
  const a = hostKey("sjc22-be105-2e9197a8-ea3f-473f-af17-8605654ee2f4-0A34AA951EB6.local");
  const b = hostKey("sjc22-be105-2e9197a8-ea3f-473f-af17-8605654ee2f4-1B45BB062FC7.local");
  expect(a).toHaveLength(20);
  expect(a).not.toBe(b);
  expect(hostKey("sjc22-be105-2e9197a8-ea3f-473f-af17-8605654ee2f4-0A34AA951EB6.local")).toBe(a);
});

test("state goes in a per-host directory, so hosts sharing an NFS home don't collide", () => {
  const base = scratch();
  const paths = resolvePaths({ XDG_CONFIG_HOME: join(base, "cfg"), XDG_STATE_HOME: join(base, "st") });
  expect(paths.stateBase).toBe(join(base, "st", "spectraweaver"));
  expect(paths.stateDir).toBe(join(base, "st", "spectraweaver", hostKey()));
  expect(paths.daemonSocket).toBe(join(paths.stateDir, "daemon.sock"));
  expect(paths.stateSource).toBe("default");
  expect(paths.configDir).toBe(join(base, "cfg", "spectraweaver"));
});

test("`config state-dir` (stateDir in config.json) moves state out of a small home", () => {
  const base = scratch();
  const configDir = join(base, "cfg");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ stateDir: join(base, "big-disk") }));
  const paths = resolvePaths({ SPECTRAWEAVER_CONFIG_DIR: configDir });
  expect(paths.stateDir).toBe(join(base, "big-disk", hostKey()));
  expect(paths.stateSource).toContain("config.json");
});

test("environment variables take precedence, in order", () => {
  const base = scratch();
  const configDir = join(base, "cfg");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ stateDir: join(base, "setting") }));

  const home = resolvePaths({ SPECTRAWEAVER_HOME: join(base, "wh") });
  expect(home.configDir).toBe(join(base, "wh", "config"));
  expect(home.stateDir).toBe(join(base, "wh", "state", hostKey()));

  const explicit = resolvePaths({ SPECTRAWEAVER_CONFIG_DIR: configDir, SPECTRAWEAVER_STATE_DIR: join(base, "env") });
  expect(explicit.stateDir).toBe(join(base, "env", hostKey()));
  expect(explicit.stateSource).toBe("$SPECTRAWEAVER_STATE_DIR");
});

test("a daemon from the old flat layout keeps its directory until it exits", () => {
  const base = scratch();
  const stateBase = join(base, "st");
  mkdirSync(stateBase, { recursive: true });
  writeFileSync(join(stateBase, "daemon.pid"), `${process.pid}\n`); // alive: this process
  const env = { SPECTRAWEAVER_CONFIG_DIR: join(base, "cfg"), SPECTRAWEAVER_STATE_DIR: stateBase };
  expect(resolvePaths(env).stateDir).toBe(stateBase);

  writeFileSync(join(stateBase, "daemon.pid"), "999999999\n"); // no such process
  writeFileSync(join(stateBase, "meta.json"), "{}");
  const paths = resolvePaths(env);
  expect(paths.stateDir).toBe(join(stateBase, hostKey()));
  expect(migrateOlderState(paths)).toEqual([`moved   meta.json from ${stateBase} into ${paths.stateDir}`]);
  expect(existsSync(join(paths.stateDir, "meta.json"))).toBe(true);
  expect(existsSync(join(stateBase, "meta.json"))).toBe(false);
});

test("the former name's directories stay in use while its daemon runs, then move over", () => {
  const base = scratch();
  const env = { XDG_CONFIG_HOME: join(base, "cfg"), XDG_STATE_HOME: join(base, "st") };
  const formerConfig = join(base, "cfg", "workstreams");
  const formerState = join(base, "st", "workstreams"); // the flat layout
  mkdirSync(formerConfig, { recursive: true });
  mkdirSync(formerState, { recursive: true });
  writeFileSync(join(formerConfig, "auth.token"), "t".repeat(32));
  writeFileSync(join(formerState, "meta.json"), "{}");
  writeFileSync(join(formerState, "daemon.pid"), `${process.pid}\n`); // alive: this process

  let paths = resolvePaths(env);
  expect(paths.configDir).toBe(formerConfig);
  expect(paths.stateDir).toBe(formerState);
  // While the old daemon runs, only the config directory is copied, and the original stays
  // for other hosts that share it.
  expect(migrateOlderState(paths)).toEqual([`copied  ${formerConfig} to ${join(base, "cfg", "spectraweaver")}`]);
  paths = resolvePaths(env);
  expect(paths.configDir).toBe(join(base, "cfg", "spectraweaver"));
  expect(readFileSync(paths.tokenFile, "utf8")).toBe("t".repeat(32));
  expect(existsSync(join(formerConfig, "auth.token"))).toBe(true);
  expect(paths.stateDir).toBe(formerState);

  writeFileSync(join(formerState, "daemon.pid"), "999999999\n"); // it has exited
  paths = resolvePaths(env);
  expect(paths.stateDir).toBe(join(base, "st", "spectraweaver", hostKey()));
  expect(migrateOlderState(paths)).toEqual([`moved   meta.json from ${formerState} into ${paths.stateDir}`]);
  expect(existsSync(join(paths.stateDir, "meta.json"))).toBe(true);
});

test("a per-host state directory under the former name is found too", () => {
  const base = scratch();
  const env = { XDG_CONFIG_HOME: join(base, "cfg"), XDG_STATE_HOME: join(base, "st") };
  const formerHostDir = join(base, "st", "workstreams", hostKey());
  mkdirSync(formerHostDir, { recursive: true });
  writeFileSync(join(formerHostDir, "instance.json"), "{}");
  writeFileSync(join(formerHostDir, "daemon.pid"), `${process.pid}\n`);
  expect(resolvePaths(env).stateDir).toBe(formerHostDir);

  writeFileSync(join(formerHostDir, "daemon.pid"), "999999999\n");
  const paths = resolvePaths(env);
  expect(migrateOlderState(paths)).toEqual([`moved   instance.json from ${formerHostDir} into ${paths.stateDir}`]);
});

test("a state path too long for a Unix socket is refused with advice", () => {
  const long = `/tmp/${"x".repeat(120)}`;
  expect(() => resolvePaths({ SPECTRAWEAVER_CONFIG_DIR: "/tmp/cfg", SPECTRAWEAVER_STATE_DIR: long })).toThrow(
    /too long for a Unix socket/,
  );
});

test("local directories are not reported as network filesystems", () => {
  expect(networkFilesystem(scratch())).toBeNull();
});
