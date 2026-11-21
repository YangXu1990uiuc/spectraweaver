// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

// What SpectraWeaver knows about each coding agent CLI, kept in one place: how to recognise
// it, how to resume one of its conversations, and which of its flags to keep when resuming.

import { basename } from "node:path";

/** How many values a flag takes: none, one, or all that follow until the next flag. */
type Arity = 0 | 1 | "many";

export type AgentName = "claude" | "codex";

export interface Agent {
  name: AgentName;
  /** Whether this is the agent's program (argv[0], or the script a runtime runs). */
  matches(program: string): boolean;
  /**
   * The documented command that resumes a conversation, or the most recent one in the current
   * directory when the id is unknown. Flags go last.
   */
  resume(conversation: string | null): string;
  /** A conversation id given on the agent's command line, as in `claude --resume ID`. */
  conversationInArgs(args: string[]): string | null;
  /**
   * Flags carried over to the resumed session. Anything else is dropped: resume options,
   * an initial prompt (which would be sent again), and flags whose values we can't parse.
   */
  carry: Record<string, Arity>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const AGENTS: Agent[] = [
  {
    name: "claude",
    matches: (program) => basename(program) === "claude" || program.includes("@anthropic-ai/claude-code/"),
    resume: (conversation) => (conversation ? `claude --resume ${conversation}` : "claude --continue"),
    conversationInArgs: (args) => {
      for (let i = 0; i < args.length; i++) {
        const [flag, inline] = args[i]!.split("=", 2);
        if (!["--resume", "-r", "--session-id"].includes(flag!)) continue;
        const value = inline ?? args[i + 1] ?? "";
        if (UUID.test(value) && !args.includes("--fork-session")) return value;
      }
      return null;
    },
    carry: {
      "--dangerously-skip-permissions": 0,
      "--allow-dangerously-skip-permissions": 0,
      "--permission-mode": 1,
      "--model": 1,
      "--fallback-model": 1,
      "--agent": 1,
      "--settings": 1,
      "--add-dir": "many",
      "--mcp-config": "many",
      "--strict-mcp-config": 0,
      "--append-system-prompt": 1,
      "--system-prompt": 1,
    },
  },
  {
    name: "codex",
    matches: (program) => ["codex", "codex.js"].includes(basename(program)) || program.includes("@openai/codex/"),
    resume: (conversation) => (conversation ? `codex resume ${conversation}` : "codex resume --last"),
    conversationInArgs: (args) => {
      const at = args.indexOf("resume");
      return at < 0 ? null : (args.slice(at + 1).find((arg) => UUID.test(arg)) ?? null);
    },
    carry: {
      "--dangerously-bypass-approvals-and-sandbox": 0,
      "--yolo": 0,
      "--full-auto": 0,
      "--search": 0,
      "--oss": 0,
      "-a": 1,
      "--ask-for-approval": 1,
      "-s": 1,
      "--sandbox": 1,
      "-m": 1,
      "--model": 1,
      "-p": 1,
      "--profile": 1,
      "-c": 1,
      "--config": 1,
      "-C": 1,
      "--cd": 1,
      "--add-dir": 1,
    },
  },
];

export function agentNamed(name: string): Agent | undefined {
  return AGENTS.find((agent) => agent.name === name);
}

export function isConversationId(value: string): boolean {
  return UUID.test(value);
}

const RUNTIMES = new Set(["node", "nodejs", "bun", "deno"]);

/** Where the program is in a command line: after the runtime, for scripts like npm installs. */
export function programIndex(argv: string[]): number {
  return argv.length > 1 && RUNTIMES.has(basename(argv[0] ?? "")) ? 1 : 0;
}

export function detectAgent(argv: string[]): Agent | null {
  const program = argv[programIndex(argv)];
  return program === undefined ? null : (AGENTS.find((agent) => agent.matches(program)) ?? null);
}

/** The flags (with their values) worth keeping, from the arguments after the program. */
export function carriedFlags(agent: Agent, args: string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const arity = agent.carry[eq > 0 ? arg.slice(0, eq) : arg];
    if (arity === undefined) continue;
    kept.push(arg);
    if (eq > 0) continue; // --flag=value
    if (arity === 1 && i + 1 < args.length) kept.push(args[++i]!);
    if (arity === "many") while (i + 1 < args.length && !args[i + 1]!.startsWith("-")) kept.push(args[++i]!);
  }
  return kept;
}

export function shellQuote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The command that resumes a conversation with the given flags, quoted for the shell. */
export function resumeCommand(agent: Agent, conversation: string | null, flags: string[]): string {
  return [agent.resume(conversation), ...flags.map(shellQuote)].join(" ");
}
