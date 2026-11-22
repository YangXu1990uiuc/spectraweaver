// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

// Where the cards of a task board go and how the arrows between them run (DESIGN.md §8.7).
// A layered drawing: each task sits one layer past the deepest task it waits for; an arrow that
// skips layers passes through a waypoint in each, so it runs between cards and never through
// one; layers are ordered to cross few arrows, and cards sit as close as they can to the tasks
// they connect to. Pure functions, tested without a browser.

export interface LayoutTask {
  id: string;
  /** Ids of the tasks it waits for; unknown ids are ignored. */
  after?: readonly string[];
}

export interface Size {
  width: number;
  height: number;
}

/** "down": layers are rows, arrows point down. "right": layers are columns, arrows point right. */
export type Direction = "down" | "right";

export interface PlacedCard {
  id: string;
  /** Top-left corner, in px. */
  x: number;
  y: number;
  layer: number;
}

export interface LaidEdge {
  /** The task waited for. */
  from: string;
  /** The task that waits. */
  to: string;
  /** The line, as SVG path data; it stops where the head begins. */
  path: string;
  /** The arrowhead, a filled triangle, as SVG path data. */
  head: string;
  /** Where the line bends: from the first card, through each waypoint, to the second. */
  points: Array<{ x: number; y: number }>;
}

export interface BoardLayout {
  direction: Direction;
  card: Size;
  width: number;
  height: number;
  cards: Map<string, PlacedCard>;
  edges: LaidEdge[];
}

const MARGIN = 24;
/** Room between layers, where arrows bend. */
const RANK_GAP: Record<Direction, number> = { down: 56, right: 72 };
/** Room between neighbouring cards in a layer. */
const CROSS_GAP: Record<Direction, number> = { down: 20, right: 16 };
/** A waypoint's width, and the room beside it: arrows passing a layer keep this far apart. */
const WAYPOINT = 8;
const WAYPOINT_GAP = 10;
const HEAD = 8;
const ORDER_SWEEPS = 8;
const PLACE_SWEEPS = 8;

interface Node {
  /** The task, or null for a waypoint. */
  id: string | null;
  layer: number;
  up: Node[];
  down: Node[];
  /** Position within the layer: the index while ordering, then the centre in px. */
  pos: number;
}

/** Lays the board out in both directions and keeps the one that fits `area` with the least shrinking. */
export function chooseLayout(tasks: readonly LayoutTask[], card: Size, area: Size): BoardLayout {
  const down = layoutBoard(tasks, card, "down");
  const right = layoutBoard(tasks, card, "right");
  return fitScale(right, area) > fitScale(down, area) + 0.01 ? right : down;
}

/** How much a layout must shrink to fit in `area` (1 when it fits). */
export function fitScale(layout: BoardLayout, area: Size): number {
  return Math.min(1, area.width / layout.width, area.height / layout.height);
}

export function layoutBoard(tasks: readonly LayoutTask[], card: Size, direction: Direction): BoardLayout {
  const ids = tasks.map((task) => task.id);
  const known = new Set(ids);
  const after = new Map<string, string[]>();
  for (const task of tasks) {
    after.set(task.id, [...new Set(task.after ?? [])].filter((id) => known.has(id) && id !== task.id));
  }
  dropCycles(ids, after);
  const layer = layers(ids, after);

  // The layered graph: tasks, and a waypoint in each layer an arrow skips.
  const nodes = new Map<string, Node>(ids.map((id) => [id, { id, layer: layer.get(id)!, up: [], down: [], pos: 0 }]));
  const chains: Array<{ from: string; to: string; nodes: Node[] }> = [];
  const byLayer: Node[][] = [];
  const add = (node: Node) => (byLayer[node.layer] ??= []).push(node);
  for (const id of ids) add(nodes.get(id)!);
  for (const id of ids) {
    for (const dependency of after.get(id)!) {
      const chain = [nodes.get(dependency)!];
      for (let level = layer.get(dependency)! + 1; level < layer.get(id)!; level++) {
        const waypoint: Node = { id: null, layer: level, up: [], down: [], pos: 0 };
        add(waypoint);
        chain.push(waypoint);
      }
      chain.push(nodes.get(id)!);
      for (let i = 1; i < chain.length; i++) {
        chain[i - 1]!.down.push(chain[i]!);
        chain[i]!.up.push(chain[i - 1]!);
      }
      chains.push({ from: dependency, to: id, nodes: chain });
    }
  }
  for (let level = 0; level < byLayer.length; level++) byLayer[level] ??= [];

  order(byLayer);
  const cardCross = direction === "down" ? card.width : card.height;
  const cardRank = direction === "down" ? card.height : card.width;
  place(byLayer, cardCross, CROSS_GAP[direction]);

  const pitch = cardRank + RANK_GAP[direction];
  const lowest = Math.min(0, ...byLayer.flat().map((node) => node.pos - size(node, cardCross) / 2));
  const shift = MARGIN - lowest;
  for (const node of byLayer.flat()) node.pos += shift;
  const crossExtent = Math.max(0, ...byLayer.flat().map((node) => node.pos + size(node, cardCross) / 2)) + MARGIN;
  const rankExtent = MARGIN * 2 + byLayer.length * pitch - RANK_GAP[direction];

  const cards = new Map<string, PlacedCard>();
  for (const node of nodes.values()) {
    const rank = MARGIN + node.layer * pitch;
    const cross = node.pos - cardCross / 2;
    cards.set(node.id!, {
      id: node.id!,
      layer: node.layer,
      x: direction === "down" ? cross : rank,
      y: direction === "down" ? rank : cross,
    });
  }

  // Arrows arriving at a card spread along its edge, in the order they come from.
  const arrivals = new Map<string, Array<{ chain: (typeof chains)[number]; from: number }>>();
  for (const chain of chains) {
    const list = arrivals.get(chain.to) ?? [];
    list.push({ chain, from: chain.nodes.at(-2)!.pos });
    arrivals.set(chain.to, list);
  }
  const offsets = new Map<(typeof chains)[number], number>();
  for (const list of arrivals.values()) {
    list.sort((a, b) => a.from - b.from);
    const step = Math.min(direction === "down" ? 24 : 12, (cardCross * 0.7) / list.length);
    list.forEach((entry, index) => offsets.set(entry.chain, (index - (list.length - 1) / 2) * step));
  }

  const edges = chains.map((chain) => edgeOf(chain, offsets.get(chain) ?? 0, pitch, cardRank, direction));
  return {
    direction,
    card,
    width: direction === "down" ? crossExtent : rankExtent,
    height: direction === "down" ? rankExtent : crossExtent,
    cards,
    edges,
  };
}

/** The arrow of one dependency: out of the first card, straight through each waypoint's layer, into the second. */
function edgeOf(
  chain: { from: string; to: string; nodes: Node[] },
  arrivalOffset: number,
  pitch: number,
  cardRank: number,
  direction: Direction,
): LaidEdge {
  // Points as (cross, rank), turned into (x, y) at the end.
  const points: Array<[number, number]> = [];
  const [first, ...rest] = chain.nodes;
  points.push([first!.pos, MARGIN + first!.layer * pitch + cardRank]);
  for (const node of rest) {
    const top = MARGIN + node.layer * pitch;
    if (node.id === null) {
      points.push([node.pos, top], [node.pos, top + cardRank]);
    } else {
      points.push([node.pos + arrivalOffset, top]);
    }
  }
  const xy = (cross: number, rank: number) => (direction === "down" ? { x: cross, y: rank } : { x: rank, y: cross });
  let path = "";
  for (let i = 0; i < points.length; i++) {
    const [cross, rank] = points[i]!;
    const last = i === points.length - 1;
    const end = xy(cross, last ? rank - HEAD + 1 : rank);
    if (i === 0) {
      path = `M ${round(end.x)} ${round(end.y)}`;
      continue;
    }
    const [fromCross, fromRank] = points[i - 1]!;
    if (fromCross === cross && !last) {
      path += ` L ${round(end.x)} ${round(end.y)}`;
      continue;
    }
    // A curve that leaves and arrives along the layers' axis, bending in the room between layers.
    const middle = (fromRank + rank) / 2;
    const a = xy(fromCross, middle);
    const b = xy(cross, middle);
    path += ` C ${round(a.x)} ${round(a.y)}, ${round(b.x)} ${round(b.y)}, ${round(end.x)} ${round(end.y)}`;
  }
  const [tipCross, tipRank] = points.at(-1)!;
  const tip = xy(tipCross, tipRank - 1);
  const left = xy(tipCross - 4, tipRank - HEAD);
  const right = xy(tipCross + 4, tipRank - HEAD);
  return {
    from: chain.from,
    to: chain.to,
    path,
    head: `M ${round(left.x)} ${round(left.y)} L ${round(right.x)} ${round(right.y)} L ${round(tip.x)} ${round(tip.y)} Z`,
    points: points.map(([cross, rank]) => xy(cross, rank)),
  };
}

/** Ignores the dependencies that close a circle, so every task gets a layer. */
function dropCycles(ids: readonly string[], after: Map<string, string[]>): void {
  const state = new Map<string, "open" | "done">();
  const visit = (id: string) => {
    state.set(id, "open");
    const kept: string[] = [];
    for (const dependency of after.get(id)!) {
      if (state.get(dependency) === "open") continue;
      if (!state.has(dependency)) visit(dependency);
      kept.push(dependency);
    }
    after.set(id, kept);
    state.set(id, "done");
  };
  for (const id of ids) if (!state.has(id)) visit(id);
}

/** Each task one layer past the deepest task it waits for; tasks that wait for none are in layer 0. */
function layers(ids: readonly string[], after: Map<string, string[]>): Map<string, number> {
  const layer = new Map<string, number>();
  const of = (id: string): number => {
    const known = layer.get(id);
    if (known !== undefined) return known;
    const value = Math.max(-1, ...after.get(id)!.map(of)) + 1;
    layer.set(id, value);
    return value;
  };
  for (const id of ids) of(id);
  return layer;
}

/**
 * Orders each layer to cross few arrows: repeated sweeps down and up, each node moving to the
 * mean position of its neighbours in the layer swept from; the order with the fewest crossings
 * seen wins. Ties keep the board's own order, so a board that changes a little looks the same.
 */
function order(byLayer: Node[][]): void {
  const index = () => byLayer.forEach((layer) => layer.forEach((node, i) => (node.pos = i)));
  index();
  let best = byLayer.map((layer) => [...layer]);
  let fewest = crossings(byLayer);
  const sortBy = (layer: Node[], neighbours: (node: Node) => Node[]) => {
    const keyed = layer.map((node) => {
      const around = neighbours(node);
      const key = around.length > 0 ? around.reduce((sum, other) => sum + other.pos, 0) / around.length : node.pos;
      return { node, key };
    });
    keyed.sort((a, b) => a.key - b.key || a.node.pos - b.node.pos);
    keyed.forEach((entry, i) => {
      layer[i] = entry.node;
      entry.node.pos = i;
    });
  };
  for (let sweep = 0; sweep < ORDER_SWEEPS && fewest > 0; sweep++) {
    if (sweep % 2 === 0) for (let level = 1; level < byLayer.length; level++) sortBy(byLayer[level]!, (node) => node.up);
    else for (let level = byLayer.length - 2; level >= 0; level--) sortBy(byLayer[level]!, (node) => node.down);
    const count = crossings(byLayer);
    if (count < fewest) {
      fewest = count;
      best = byLayer.map((layer) => [...layer]);
    }
  }
  best.forEach((layer, level) => (byLayer[level] = layer));
  index();
}

/** How many pairs of arrows cross between neighbouring layers, with nodes at their indexes. */
function crossings(byLayer: Node[][]): number {
  let count = 0;
  for (const layer of byLayer.slice(0, -1)) {
    const segments = layer.flatMap((node) => node.down.map((below) => [node.pos, below.pos] as const));
    for (let i = 0; i < segments.length; i++) {
      for (let j = i + 1; j < segments.length; j++) {
        const [a1, a2] = segments[i]!;
        const [b1, b2] = segments[j]!;
        if ((a1 - b1) * (a2 - b2) < 0) count++;
      }
    }
  }
  return count;
}

function size(node: Node, cardCross: number): number {
  return node.id === null ? WAYPOINT : cardCross;
}

/**
 * Positions within each layer, keeping the order and the room between neighbours: each sweep
 * moves every node as near as it may to the mean of its neighbours in the layer swept from
 * (the closest positions that keep the room, by isotonic regression); the last sweep looks both ways.
 */
function place(byLayer: Node[][], cardCross: number, gap: number): void {
  const room = (a: Node, b: Node) =>
    (size(a, cardCross) + size(b, cardCross)) / 2 + (a.id !== null && b.id !== null ? gap : WAYPOINT_GAP);
  for (const layer of byLayer) {
    let at = 0;
    layer.forEach((node, i) => {
      if (i > 0) at += room(layer[i - 1]!, node);
      node.pos = at;
    });
    const middle = at / 2;
    for (const node of layer) node.pos -= middle;
  }
  const settle = (layer: Node[], neighbours: (node: Node) => Node[]) => {
    const wanted = layer.map((node) => {
      const around = neighbours(node);
      return around.length > 0 ? around.reduce((sum, other) => sum + other.pos, 0) / around.length : node.pos;
    });
    const placed = closestInOrder(
      wanted,
      layer.slice(1).map((node, i) => room(layer[i]!, node)),
    );
    layer.forEach((node, i) => (node.pos = placed[i]!));
  };
  for (let sweep = 0; sweep < PLACE_SWEEPS; sweep++) {
    if (sweep % 2 === 0) for (let level = 1; level < byLayer.length; level++) settle(byLayer[level]!, (node) => node.up);
    else for (let level = byLayer.length - 2; level >= 0; level--) settle(byLayer[level]!, (node) => node.down);
  }
  for (const layer of byLayer) settle(layer, (node) => [...node.up, ...node.down]);
}

/**
 * The positions nearest to `wanted` (least squares) with each at least `gaps[i]` past the one
 * before: shifted by the running sum of the gaps, this is isotonic regression, solved by pooling
 * adjacent violators.
 */
export function closestInOrder(wanted: readonly number[], gaps: readonly number[]): number[] {
  const offsets = [0];
  for (const gap of gaps) offsets.push(offsets.at(-1)! + gap);
  const blocks: Array<{ sum: number; count: number }> = [];
  wanted.forEach((value, i) => {
    blocks.push({ sum: value - offsets[i]!, count: 1 });
    while (blocks.length > 1) {
      const last = blocks.at(-1)!;
      const before = blocks.at(-2)!;
      if (before.sum / before.count <= last.sum / last.count) break;
      blocks.pop();
      before.sum += last.sum;
      before.count += last.count;
    }
  });
  const result: number[] = [];
  for (const block of blocks) for (let i = 0; i < block.count; i++) result.push(block.sum / block.count + offsets[result.length]!);
  return result;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
