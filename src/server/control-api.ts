// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

// The HTTP interface the command line uses for what only the server knows: tabs, banners, and
// what each terminal's agent is doing. It takes the login token as a bearer token: the CLI runs
// as the same user and reads it from the token file, and a web page cannot send the header
// without a CORS preflight, which the server never answers.

import { NEW_TERMINAL_SIZE, type SessionView, type TabView } from "../common/protocol.ts";
import { safeEqual } from "./auth.ts";
import { BoardError } from "./board.ts";

export interface CreateRequest {
  /** A tab's name (or id); a name no tab has makes a new tab. */
  tab?: string;
  banner?: string;
  cwd?: string;
  /** Typed into the new terminal's shell. */
  cmd?: string;
  cols: number;
  rows: number;
  /** Show its window even in a tab with a board, where new terminals start put away. */
  show?: boolean;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface BoardResult {
  /** The tab, with its board. */
  tab: TabView;
  /** Things worth fixing that did not stop the board, such as a task naming a terminal that does not exist. */
  warnings: string[];
}

export interface Control {
  sessions(): SessionView[];
  tabs(): TabView[];
  create(request: CreateRequest): Promise<SessionView>;
  /**
   * Changes a terminal's banner or tab, or puts its window away (only in a tab with a board, which
   * brings it back; an Error says so otherwise); null if there is no such terminal.
   */
  update(id: string, patch: { banner?: string; tab?: string; hidden?: boolean }): SessionView | null;
  /** A tab, with its board if it has one; null if no tab has that name or id. */
  board(tab: string): TabView | null;
  /** Sets a tab's board (a name no tab has makes a tab); throws BoardError if the board is not valid. */
  setBoard(tab: string, board: unknown, lead?: string): BoardResult;
  /** Removes a tab's board; null if no tab has that name or id. */
  clearBoard(tab: string): TabView | null;
  /**
   * Changes one task of a tab's board (null or "" removes a field), or adds it when the board has
   * no task with that id; throws BoardError if there is no board or the result is not valid.
   */
  updateTask(tab: string, id: string, patch: Record<string, unknown>): BoardResult;
  /**
   * The latest reply of the agent in a terminal, running or the last one it ran; null if there
   * is no such terminal, an Error saying why if there is no reply.
   */
  reply(id: string): AgentReply | null;
}

export interface AgentReply {
  agent: string;
  text: string;
  /** When it was written, in ms since the epoch, if the agent recorded it. */
  at?: number;
}


export function controlRoutes(control: Control, token: () => string | null, hostAllowed: (request: Request) => boolean) {
  const authorized = (request: Request): Response | null => {
    if (!hostAllowed(request)) return new Response("forbidden", { status: 403 });
    const expected = token();
    const given = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!expected || !given || !safeEqual(given, expected)) return new Response("unauthorized", { status: 401 });
    return null;
  };
  // A board of 500 tasks is about 1.3 MB; the server takes larger bodies only as uploads.
  const body = async (request: Request) => {
    if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return {} as Record<string, unknown>;
    const value = (await request.json().catch(() => null)) as unknown;
    return (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  };
  const string = (value: unknown) => (typeof value === "string" ? value : undefined);
  const failed = (error: unknown) => new Response((error as Error).message, { status: 400 });
  const tabParam = (request: Request) => new URL(request.url).searchParams.get("tab")?.trim() ?? "";
  const noTab = (name: string) => new Response(`no tab named “${name}”`, { status: 404 });

  return {
    "/api/v1/sessions": {
      GET: (request: Request) => authorized(request) ?? Response.json({ sessions: control.sessions(), tabs: control.tabs() }),
      POST: async (request: Request) => {
        const refused = authorized(request);
        if (refused) return refused;
        const input = await body(request);
        try {
          const session = await control.create({
            tab: string(input.tab),
            banner: string(input.banner),
            cwd: string(input.cwd),
            cmd: string(input.cmd),
            cols: typeof input.cols === "number" ? input.cols : NEW_TERMINAL_SIZE.cols,
            rows: typeof input.rows === "number" ? input.rows : NEW_TERMINAL_SIZE.rows,
            show: input.show === true,
          });
          return Response.json({ session });
        } catch (error) {
          return failed(error);
        }
      },
    },
    "/api/v1/sessions/:id": {
      POST: async (request: Request & { params: { id: string } }) => {
        const refused = authorized(request);
        if (refused) return refused;
        const input = await body(request);
        try {
          const session = control.update(request.params.id, {
            banner: string(input.banner),
            tab: string(input.tab),
            hidden: typeof input.hidden === "boolean" ? input.hidden : undefined,
          });
          return session ? Response.json({ session }) : new Response(`no such session: ${request.params.id}`, { status: 404 });
        } catch (error) {
          return failed(error);
        }
      },
    },
    "/api/v1/sessions/:id/reply": {
      GET: (request: Request & { params: { id: string } }) => {
        const refused = authorized(request);
        if (refused) return refused;
        try {
          const reply = control.reply(request.params.id);
          return reply ? Response.json(reply) : new Response(`no such terminal: ${request.params.id}`, { status: 404 });
        } catch (error) {
          return new Response((error as Error).message, { status: 404 });
        }
      },
    },
    // The tab goes in the query (?tab=NAME), as names may hold any character.
    "/api/v1/board": {
      GET: (request: Request) => {
        const refused = authorized(request);
        if (refused) return refused;
        const name = tabParam(request);
        const tab = name ? control.board(name) : null;
        return tab ? Response.json({ tab }) : noTab(name);
      },
      PUT: async (request: Request) => {
        const refused = authorized(request);
        if (refused) return refused;
        const name = tabParam(request);
        if (!name) return new Response("say which tab the board is for", { status: 400 });
        const input = await body(request);
        try {
          return Response.json(control.setBoard(name, input.board, string(input.lead)));
        } catch (error) {
          if (error instanceof BoardError) return new Response(`the board was not set: ${error.message}`, { status: 400 });
          throw error;
        }
      },
      DELETE: (request: Request) => {
        const refused = authorized(request);
        if (refused) return refused;
        const name = tabParam(request);
        const tab = name ? control.clearBoard(name) : null;
        return tab ? Response.json({ tab }) : noTab(name);
      },
    },
    // One task: ?tab=NAME&id=T3, the fields to change in the body's "patch".
    "/api/v1/board/task": {
      PATCH: async (request: Request) => {
        const refused = authorized(request);
        if (refused) return refused;
        const name = tabParam(request);
        const id = new URL(request.url).searchParams.get("id")?.trim() ?? "";
        if (!name || !id) return new Response("say which tab and which task", { status: 400 });
        const input = await body(request);
        const patch = typeof input.patch === "object" && input.patch !== null && !Array.isArray(input.patch) ? input.patch : {};
        try {
          return Response.json(control.updateTask(name, id, patch as Record<string, unknown>));
        } catch (error) {
          if (error instanceof BoardError) return new Response(`the task was not changed: ${error.message}`, { status: 400 });
          throw error;
        }
      },
    },
  };
}
