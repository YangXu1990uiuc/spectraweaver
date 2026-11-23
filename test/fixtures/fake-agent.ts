// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

// Stands in for Claude Code or Codex (whichever name it runs under): a full-screen program that
// keeps its conversation where the real one does. As Claude Code, it lists itself in
// $CLAUDE_CONFIG_DIR/sessions/<pid>.json (with its status) and writes a transcript under
// projects/; as Codex, it writes a rollout under $CODEX_HOME/sessions/ and keeps it open. It
// exits on Ctrl+C pressed twice, and appends its arguments to $FAKE_AGENT_LOG once it is ready.
//
// Lines typed into it act out what real agents do:
//   /busy              a turn starts
//   /wait              Claude Code: a dialog waits for an answer
//   /approve           Codex: an approval prompt shows
//   /error KIND        the turn ends with an error of that kind (Claude Code's `error`, Codex's
//                      `codex_error_info`)
//   /warn              Codex: the cyber warning shows
//   anything else      a prompt; the turn it starts ends at once with a reply
// Every line it gets is appended to $FAKE_AGENT_LOG as {name, line}; a paste arrives as one line.

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
const log = (entry: object) => {
  if (process.env.FAKE_AGENT_LOG) appendFileSync(process.env.FAKE_AGENT_LOG, `${JSON.stringify({ name, ...entry })}\n`);
};

let registry: string | null = null;
let record: (entry: object) => void;
const registryEntry = { pid: process.pid, sessionId: id, cwd, startedAt: Date.now(), kind: "interactive", status: "idle" };
const setStatus = (status: string, waitingFor?: string) => {
  if (registry) writeFileSync(registry, JSON.stringify({ ...registryEntry, status, waitingFor, statusUpdatedAt: Date.now() }));
};

if (name === "claude") {
  const dir = process.env.CLAUDE_CONFIG_DIR!;
  mkdirSync(join(dir, "sessions"), { recursive: true });
  registry = join(dir, "sessions", `${process.pid}.json`);
  setStatus("idle");
  const project = join(dir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(project, { recursive: true });
  record = (value: object) => appendFileSync(join(project, `${id}.jsonl`), `${JSON.stringify(value)}\n`);
  record({ type: "user", cwd, sessionId: id, entrypoint: "cli", message: { role: "user", content: "fix the login bug" } });
  record({ type: "ai-title", aiTitle: `Fake work in ${basename(cwd)}`, sessionId: id });
} else {
  const sessions = join(process.env.CODEX_HOME!, "sessions", "2026", "11", "21");
  mkdirSync(sessions, { recursive: true });
  const existing = readdirSync(sessions).find((file) => file.endsWith(`-${id}.jsonl`));
  const path = join(sessions, existing ?? `rollout-2026-11-21T01-02-03-${id}.jsonl`);
  const fresh = !existsSync(path);
  const fd = openSync(path, "a"); // kept open, as Codex does
  record = (value: object) => writeSync(fd, `${JSON.stringify(value)}\n`);
  // $FAKE_ROLLOUT_CWD lets a test make the open file the only way to tell which rollout is this one's.
  const recorded = process.env.FAKE_ROLLOUT_CWD ?? cwd;
  if (fresh) record({ type: "session_meta", payload: { id, cwd: recorded, source: "cli" } });
  record({ type: "event_msg", payload: { type: "user_message", message: "add a test" } });
}

const event = (payload: object) => record({ type: "event_msg", payload });
const show = (text: string): void => {
  process.stdout.write(`${text}\r\n`);
};

// Bracketed paste on, as agents' prompts have it.
process.stdout.write(`\x1b[?1049h\x1b[?2004h\x1b[H${name} (fake) working on ${id}\r\n`);
log({ args, id, cwd });

function act(line: string): void {
  log({ line });
  const [command, kind = ""] = line.split(" ");
  if (name === "claude") {
    switch (command) {
      case "/busy":
        return setStatus("busy");
      case "/wait":
        return setStatus("waiting", "dialog open");
      case "/error":
        record({
          type: "assistant",
          isApiErrorMessage: true,
          error: kind,
          message: { role: "assistant", content: [{ type: "text", text: `API Error: fake ${kind}` }] },
        });
        show(`API Error: fake ${kind}`);
        return setStatus("idle");
      default:
        // A reply in two parts sharing the message's id, as Claude Code records them.
        record({ type: "user", message: { role: "user", content: line } });
        for (const text of ["done", `(you said: ${line})`]) {
          record({ type: "assistant", message: { id: `msg-${line.length}`, role: "assistant", model: "claude-fake-1", content: [{ type: "text", text }] } });
        }
        return setStatus("idle");
    }
  }
  switch (command) {
    case "/busy":
      return event({ type: "task_started", turn_id: "t" });
    case "/approve":
      show("Would you like to run the following command?");
      show("  $ rm -rf build");
      show("› 1. Yes, proceed (y)");
      return show("  3. No, and tell Codex what to do differently (esc)");
    case "/warn":
      return show("⚠ Warning: Your account was flagged for potentially high-risk cyber activity");
    case "/error":
      event({ type: "task_started", turn_id: "t" });
      return event({
        type: "task_complete",
        turn_id: "t",
        last_agent_message: null,
        error: { message: `fake ${kind}`, codex_error_info: kind },
      });
    default:
      // A new prompt clears what was on the screen, as the real one's history scrolls on.
      process.stdout.write("\x1b[2J\x1b[H");
      show(`you: ${line}`);
      event({ type: "task_started", turn_id: "t" });
      record({ type: "turn_context", payload: { cwd, model: "gpt-fake-1" } });
      event({ type: "agent_message", message: `done (you said: ${line})` });
      return event({ type: "task_complete", turn_id: "t", last_agent_message: `done (you said: ${line})` });
  }
}

let lastCtrlC = 0;
let typed = "";
let pasting = false;
function ctrlC(): void {
  const now = Date.now();
  if (now - lastCtrlC > 1500) {
    lastCtrlC = now;
    return;
  }
  process.stdin.setRawMode(false);
  process.stdout.write("\x1b[?2004l\x1b[?1049l");
  if (registry) rmSync(registry, { force: true });
  process.exit(0);
}

process.stdin.on("data", (data: Buffer) => {
  let text = data.toString("utf8");
  while (text.length > 0) {
    if (text.startsWith("\x03")) {
      text = text.slice(1);
      ctrlC();
      continue;
    }
    if (text.startsWith("\x1b[200~")) {
      pasting = true;
      text = text.slice(6);
    } else if (text.startsWith("\x1b[201~")) {
      pasting = false;
      text = text.slice(6);
    } else {
      const char = text[0]!;
      text = text.slice(1);
      if (char === "\r" && !pasting) {
        if (typed) act(typed);
        typed = "";
      } else {
        typed += char === "\r" ? "\n" : char;
      }
    }
  }
});
