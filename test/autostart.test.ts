// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTOSTART_MARKER, autostartLine, findAutostart, withAutostart } from "../src/autostart.ts";

const root = mkdtempSync(join(tmpdir(), "sw-autostart-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const theirs = `# m h dom mon dow command
@reboot /usr/bin/tmux new-session -d -s claude-remote '/home/me/.local/bin/claude remote-control'
*/5 * * * * /home/me/bin/backup.sh
`;

test("turning autostart on and off leaves the user's own crontab lines alone", () => {
  const line = `@reboot spectraweaver up ${AUTOSTART_MARKER}`;
  const on = withAutostart(theirs, line);
  expect(on).toBe(`${theirs}${line}\n`);
  expect(findAutostart(on)).toBe(line);
  // Turning it on again replaces the line rather than adding another.
  const newer = `@reboot /new/bun /new/cli.ts up ${AUTOSTART_MARKER}`;
  expect(withAutostart(on, newer)).toBe(`${theirs}${newer}\n`);
  expect(withAutostart(on, null)).toBe(theirs);
  expect(findAutostart(theirs)).toBeUndefined();
  // An empty crontab, and one without a final newline (cron would ignore its last line).
  expect(withAutostart("", line)).toBe(`${line}\n`);
  expect(withAutostart(`${line}\n`, null)).toBe("");
  expect(withAutostart("@daily x", line)).toBe(`@daily x\n${line}\n`);
});

test("the boot line runs `up` in a login shell, with odd paths quoted and % kept from cron", () => {
  // Stand-ins for Bun and the CLI, in directories with a space and a percent sign.
  const dir = join(root, "my 100% bin");
  mkdirSync(dir);
  const bun = join(dir, "bun");
  const record = join(root, "ran.txt");
  writeFileSync(bun, `#!/bin/sh\nprintf '%s|' "$@" "$SPECTRAWEAVER_STATE_DIR" "$FROM_PROFILE" > '${record}'\n`);
  chmodSync(bun, 0o755);
  const home = join(root, "home");
  mkdirSync(home);
  writeFileSync(join(home, ".profile"), "export FROM_PROFILE=yes\n");
  const log = join(root, "state dir", "autostart.log");
  mkdirSync(join(root, "state dir"));

  const line = autostartLine({
    argv: [bun, "/opt/it's here/cli.ts", "up"],
    shell: "/bin/sh",
    env: { SPECTRAWEAVER_STATE_DIR: "/srv/state" },
    log,
  });
  expect(line.startsWith("@reboot ")).toBe(true);
  expect(line).not.toMatch(/[^\\]%/); // every % escaped for cron
  // Cron unescapes \% and hands the rest of the line to sh.
  const command = line.slice("@reboot ".length).replaceAll("\\%", "%");
  const result = Bun.spawnSync(["/bin/sh", "-c", command], { env: { HOME: home, PATH: "/usr/bin:/bin" } });
  expect(result.exitCode).toBe(0);
  expect(readFileSync(record, "utf8")).toBe("/opt/it's here/cli.ts|up|/srv/state|yes|");
  expect(existsSync(log)).toBe(true);
});

test("`spectraweaver autostart` writes, reports and removes its line through crontab", () => {
  const bin = join(root, "fake-bin");
  mkdirSync(bin);
  const file = join(root, "crontab.txt");
  writeFileSync(file, theirs);
  writeFileSync(
    join(bin, "crontab"),
    `#!/bin/sh\ncase "$1" in\n  -l) cat '${file}' ;;\n  -) cat > '${file}' ;;\nesac\n`,
  );
  chmodSync(join(bin, "crontab"), 0o755);
  const cli = (...args: string[]) => {
    const result = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "autostart", ...args], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        SPECTRAWEAVER_CONFIG_DIR: join(root, "config"),
        SPECTRAWEAVER_STATE_DIR: join(root, "state"),
      },
    });
    return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() };
  };

  expect(cli().out).toContain("not started at boot");
  expect(cli("on")).toMatchObject({ code: 0, out: expect.stringContaining("autostart on") });
  const installed = readFileSync(file, "utf8");
  expect(installed.startsWith(theirs)).toBe(true);
  expect(findAutostart(installed)).toContain(join(import.meta.dir, "..", "src", "cli.ts"));
  expect(findAutostart(installed)).toContain(`SPECTRAWEAVER_STATE_DIR=${join(root, "state")}`);
  expect(cli().out).toContain("started at boot (crontab @reboot)");
  expect(cli("off").code).toBe(0);
  expect(readFileSync(file, "utf8")).toBe(theirs);
  expect(cli("sideways").code).toBe(1);
});
