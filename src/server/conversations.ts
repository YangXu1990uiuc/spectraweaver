// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

// Where Claude Code and Codex keep their conversations. These are the agents' own files, not
// documented interfaces, so only their steadiest parts are relied on: a conversation's id from
// its file name, its directory from a `cwd` field, and when it was last written from the file's
// time. Titles and prompts only label the list; when they can't be read, it shows the directory.

import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentName } from "./agents.ts";

export interface AgentDirs {
  /** Claude Code's configuration directory ($CLAUDE_CONFIG_DIR, or ~/.claude). */
  claude: string;
  /** Codex's ($CODEX_HOME, or ~/.codex). */
  codex: string;
}

export function agentDirs(env: Record<string, string | undefined> = process.env): AgentDirs {
  return {
    claude: env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
    codex: env.CODEX_HOME || join(homedir(), ".codex"),
  };
}

export interface ConversationFile {
  agent: AgentName;
  id: string;
  path: string;
  mtimeMs: number;
}

export interface ConversationInfo extends ConversationFile {
  cwd: string;
  label: string;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// Claude Code: projects/<directory, escaped>/<id>.jsonl; its subagents' files are in subdirectories.
const CLAUDE_FILE = new RegExp(`^(${UUID})\\.jsonl$`, "i");
// Codex: sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl
const CODEX_FILE = new RegExp(`^rollout-.*-(${UUID})\\.jsonl$`, "i");
export const CODEX_ROLLOUT_PATH = new RegExp(`/sessions/(?:.*/)?rollout-.*-(${UUID})\\.jsonl$`, "i");

const HEAD_CHUNK = 64 * 1024;
const HEAD_MAX = 2 * 1024 * 1024;
const TAIL_BYTES = 256 * 1024;
const LABEL_MAX = 160;
const LIST_TTL_MS = 10_000;
/** How long a conversation not found is taken as absent. */
const MISS_TTL_MS = 10_000;

interface Head {
  cwd: string;
  /** Started by a person, not by a script (`claude -p`, `codex exec`). */
  interactive: boolean;
}

/** Reads the agents' conversation files, caching what does not change. */
export class Conversations {
  private heads = new Map<string, Head | null>();
  private labels = new Map<string, { mtimeMs: number; label: string }>();
  private listed: { at: number; files: ConversationFile[] } | null = null;
  /** Where each conversation found so far lives, so polling it does not list every file again. */
  private paths = new Map<string, ConversationFile>();
  /** Conversations looked for and not found, and when: not looked for again for a while. */
  private misses = new Map<string, number>();

  constructor(private readonly dirs: AgentDirs) {}

  /** Every conversation file, newest first; listed again at most every few seconds. */
  files(): ConversationFile[] {
    if (this.listed && Date.now() - this.listed.at < LIST_TTL_MS) return this.listed.files;
    const files: ConversationFile[] = [];
    const add = (agent: AgentName, path: string, id: string) => {
      try {
        files.push({ agent, id: id.toLowerCase(), path, mtimeMs: statSync(path).mtimeMs });
      } catch {
        // removed while listing
      }
    };
    const projects = join(this.dirs.claude, "projects");
    for (const project of names(projects)) {
      for (const name of names(join(projects, project))) {
        const match = CLAUDE_FILE.exec(name);
        if (match) add("claude", join(projects, project, name), match[1]!);
      }
    }
    const sessions = join(this.dirs.codex, "sessions");
    for (const year of names(sessions)) {
      for (const month of names(join(sessions, year))) {
        for (const day of names(join(sessions, year, month))) {
          const dir = join(sessions, year, month, day);
          for (const name of names(dir)) {
            const match = CODEX_FILE.exec(name);
            if (match) add("codex", join(dir, name), match[1]!);
          }
        }
      }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    this.listed = { at: Date.now(), files };
    // What is known of files that are gone goes with them.
    const present = new Set(files.map((file) => file.path));
    for (const cache of [this.heads, this.labels]) for (const path of cache.keys()) if (!present.has(path)) cache.delete(path);
    return files;
  }

  /** Forgets the file list, so the next call reads the directories again. */
  refresh(): void {
    this.listed = null;
    this.misses.clear();
  }

  /** Conversations written to since `since` that a person started, newest first. */
  recent(since: number, limit: number): ConversationInfo[] {
    const found: ConversationInfo[] = [];
    for (const file of this.files()) {
      if (file.mtimeMs < since || found.length >= limit) break;
      const head = this.head(file);
      if (!head?.interactive) continue;
      found.push({ ...file, cwd: head.cwd, label: this.label(file) });
    }
    return found;
  }

  /**
   * A conversation's file. One found before is just looked at again; one not in the list is
   * looked for again if the list is more than a second old, and one not found at all is not
   * looked for again for MISS_TTL_MS (an agent keeping its files elsewhere would otherwise have
   * every file listed on every poll).
   */
  find(agent: AgentName, id: string): ConversationFile | undefined {
    const lower = id.toLowerCase();
    const key = `${agent}:${lower}`;
    const known = this.paths.get(key);
    if (known) {
      try {
        const updated = { ...known, mtimeMs: statSync(known.path).mtimeMs };
        this.paths.set(key, updated);
        return updated;
      } catch {
        this.paths.delete(key); // moved or removed: look for it again
      }
    }
    const missed = this.misses.get(key);
    if (missed !== undefined && Date.now() - missed < MISS_TTL_MS) return undefined;
    const lookup = () => this.files().find((file) => file.agent === agent && file.id === lower);
    let found = lookup();
    if (!found && this.listed && Date.now() - this.listed.at >= 1000) {
      this.refresh();
      found = lookup();
    }
    if (found) {
      this.paths.set(key, found);
      this.misses.delete(key);
    } else {
      this.misses.set(key, Date.now());
    }
    return found;
  }

  /** The directory a conversation was started in; null if its file does not say. */
  cwdOf(file: ConversationFile): string | null {
    return this.head(file)?.cwd ?? null;
  }

  /**
   * What the conversation is about: the agent's title for it, or else the last prompt. Empty
   * if the end of the file holds neither (the format changed, say).
   */
  label(file: ConversationFile): string {
    const cached = this.labels.get(file.path);
    if (cached?.mtimeMs === file.mtimeMs) return cached.label;
    let label = "";
    try {
      label = (file.agent === "claude" ? claudeLabel : codexLabel)(tailLines(file.path));
    } catch {
      label = "";
    }
    label = label.replace(/\s+/g, " ").trim();
    if (label.length > LABEL_MAX) label = `${label.slice(0, LABEL_MAX - 1)}…`;
    this.labels.set(file.path, { mtimeMs: file.mtimeMs, label });
    return label;
  }

  private head(file: ConversationFile): Head | null {
    if (this.heads.has(file.path)) return this.heads.get(file.path)!;
    let head: Head | null = null;
    try {
      head = file.agent === "claude" ? claudeHead(file.path) : codexHead(file.path);
    } catch {
      head = null;
    }
    // A file too new to say yet is read again next time.
    if (head) this.heads.set(file.path, head);
    return head;
  }
}

export type Line = Record<string, unknown>;

// Interactive sessions say where they came from: "cli", "claude-vscode", ...; Claude Code
// marks print mode and SDK runs "sdk-…".
function claudeHead(path: string): Head | null {
  let head: Head | null = null;
  scanHead(path, (line) => {
    if (typeof line.cwd !== "string") return false;
    const entrypoint = typeof line.entrypoint === "string" ? line.entrypoint : "";
    head = { cwd: line.cwd, interactive: !entrypoint.startsWith("sdk") };
    return true;
  });
  return head;
}

// The first line is the session's metadata; `codex exec` runs say source "exec".
function codexHead(path: string): Head | null {
  let head: Head | null = null;
  scanHead(path, (line) => {
    const payload = line.payload as Line | undefined;
    if (typeof payload?.cwd !== "string") return false;
    head = { cwd: payload.cwd, interactive: payload.source !== "exec" };
    return true;
  });
  return head;
}

function claudeLabel(lines: Line[]): string {
  let custom = "";
  let title = "";
  let prompt = "";
  let typed = "";
  for (const line of lines) {
    if (typeof line.customTitle === "string") custom = line.customTitle;
    if (typeof line.aiTitle === "string") title = line.aiTitle;
    if (line.type === "summary" && typeof line.summary === "string") title = line.summary;
    if (typeof line.lastPrompt === "string") prompt = line.lastPrompt;
    if (line.type === "user" && line.isMeta !== true) {
      const content = (line.message as Line | undefined)?.content;
      if (typeof content === "string" && !content.startsWith("<")) typed = content;
    }
  }
  return custom || title || prompt || typed;
}

function codexLabel(lines: Line[]): string {
  let name = "";
  let prompt = "";
  for (const line of lines) {
    const payload = line.payload as Line | undefined;
    if (typeof payload?.thread_name === "string") name = payload.thread_name;
    if (payload?.type === "user_message" && typeof payload.message === "string" && !payload.message.startsWith("<")) {
      prompt = payload.message;
    }
  }
  return name || prompt;
}

function names(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Calls `found` with each line from the start of a JSON-lines file until it returns true. */
function scanHead(path: string, found: (line: Line) => boolean): void {
  const fd = openSync(path, "r");
  try {
    let pending = "";
    const buffer = Buffer.alloc(HEAD_CHUNK);
    for (let read = 0; read < HEAD_MAX; ) {
      const bytes = readSync(fd, buffer, 0, HEAD_CHUNK, read);
      if (bytes === 0) break;
      read += bytes;
      pending += buffer.toString("utf8", 0, bytes);
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const text of lines) {
        const line = parse(text);
        if (line && found(line)) return;
      }
    }
  } finally {
    closeSync(fd);
  }
}

/** The complete lines in the last `limit` bytes of a JSON-lines file, parsed. */
export function tailLines(path: string, limit = TAIL_BYTES): Line[] {
  const size = statSync(path).size;
  let text: string;
  if (size <= limit) {
    text = readFileSync(path, "utf8");
  } else {
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(limit);
      const bytes = readSync(fd, buffer, 0, limit, size - limit);
      text = buffer.toString("utf8", 0, bytes);
      text = text.slice(text.indexOf("\n") + 1); // the first line is cut off
    } finally {
      closeSync(fd);
    }
  }
  return text.split("\n").flatMap((line): Line[] => {
    const parsed = parse(line);
    return parsed ? [parsed] : [];
  });
}

function parse(text: string): Line | null {
  if (!text.startsWith("{")) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null ? (value as Line) : null;
  } catch {
    return null;
  }
}
