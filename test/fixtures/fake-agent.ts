// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

// Stands in for Claude Code or Codex (whichever name it runs under): a full-screen program that
// keeps its conversation where the real one does. As Claude Code, it lists itself in
// $CLAUDE_CONFIG_DIR/sessions/<pid>.json and writes a transcript under projects/; as Codex, it
// writes a rollout under $CODEX_HOME/sessions/ and keeps it open. It exits on Ctrl+C pressed
// twice, and appends its arguments to $FAKE_AGENT_LOG once it is ready.

import { appendFileSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { basename, join } from "node:path";

// Raw mode first, as a real agent is by the time anyone presses Ctrl+C: in cooked mode the
// terminal would turn Ctrl+C into SIGINT.
process.stdin.setRawMode(true);
process.stdin.resume();

const name = basename(process.argv[1] ?? "");
const args = process.argv.slice(2);
const resumeAt = args.indexOf(name === "claude" ? "--resume" : "resume");
const id = resumeAt >= 0 ? args[resumeAt + 1]! : crypto.randomUUID();
const cwd = process.cwd();
let registry: string | null = null;

if (name === "claude") {
  const dir = process.env.CLAUDE_CONFIG_DIR!;
  mkdirSync(join(dir, "sessions"), { recursive: true });
  registry = join(dir, "sessions", `${process.pid}.json`);
  writeFileSync(registry, JSON.stringify({ pid: process.pid, sessionId: id, cwd, startedAt: Date.now(), kind: "interactive" }));
  const project = join(dir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(project, { recursive: true });
  const line = (value: object) => appendFileSync(join(project, `${id}.jsonl`), `${JSON.stringify(value)}\n`);
  line({ type: "user", cwd, sessionId: id, entrypoint: "cli", message: { role: "user", content: "fix the login bug" } });
  line({ type: "ai-title", aiTitle: `Fake work in ${basename(cwd)}`, sessionId: id });
} else {
  const sessions = join(process.env.CODEX_HOME!, "sessions", "2026", "11", "21");
  mkdirSync(sessions, { recursive: true });
  const existing = readdirSync(sessions).find((file) => file.endsWith(`-${id}.jsonl`));
  const path = join(sessions, existing ?? `rollout-2026-11-21T01-02-03-${id}.jsonl`);
  const fresh = !existsSync(path);
  const fd = openSync(path, "a"); // kept open, as Codex does
  // $FAKE_ROLLOUT_CWD lets a test make the open file the only way to tell which rollout is this one's.
  const recorded = process.env.FAKE_ROLLOUT_CWD ?? cwd;
  if (fresh) writeSync(fd, `${JSON.stringify({ type: "session_meta", payload: { id, cwd: recorded, source: "cli" } })}\n`);
  writeSync(fd, `${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "add a test" } })}\n`);
}

process.stdout.write(`\x1b[?1049h\x1b[H${name} (fake) working on ${id}\r\n`);
if (process.env.FAKE_AGENT_LOG) appendFileSync(process.env.FAKE_AGENT_LOG, `${JSON.stringify({ name, args, id, cwd })}\n`);

let lastCtrlC = 0;
process.stdin.on("data", (data: Buffer) => {
  if (!data.includes(3)) return;
  const now = Date.now();
  if (now - lastCtrlC > 1500) {
    lastCtrlC = now;
    return;
  }
  process.stdin.setRawMode(false);
  process.stdout.write("\x1b[?1049l");
  if (registry) rmSync(registry, { force: true });
  process.exit(0);
});
