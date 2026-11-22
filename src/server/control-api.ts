// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

// The HTTP interface the command line uses for what only the server knows: tabs, banners, and
// what each terminal's agent is doing. It takes the login token as a bearer token: the CLI runs
// as the same user and reads it from the token file, and a web page cannot send the header
// without a CORS preflight, which the server never answers.

import type { SessionView, TabView } from "../common/protocol.ts";
import { safeEqual } from "./auth.ts";

export interface CreateRequest {
  /** A tab's name (or id); a name no tab has makes a new tab. */
  tab?: string;
  banner?: string;
  cwd?: string;
  /** Typed into the new terminal's shell. */
  cmd?: string;
  cols: number;
  rows: number;
}

export interface Control {
  sessions(): SessionView[];
  tabs(): TabView[];
  create(request: CreateRequest): Promise<SessionView>;
  /** Changes a terminal's banner or tab; null if there is no such terminal. */
  update(id: string, patch: { banner?: string; tab?: string }): SessionView | null;
}

const DEFAULT_SIZE = { cols: 120, rows: 36 };

export function controlRoutes(control: Control, token: () => string | null, hostAllowed: (request: Request) => boolean) {
  const authorized = (request: Request): Response | null => {
    if (!hostAllowed(request)) return new Response("forbidden", { status: 403 });
    const expected = token();
    const given = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!expected || !given || !safeEqual(given, expected)) return new Response("unauthorized", { status: 401 });
    return null;
  };
  const body = async (request: Request) => {
    const value = (await request.json().catch(() => null)) as unknown;
    return (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  };
  const string = (value: unknown) => (typeof value === "string" ? value : undefined);
  const failed = (error: unknown) => new Response((error as Error).message, { status: 400 });

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
            cols: typeof input.cols === "number" ? input.cols : DEFAULT_SIZE.cols,
            rows: typeof input.rows === "number" ? input.rows : DEFAULT_SIZE.rows,
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
        const session = control.update(request.params.id, { banner: string(input.banner), tab: string(input.tab) });
        return session ? Response.json({ session }) : new Response(`no such session: ${request.params.id}`, { status: 404 });
      },
    },
  };
}
