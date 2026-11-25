// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

// The task board a coordinating agent pushes with `spectraweaver board set` (DESIGN.md §8.7).
// An agent reads the errors, so each one names the task and says what to write instead.

import { type Board, type BoardTask, TASK_STATUSES, type TaskStatus } from "../common/protocol.ts";

const BOARD_LIMITS = {
  tasks: 500,
  id: 40,
  title: 200,
  note: 1000,
  link: 1000,
  session: 64,
  boardTitle: 120,
} as const;

export class BoardError extends Error {}

/**
 * A board from what an agent sent: `{"title": …, "tasks": [...]}`, or just the list of tasks.
 * Text that is too long is cut; anything else wrong is a BoardError saying how to fix it.
 * Fields the board does not know are ignored, so an agent may keep its own in the same file.
 */
export function parseBoard(input: unknown, now: number, lead?: string): Board {
  const object = Array.isArray(input) ? { tasks: input } : input;
  if (typeof object !== "object" || object === null) {
    throw new BoardError('a board is a JSON object like {"title": "…", "tasks": [...]}, or the list of tasks itself');
  }
  const { title, tasks } = object as Record<string, unknown>;
  if (!Array.isArray(tasks)) throw new BoardError('the board has no "tasks" list');
  if (tasks.length > BOARD_LIMITS.tasks) {
    throw new BoardError(`a board holds at most ${BOARD_LIMITS.tasks} tasks, not ${tasks.length}`);
  }
  const ids = new Set<string>();
  const parsed = tasks.map((raw, index) => parseTask(raw, index, ids));
  for (const task of parsed) {
    for (const dependency of task.after ?? []) {
      if (!ids.has(dependency)) {
        throw new BoardError(`task "${task.id}": "after" names "${dependency}", which is not a task on the board`);
      }
    }
  }
  const cycle = findCycle(parsed);
  if (cycle) throw new BoardError(`these tasks wait for each other in a circle: ${cycle.join(" → ")}`);
  const board: Board = { tasks: parsed, updatedAt: now };
  const name = text(title, BOARD_LIMITS.boardTitle);
  if (name) board.title = name;
  if (lead) board.lead = lead;
  return board;
}

function parseTask(raw: unknown, index: number, ids: Set<string>): BoardTask {
  const where = `task ${index + 1}`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BoardError(`${where}: each task is an object like {"id": "T1", "title": "…", "status": "todo"}`);
  }
  const fields = raw as Record<string, unknown>;
  const id = identifier(fields.id);
  if (!id) throw new BoardError(`${where}: every task needs an "id" (a short name such as "T1")`);
  if (id.length > BOARD_LIMITS.id) throw new BoardError(`task "${id}": an id has at most ${BOARD_LIMITS.id} characters`);
  if (ids.has(id)) throw new BoardError(`task "${id}" appears twice; ids must differ`);
  ids.add(id);
  const status = typeof fields.status === "string" ? fields.status.trim().toLowerCase() : fields.status;
  if (!TASK_STATUSES.includes(status as TaskStatus)) {
    throw new BoardError(
      `task "${id}": "status" must be one of ${TASK_STATUSES.join(", ")}, not ${JSON.stringify(status ?? null)}` +
        ' (say more in "note", for example "waiting for review")',
    );
  }
  const task: BoardTask = { id, title: text(fields.title, BOARD_LIMITS.title) || id, status: status as TaskStatus };

  const after = fields.after === undefined || fields.after === null ? [] : [fields.after].flat();
  const dependencies: string[] = [];
  for (const value of after) {
    const dependency = identifier(value);
    if (!dependency) throw new BoardError(`task "${id}": "after" is a list of task ids`);
    if (dependency === id) throw new BoardError(`task "${id}": a task cannot wait for itself`);
    if (!dependencies.includes(dependency)) dependencies.push(dependency);
  }
  if (dependencies.length > 0) task.after = dependencies;

  if (fields.session !== undefined && fields.session !== null && fields.session !== "") {
    if (typeof fields.session !== "string" || fields.session.trim().length > BOARD_LIMITS.session) {
      throw new BoardError(`task "${id}": "session" is a terminal's id, as \`spectraweaver new\` prints it`);
    }
    task.session = fields.session.trim();
  }
  const note = text(fields.note, BOARD_LIMITS.note);
  if (note) task.note = note;
  if (fields.link !== undefined && fields.link !== null && fields.link !== "") {
    task.link = link(fields.link, id);
  }
  return task;
}

/** A task id: a string, or a number written as one. */
function identifier(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" ? value.trim() : "";
}

/** Text on one line, cut to `limit` characters. */
function text(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** Only http(s) links: the browser opens them, so nothing that runs script. */
function link(value: unknown, id: string): string {
  const refuse = () => new BoardError(`task "${id}": "link" must be an http or https URL`);
  if (typeof value !== "string" || value.length > BOARD_LIMITS.link) throw refuse();
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw refuse();
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw refuse();
  return url.href;
}

/** What a task says, without when and by whom it was changed: two tasks saying the same are one unchanged. */
function said(task: BoardTask): string {
  return JSON.stringify([task.title, task.status, task.after ?? [], task.session ?? "", task.note ?? "", task.link ?? ""]);
}

/** Whether two versions of a task say the same, whenever and by whomever they were stamped. */
export function sameTask(a: BoardTask, b: BoardTask): boolean {
  return said(a) === said(b);
}

/**
 * Stamps a board's tasks with when they changed and from which terminal: a task that says what
 * it said in `previous` keeps its stamp, any other is stamped `now` and `by`.
 */
export function stampTasks(board: Board, previous: Board | undefined, now: number, by: string | undefined): void {
  const before = new Map((previous?.tasks ?? []).map((task) => [task.id, task]));
  for (const task of board.tasks) {
    const old = before.get(task.id);
    if (old && said(old) === said(task)) {
      if (old.updatedAt !== undefined) task.updatedAt = old.updatedAt;
      if (old.updatedBy !== undefined) task.updatedBy = old.updatedBy;
    } else {
      task.updatedAt = now;
      if (by) task.updatedBy = by;
      else delete task.updatedBy;
    }
  }
}

/** A circle of tasks each waiting for the next, if there is one: the ids, the first repeated at the end. */
function findCycle(tasks: readonly BoardTask[]): string[] | null {
  const after = new Map(tasks.map((task) => [task.id, task.after ?? []]));
  const state = new Map<string, "open" | "done">();
  const path: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === "done") return null;
    if (state.get(id) === "open") return [...path.slice(path.indexOf(id)), id];
    state.set(id, "open");
    path.push(id);
    for (const next of after.get(id) ?? []) {
      const found = visit(next);
      if (found) return found;
    }
    path.pop();
    state.set(id, "done");
    return null;
  };
  for (const task of tasks) {
    const found = visit(task.id);
    if (found) return found;
  }
  return null;
}
