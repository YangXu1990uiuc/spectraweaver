// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

// What a tab's board says of a terminal (DESIGN.md §8.7): the tasks that name it, and so what it
// is called. A terminal a task names is called by that task on its window and in `ls`, from the
// board, so it cannot drift from the board as a hand-written banner did.

import type { Board, BoardTask } from "./protocol.ts";

/** The tasks of a board that name a terminal, in the board's order. */
export function tasksOf(board: Board | undefined, sessionId: string): BoardTask[] {
  return board ? board.tasks.filter((task) => task.session === sessionId) : [];
}

export interface BoardName {
  text: string;
  /** The task a click on the name selects; none for the lead. */
  task?: string;
}

/**
 * What a terminal on a board is called: "lead · <board title>" for the terminal that keeps it;
 * for one tasks name, the id and title of those not done ("T13 Gate 1 run · T15 Dataset"), or,
 * all done, the one changed last, ticked ("✓ T09 Kernel suite"). Undefined for a terminal the
 * board does not name, which keeps its banner.
 */
export function boardName(board: Board | undefined, sessionId: string, tabName: string): BoardName | undefined {
  if (!board) return undefined;
  if (board.lead === sessionId) return { text: `lead · ${board.title || `${tabName} board`}` };
  const tasks = tasksOf(board, sessionId);
  if (tasks.length === 0) return undefined;
  const open = tasks.filter((task) => task.status !== "done");
  if (open.length > 0) return { text: open.map((task) => `${task.id} ${task.title}`).join(" · "), task: open[0]!.id };
  // Changed last; without stamps (a board from before them), the last on the board.
  const last = tasks.reduce((latest, task) => ((task.updatedAt ?? 0) >= (latest.updatedAt ?? 0) ? task : latest));
  return { text: `✓ ${last.id} ${last.title}`, task: last.id };
}

/** The tasks in progress of a terminal whose agent has stopped working: nothing will go on with them. */
export function stalledTasks(board: Board | undefined, sessionId: string): BoardTask[] {
  return tasksOf(board, sessionId).filter((task) => task.status === "wip");
}
