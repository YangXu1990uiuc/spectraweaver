// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { describe, expect, test } from "bun:test";
import type { AgentStatus, BoardTask, SessionView } from "../src/common/protocol.ts";
import { BoardError, parseBoard } from "../src/server/board.ts";
import {
  type BoardLayout,
  closestInOrder,
  type Direction,
  type LayoutTask,
  layoutBoard,
  pickLayout,
} from "../src/web/board-layout.ts";
import { agentLive, clockTime, shortAge, taskLive } from "../src/web/board-live.ts";
import { ago } from "../src/web/dom.ts";

const NOW = 1_800_000_000_000;

describe("a pushed board", () => {
  test("is a list of tasks, with or without a title around it", () => {
    const tasks = [
      { id: "T1", title: "Map the flow", status: "done" },
      { id: 2, title: "  Refresh\n API ", status: "WIP", after: "T1", session: " 3f2a9c1d ", mine: "kept out" },
    ];
    const board = parseBoard({ title: "Login", tasks }, NOW, "aaaaaaaa");
    expect(board).toEqual({
      title: "Login",
      updatedAt: NOW,
      lead: "aaaaaaaa",
      tasks: [
        { id: "T1", title: "Map the flow", status: "done" },
        { id: "2", title: "Refresh API", status: "wip", after: ["T1"], session: "3f2a9c1d" },
      ],
    });
    expect(parseBoard(tasks, NOW).tasks).toHaveLength(2);
    // A task without a title is called by its id.
    expect(parseBoard([{ id: "T9", status: "todo" }], NOW).tasks[0]!.title).toBe("T9");
  });

  test("mistakes say which task and what to write instead", () => {
    const refused = (input: unknown) => {
      try {
        parseBoard(input, NOW);
      } catch (error) {
        expect(error).toBeInstanceOf(BoardError);
        return (error as Error).message;
      }
      throw new Error("accepted");
    };
    expect(refused({ title: "x" })).toContain('no "tasks" list');
    expect(refused([{ title: "no id", status: "todo" }])).toContain('task 1: every task needs an "id"');
    expect(refused([{ id: "T9", status: "review" }])).toBe(
      'task "T9": "status" must be one of todo, wip, done, blocked, not "review" (say more in "note", for example "waiting for review")',
    );
    expect(refused([{ id: "A", status: "todo" }, { id: "A", status: "done" }])).toContain('task "A" appears twice');
    expect(refused([{ id: "A", status: "todo", after: ["Z"] }])).toContain('"after" names "Z", which is not a task');
    expect(refused([{ id: "A", status: "todo", after: ["A"] }])).toContain("cannot wait for itself");
    expect(
      refused([
        { id: "A", status: "todo", after: ["C"] },
        { id: "B", status: "todo", after: ["A"] },
        { id: "C", status: "todo", after: ["B"] },
      ]),
    ).toBe("these tasks wait for each other in a circle: A → C → B → A");
    expect(refused([{ id: "A", status: "todo", link: "javascript:alert(1)" }])).toContain("http or https URL");
    expect(refused([{ id: "A", status: "todo", link: "not a url" }])).toContain("http or https URL");
  });

  test("long text is cut rather than refused, and links are kept as URLs", () => {
    const board = parseBoard([{ id: "A", status: "todo", note: "x".repeat(5000), link: "https://example.com/pr/1" }], NOW);
    expect(board.tasks[0]!.note).toHaveLength(1000);
    expect(board.tasks[0]!.note!.endsWith("…")).toBe(true);
    expect(board.tasks[0]!.link).toBe("https://example.com/pr/1");
  });
});

const CARD = { width: 192, height: 60 };

/** The login refactor of the design mock-ups: eleven tasks, arrows that skip layers. */
const SAMPLE: LayoutTask[] = [
  { id: "T1" },
  { id: "T2", after: ["T1"] },
  { id: "T9", after: ["T1"] },
  { id: "T6", after: ["T2"] },
  { id: "T3", after: ["T2"] },
  { id: "T4", after: ["T2"] },
  { id: "T11", after: ["T2"] },
  { id: "T5", after: ["T3"] },
  { id: "T7", after: ["T3", "T4"] },
  { id: "T8", after: ["T5", "T7"] },
  { id: "T10", after: ["T6", "T8", "T11"] },
];

/** A larger board with many layer-skipping arrows, the same every run. */
function randomBoard(count: number, seed: number): LayoutTask[] {
  let state = seed;
  const next = () => (state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  return Array.from({ length: count }, (_, i) => ({
    id: `T${i}`,
    after: Array.from({ length: Math.floor(next() * 3) }, () => `T${Math.floor(next() * i)}`).filter(() => i > 0),
  }));
}

function overlaps(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return a.x < b.x + CARD.width && b.x < a.x + CARD.width && a.y < b.y + CARD.height && b.y < a.y + CARD.height;
}

function checkLayout(layout: BoardLayout, tasks: LayoutTask[]): void {
  const cards = [...layout.cards.values()];
  expect(cards).toHaveLength(tasks.length);
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i]!;
    expect(card.x).toBeGreaterThanOrEqual(0);
    expect(card.y).toBeGreaterThanOrEqual(0);
    expect(card.x + CARD.width).toBeLessThanOrEqual(layout.width);
    expect(card.y + CARD.height).toBeLessThanOrEqual(layout.height);
    for (let j = i + 1; j < cards.length; j++) expect(overlaps(card, cards[j]!)).toBe(false);
  }
  for (const task of tasks) {
    for (const dependency of new Set(task.after ?? [])) {
      // Every dependency has its arrow, pointing the way the layers go.
      const edge = layout.edges.find((candidate) => candidate.from === dependency && candidate.to === task.id)!;
      expect(edge).toBeDefined();
      expect(layout.cards.get(dependency)!.layer).toBeLessThan(layout.cards.get(task.id)!.layer);
      // Between two of its points an arrow stays in their bounding box: a straight run through a
      // layer, or a bend in the room between layers. Neither may touch a card but its own two.
      for (let k = 1; k < edge.points.length; k++) {
        const a = edge.points[k - 1]!;
        const b = edge.points[k]!;
        const box = { left: Math.min(a.x, b.x), right: Math.max(a.x, b.x), top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y) };
        for (const card of cards) {
          if (card.id === dependency || card.id === task.id) continue;
          const inside =
            box.left < card.x + CARD.width && card.x < box.right && box.top < card.y + CARD.height && card.y < box.bottom;
          expect(inside).toBe(false);
        }
      }
    }
  }
}

describe("the board's layout", () => {
  test("puts each task past the tasks it waits for, in either direction", () => {
    for (const direction of ["down", "right"] as Direction[]) {
      const layout = layoutBoard(SAMPLE, CARD, direction);
      checkLayout(layout, SAMPLE);
      const layer = (id: string) => layout.cards.get(id)!.layer;
      expect([layer("T1"), layer("T2"), layer("T3"), layer("T5"), layer("T8"), layer("T10")]).toEqual([0, 1, 2, 3, 4, 5]);
      const along = direction === "down" ? "y" : "x";
      expect(layout.cards.get("T10")![along]).toBeGreaterThan(layout.cards.get("T8")![along]);
    }
  });

  test("keeps cards apart and arrows clear of cards on large boards", () => {
    for (const seed of [1, 7, 42]) {
      const tasks = randomBoard(60, seed);
      for (const direction of ["down", "right"] as Direction[]) checkLayout(layoutBoard(tasks, CARD, direction), tasks);
    }
  });

  test("is the same every time for the same board", () => {
    const tasks = randomBoard(40, 3);
    const one = layoutBoard(tasks, CARD, "down");
    const two = layoutBoard(tasks, CARD, "down");
    expect([...two.cards.values()]).toEqual([...one.cards.values()]);
    expect(two.edges.map((edge) => edge.path)).toEqual(one.edges.map((edge) => edge.path));
  });

  test("a chain lines up straight, and a lone task sits by itself", () => {
    const layout = layoutBoard([{ id: "a" }, { id: "b", after: ["a"] }, { id: "c", after: ["b"] }], CARD, "down");
    const xs = ["a", "b", "c"].map((id) => layout.cards.get(id)!.x);
    expect(new Set(xs).size).toBe(1);
    expect(layout.edges.map((edge) => edge.path)).toEqual([
      expect.stringMatching(/^M 120 84 C/),
      expect.stringMatching(/^M 120 200 C/),
    ]);
    const single = layoutBoard([{ id: "only" }], CARD, "down");
    expect(single.edges).toEqual([]);
    expect(single.width).toBe(CARD.width + 48);
  });

  test("survives what a checked board never has: circles, unknown ids, waiting for itself", () => {
    const layout = layoutBoard(
      [
        { id: "a", after: ["c", "ghost", "a"] },
        { id: "b", after: ["a"] },
        { id: "c", after: ["b"] },
      ],
      CARD,
      "down",
    );
    expect(layout.cards.size).toBe(3);
  });

  test("lays a wide, shallow board out left to right when that fits better", () => {
    const wide: LayoutTask[] = Array.from({ length: 12 }, (_, i) => ({ id: `W${i}` }));
    const pick = (tasks: LayoutTask[]) =>
      pickLayout(layoutBoard(tasks, CARD, "down"), layoutBoard(tasks, CARD, "right"), { width: 1100, height: 800 }).direction;
    expect(pick(wide)).toBe("right");
    expect(pick(SAMPLE)).toBe("down");
  });

  test("places in order with the room between neighbours, as near as it can to where they want to be", () => {
    expect(closestInOrder([0, 0, 0], [10, 10])).toEqual([-10, 0, 10]);
    expect(closestInOrder([0, 100, 50], [10, 10])).toEqual([0, 70, 80]);
    expect(closestInOrder([5], [])).toEqual([5]);
  });
});

describe("a task's terminal, live", () => {
  const view = (patch: Partial<SessionView>): SessionView => ({
    id: "s1",
    cmd: null,
    cwd: "/",
    cols: 80,
    rows: 24,
    pid: 1,
    createdAt: 0,
    title: "",
    exited: null,
    banner: "w1",
    tab: "t",
    color: "#000000",
    ...patch,
  });
  const wip: BoardTask = { id: "T1", title: "x", status: "wip", session: "s1" };
  const done: BoardTask = { ...wip, status: "done" };

  test("shows the agent as its window does, with how long it has been idle", () => {
    const agent = (activity: AgentStatus["activity"], extra: Partial<AgentStatus> = {}) =>
      view({ agent: { name: "claude", activity, ...extra } });
    expect(taskLive(wip, agent("working"), NOW)).toMatchObject({ terminal: "w1", text: "working", alarm: null });
    expect(taskLive(wip, agent("idle", { since: NOW - 30_000 }), NOW)?.text).toBe("idle");
    expect(taskLive(wip, agent("idle", { since: NOW - 18 * 60_000 }), NOW)?.text).toBe("idle 18m");
    expect(taskLive(wip, agent("waiting", { reason: "needs approval" }), NOW)).toMatchObject({ text: "needs approval", alarm: "amber" });
    expect(taskLive(done, agent("stopped", { reason: "at capacity" }), NOW)).toMatchObject({ text: "⚠ at capacity", alarm: "red" });
    expect(taskLive(wip, agent("working", { warning: "cyber flag" }), NOW)).toMatchObject({ text: "⚠ cyber flag", alarm: "red" });
  });

  test("a task in progress with no one working on it is an alarm; any other task's closed terminal is not", () => {
    expect(taskLive(wip, undefined, NOW)).toMatchObject({ terminal: "s1", text: "⚠ terminal closed", alarm: "red" });
    expect(taskLive(done, undefined, NOW)).toMatchObject({ text: "closed", alarm: null });
    const exited = view({ exited: { code: 0, signal: null, at: NOW } });
    expect(taskLive(wip, exited, NOW)?.alarm).toBe("red");
    expect(taskLive(done, exited, NOW)?.alarm).toBeNull();
    expect(taskLive(wip, view({ atPrompt: true }), NOW)).toMatchObject({ text: "⚠ not running", alarm: "red" });
    expect(taskLive(wip, view({ atPrompt: false }), NOW)).toMatchObject({ text: "running", alarm: null });
    expect(taskLive({ ...wip, session: undefined }, undefined, NOW)).toBeNull();
  });

  test("ages read briefly", () => {
    expect([shortAge(59_000), shortAge(5 * 60_000), shortAge(3 * 3600_000), shortAge(50 * 3600_000)]).toEqual(["now", "5m", "3h", "2d"]);
    expect([ago(NOW - 10_000, NOW), ago(NOW - 3 * 60_000, NOW), ago(NOW - 2 * 3600_000, NOW), ago(NOW - 26 * 3600_000, NOW)]).toEqual([
      "just now",
      "3 min ago",
      "2 h ago",
      "yesterday",
    ]);
  });
});

test("a usage limit's badge says when it lifts, then that it has", () => {
  const now = Date.parse("2026-11-22T20:05:00-08:00");
  const resetsAt = now + 2 * 3_600_000;
  const limit: AgentStatus = { name: "claude", activity: "stopped", reason: "usage limit", resetsAt };
  expect(agentLive("w1", limit, now).text).toBe(`⚠ usage limit · ${clockTime(resetsAt, now)}`);
  expect(agentLive("w1", limit, resetsAt + 1000)).toMatchObject({ text: "⚠ usage limit · lifted", alarm: "red" });
  // Another day names the day.
  expect(clockTime(now + 3 * 86_400_000, now)).toContain(new Date(now + 3 * 86_400_000).toLocaleDateString([], { weekday: "short" }));
});
