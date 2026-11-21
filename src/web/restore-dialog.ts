// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

// "↻ Restore": terminals lost when the daemon stopped (a reboot, or `spectraweaver down --all`),
// to open again where they were, and the agents' recent conversations, to resume in new terminals.

import type { ClientMessage, Conversation, LostSession } from "../common/protocol.ts";
import { el } from "./dom.ts";

export interface RestoreContext {
  send(message: ClientMessage): void;
  tabName(id: string): string;
  /** Opens a new terminal in the current tab, in this directory, running this command. */
  open(cwd: string, cmd: string): void;
}

export function createRestoreDialog(context: RestoreContext): {
  element: HTMLDialogElement;
  open(): void;
  setLost(lost: LostSession[]): void;
  setConversations(conversations: Conversation[], flags: Record<string, string>): void;
} {
  let lost: LostSession[] = [];
  let conversations: Conversation[] = [];
  const lostPicked = new Set<string>();
  const conversationsPicked = new Set<string>();

  const lostList = el("ul", { class: "pick-list" });
  const restoreButton = el("button", { type: "button", class: "primary" });
  const forgetButton = el("button", { type: "button" }, ["Forget"]);
  const lostSection = el("section", {}, [
    el("h3", {}, ["Terminals lost when the daemon stopped"]),
    el("p", { class: "hint" }, [
      "A reboot, or spectraweaver down --all, ends every terminal. Restoring opens each again in its tab, " +
        "place, size and directory; an agent that ran in it resumes the same conversation.",
    ]),
    lostList,
    el("div", { class: "actions" }, [forgetButton, restoreButton]),
  ]);

  const flagInputs = {
    claude: el("input", { spellcheck: "false", placeholder: "none", "aria-label": "Claude Code flags" }),
    codex: el("input", { spellcheck: "false", placeholder: "none", "aria-label": "Codex flags" }),
  };
  const conversationList = el("ul", { class: "pick-list" });
  const conversationNote = el("p", { class: "hint" });
  const openButton = el("button", { type: "button", class: "primary" });
  const conversationSection = el("section", {}, [
    el("h3", {}, ["Resume a recent conversation"]),
    el("p", { class: "hint" }, [
      "Claude Code and Codex conversations from the last two weeks that no terminal is on. " +
        "Each opens in a new terminal in this tab, in the directory it was started in.",
    ]),
    el("div", { class: "flag-row" }, [
      el("label", {}, ["claude flags", flagInputs.claude]),
      el("label", {}, ["codex flags", flagInputs.codex]),
    ]),
    conversationNote,
    conversationList,
    el("div", { class: "actions" }, [openButton]),
  ]);

  const close = el("button", { type: "button" }, ["Close"]);
  const dialog = el("dialog", { class: "restore-dialog" }, [
    el("h2", {}, ["Restore"]),
    lostSection,
    conversationSection,
    el("div", { class: "actions" }, [close]),
  ]);

  const renderLost = () => {
    lostSection.hidden = lost.length === 0;
    lostList.replaceChildren(
      ...lost.map((session) => {
        const name = session.banner || session.agent?.conversation || shortPath(session.cwd);
        const details = [shortPath(session.cwd), context.tabName(session.tab), session.agent?.command ?? "shell"];
        return pickItem(lostPicked, session.id, renderLost, [
          el("span", { class: "swatch", style: `background:${session.color}` }),
          el("span", { class: "pick-text" }, [
            el("span", { class: "pick-name" }, [name]),
            el("span", { class: "pick-meta" }, [details.join(" · ")]),
          ]),
        ]);
      }),
    );
    const count = lost.filter((session) => lostPicked.has(session.id)).length;
    restoreButton.textContent = `Restore ${count}`;
    restoreButton.disabled = count === 0;
    forgetButton.disabled = count === 0;
  };

  const renderConversations = () => {
    conversationList.replaceChildren(
      ...conversations.map((found) =>
        pickItem(conversationsPicked, found.id, renderConversations, [
          el("span", { class: `agent-tag ${found.agent}` }, [found.agent]),
          el("span", { class: "pick-text" }, [
            el("span", { class: "pick-name" }, [found.label || shortPath(found.cwd)]),
            el("span", { class: "pick-meta" }, [`${shortPath(found.cwd)} · ${ago(found.updatedAt)}`]),
          ]),
        ]),
      ),
    );
    const count = conversations.filter((found) => conversationsPicked.has(found.id)).length;
    openButton.textContent = `Open ${count}`;
    openButton.disabled = count === 0;
  };

  restoreButton.addEventListener("click", () => {
    context.send({ t: "restore", ids: lost.filter((session) => lostPicked.has(session.id)).map((session) => session.id) });
    dialog.close();
  });
  forgetButton.addEventListener("click", () => {
    const ids = lost.filter((session) => lostPicked.has(session.id)).map((session) => session.id);
    if (!confirm(`Forget ${ids.length} lost terminal${ids.length === 1 ? "" : "s"}? Their conversations stay in "Resume a recent conversation".`)) return;
    context.send({ t: "forget", ids });
  });
  openButton.addEventListener("click", () => {
    for (const found of conversations) {
      if (!conversationsPicked.has(found.id)) continue;
      const flags = flagInputs[found.agent as keyof typeof flagInputs]?.value.trim() ?? "";
      context.open(found.cwd, flags ? `${found.command} ${flags}` : found.command);
    }
    dialog.close();
  });
  close.addEventListener("click", () => dialog.close());

  return {
    element: dialog,
    open() {
      // Every lost terminal is picked to begin with; recent conversations are opt-in.
      lostPicked.clear();
      for (const session of lost) lostPicked.add(session.id);
      conversationsPicked.clear();
      conversations = [];
      conversationNote.textContent = "Looking for conversations…";
      renderLost();
      renderConversations();
      context.send({ t: "conversations" });
      dialog.showModal();
    },
    setLost(next) {
      const known = new Set(lost.map((session) => session.id));
      lost = next;
      // Terminals lost while the dialog is open are picked too.
      for (const session of lost) if (!known.has(session.id)) lostPicked.add(session.id);
      if (dialog.open) renderLost();
    },
    setConversations(next, flags) {
      conversations = next;
      flagInputs.claude.value = flags.claude ?? "";
      flagInputs.codex.value = flags.codex ?? "";
      conversationNote.textContent = next.length === 0 ? "None found." : "";
      renderConversations();
    },
  };
}

function pickItem(picked: Set<string>, id: string, changed: () => void, children: Node[]): HTMLLIElement {
  const box = el("input", { type: "checkbox" });
  box.checked = picked.has(id);
  box.addEventListener("change", () => {
    if (box.checked) picked.add(id);
    else picked.delete(id);
    changed();
  });
  return el("li", {}, [el("label", {}, [box, ...children])]);
}

/** A directory with the home directory shortened to ~. */
export function shortPath(path: string): string {
  return path.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, "~");
}

/** "just now", "5 min ago", "3 h ago", "yesterday", or the date. */
export function ago(at: number, now = Date.now()): string {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  if (hours < 48) return "yesterday";
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
