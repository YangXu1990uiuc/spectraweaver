// Copyright 2026 The workstreams Authors
// SPDX-License-Identifier: Apache-2.0
// Part of workstreams: https://github.com/YangXu1990uiuc/workstreams

// Viewers must never answer terminal queries: the daemon's engine is the single responder.
// With two browsers attached, each would otherwise reply too, and the extra replies would
// reach the program as typed input (e.g. "^[[?1;2c" appearing at a shell prompt).
//
// Handlers registered here return true only for the query forms, so state-changing
// sequences (colour changes, clipboard writes, ...) still reach xterm.js. Register this
// after loading addons: the most recently registered handler runs first.

interface Disposable {
  dispose(): void;
}

interface FunctionId {
  prefix?: string;
  intermediates?: string;
  final: string;
}

type Params = (number | number[])[];

interface ParserLike {
  registerCsiHandler(id: FunctionId, callback: (params: Params) => boolean | Promise<boolean>): Disposable;
  registerDcsHandler(
    id: FunctionId,
    callback: (data: string, params: Params) => boolean | Promise<boolean>,
  ): Disposable;
  registerEscHandler(id: FunctionId, handler: () => boolean | Promise<boolean>): Disposable;
  registerOscHandler(ident: number, callback: (data: string) => boolean | Promise<boolean>): Disposable;
}

const QUERY_CSI: FunctionId[] = [
  { final: "c" }, // DA1
  { prefix: ">", final: "c" }, // DA2
  { prefix: "=", final: "c" }, // DA3
  { final: "n" }, // DSR and CPR
  { prefix: "?", final: "n" }, // DEC-specific DSR
  { intermediates: "$", final: "p" }, // DECRQM, ANSI modes
  { prefix: "?", intermediates: "$", final: "p" }, // DECRQM, DEC modes
  { prefix: ">", final: "q" }, // XTVERSION
  { prefix: "?", final: "u" }, // kitty keyboard flags query
];

const QUERY_DCS: FunctionId[] = [
  { intermediates: "$", final: "q" }, // DECRQSS
  { intermediates: "+", final: "q" }, // XTGETTCAP
];

export function suppressQueryReplies(term: { parser: ParserLike }): Disposable {
  const swallow = () => true;
  const disposables: Disposable[] = [
    ...QUERY_CSI.map((id) => term.parser.registerCsiHandler(id, swallow)),
    ...QUERY_DCS.map((id) => term.parser.registerDcsHandler(id, swallow)),
    term.parser.registerEscHandler({ final: "Z" }, swallow), // DECID
    ...[4, 10, 11, 12, 52].map((ident) =>
      term.parser.registerOscHandler(ident, (data) => isOscQuery(ident, data)),
    ),
  ];
  return {
    dispose: () => {
      for (const disposable of disposables) disposable.dispose();
    },
  };
}

function isOscQuery(ident: number, data: string): boolean {
  const parts = data.split(";");
  switch (ident) {
    case 4: // "index;spec" pairs; "?" as the spec is a query
      return parts.some((part, index) => index % 2 === 1 && part === "?");
    case 52: // "selection;?" reads the clipboard
      return parts[1] === "?";
    default: // OSC 10/11/12: "?" queries the colour
      return parts.includes("?");
  }
}
