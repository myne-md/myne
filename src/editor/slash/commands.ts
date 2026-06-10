// Slash command registry — 11 commands (per PRD story 34).
//
// `/wiki` is explicitly excluded; it ships in `editor-mvp-wikilinks`
// alongside the autocomplete picker.

import type { EditorView } from "@codemirror/view";
import { pickAndInsert } from "../attachments/picker";

export type SlashCommand = {
  id: string;
  label: string;
  icon: string;
  /** Optional keyboard hint to render in the right column. */
  kbd?: string;
  apply: (view: EditorView, triggerFrom: number, triggerTo: number) => void;
};

function replaceLinePrefix(
  view: EditorView,
  triggerFrom: number,
  triggerTo: number,
  prefix: string,
): void {
  const line = view.state.doc.lineAt(triggerFrom);
  // Replace the slash + filter span first, then prepend `prefix` to the line.
  const lineText = view.state.doc.sliceString(line.from, line.to);
  const cleaned = lineText.slice(0, triggerFrom - line.from) +
    lineText.slice(triggerTo - line.from);
  const next = prefix + cleaned;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: next },
    selection: { anchor: line.from + prefix.length },
    userEvent: "slash.apply",
  });
}

function insertAtTrigger(
  view: EditorView,
  triggerFrom: number,
  triggerTo: number,
  insert: string,
  caretOffsetFromInsertStart?: number,
): void {
  view.dispatch({
    changes: { from: triggerFrom, to: triggerTo, insert },
    selection: {
      anchor: triggerFrom + (caretOffsetFromInsertStart ?? insert.length),
    },
    userEvent: "slash.apply",
  });
}

export function slashCommands(): readonly SlashCommand[] {
  return [
    {
      id: "h1",
      label: "Heading 1",
      icon: "H1",
      kbd: "⌘⇧H",
      apply: (v, f, t) => replaceLinePrefix(v, f, t, "# "),
    },
    {
      id: "h2",
      label: "Heading 2",
      icon: "H2",
      apply: (v, f, t) => replaceLinePrefix(v, f, t, "## "),
    },
    {
      id: "h3",
      label: "Heading 3",
      icon: "H3",
      apply: (v, f, t) => replaceLinePrefix(v, f, t, "### "),
    },
    {
      id: "h4",
      label: "Heading 4",
      icon: "H4",
      apply: (v, f, t) => replaceLinePrefix(v, f, t, "#### "),
    },
    {
      id: "h5",
      label: "Heading 5",
      icon: "H5",
      apply: (v, f, t) => replaceLinePrefix(v, f, t, "##### "),
    },
    {
      id: "h6",
      label: "Heading 6",
      icon: "H6",
      apply: (v, f, t) => replaceLinePrefix(v, f, t, "###### "),
    },
    {
      id: "quote",
      label: "Quote",
      icon: "”",
      apply: (v, f, t) => replaceLinePrefix(v, f, t, "> "),
    },
    {
      // MYND-47: inserts a note callout header; the user types the title and can
      // change the type. (A type-picker sub-palette is a flagged refinement.)
      // First blockquote-family construct the editor EMITS — §5 callout row.
      id: "callout",
      label: "Callout",
      icon: "!",
      apply: (v, f, t) => replaceLinePrefix(v, f, t, "> [!note] "),
    },
    {
      id: "divider",
      label: "Divider",
      icon: "—",
      apply: (v, f, t) => insertAtTrigger(v, f, t, "---\n"),
    },
    {
      id: "link",
      label: "Link",
      icon: "↗",
      kbd: "⌘K",
      apply: (v, f, t) => insertAtTrigger(v, f, t, "[]()", 1),
    },
    {
      id: "bullet",
      label: "Bullet list",
      icon: "•",
      apply: (v, f, t) => replaceLinePrefix(v, f, t, "- "),
    },
    {
      id: "numbered",
      label: "Numbered list",
      icon: "1.",
      apply: (v, f, t) => replaceLinePrefix(v, f, t, "1. "),
    },
    {
      id: "todo",
      label: "To-do list",
      icon: "☐",
      apply: (v, f, t) => replaceLinePrefix(v, f, t, "- [ ] "),
    },
    {
      // `/attach` (MYND-164): a single command (not type-split) — opens the
      // allowlist-filtered file picker, imports each chosen file, and inserts
      // form-C embed(s) at the trigger position. The trigger text (`/attach…`)
      // is removed first so the embed lands cleanly.
      id: "attach",
      label: "Attach file",
      icon: "▣",
      apply: (v, f, t) => {
        v.dispatch({
          changes: { from: f, to: t, insert: "" },
          selection: { anchor: f },
          userEvent: "slash.apply",
        });
        void pickAndInsert(v, f);
      },
    },
  ];
}

import { fuzzyFilter } from "../../commands/fuzzy";

/** Shares the same scorer as the command palette (`src/commands/fuzzy.ts`)
 *  so slash menu + palette have identical ranking semantics. */
export function filterCommands(
  commands: readonly SlashCommand[],
  query: string,
): readonly SlashCommand[] {
  const candidates = commands.map((cmd) => ({
    item: cmd,
    haystacks: [cmd.id, cmd.label],
  }));
  return fuzzyFilter(candidates, query).map((m) => m.item);
}
