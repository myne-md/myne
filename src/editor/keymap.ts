// Myne editor keyboard shortcuts.
//
// PRD `editor-mvp-baseline` stories 41-46. Explicitly NOT bound: Cmd+1
// through Cmd+6 (browser/OS conflict — Cmd+Shift+H is the canonical
// heading-cycle shortcut); Cmd+Shift+L (wikilink autocomplete — ships in
// `editor-mvp-wikilinks` PRD).

import { type ChangeSpec, type Text } from "@codemirror/state";
import { type KeyBinding, type Command } from "@codemirror/view";
import { toggleWrap } from "./wrap-toggle";
import { cachedLocateFrontmatter } from "./frontmatter-cache";

function wrapCommand(open: string, close: string): Command {
  const cmd = toggleWrap(open, close);
  return (view) =>
    cmd({ state: view.state, dispatch: view.dispatch.bind(view) });
}

const cycleHeading: Command = (view) => {
  const range = view.state.selection.main;
  const line = view.state.doc.lineAt(range.from);
  const text = view.state.doc.sliceString(line.from, line.to);
  const match = text.match(/^(#{1,6})\s+/);
  let level = match === null ? 0 : match[1]!.length;
  level = (level + 1) % 7;
  const cleaned = text.replace(/^#{1,6}\s+/, "");
  const next = level === 0 ? cleaned : "#".repeat(level) + " " + cleaned;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: next },
    userEvent: "keymap.heading",
  });
  return true;
};

const toggleListPrefix = (prefix: string): Command => (view) => {
  const lines = new Set<number>();
  for (const range of view.state.selection.ranges) {
    const startLine = view.state.doc.lineAt(range.from).number;
    const endLine = view.state.doc.lineAt(range.to).number;
    for (let n = startLine; n <= endLine; n++) lines.add(n);
  }
  const changes: ChangeSpec[] = [];
  for (const n of lines) {
    const line = view.state.doc.line(n);
    const text = view.state.doc.sliceString(line.from, line.to);
    if (text.startsWith(prefix)) {
      changes.push({
        from: line.from,
        to: line.from + prefix.length,
        insert: "",
      });
    } else {
      changes.push({ from: line.from, insert: prefix });
    }
  }
  view.dispatch({ changes, userEvent: "keymap.list" });
  return true;
};

// Mod-a (select-all) scoped to the section the cursor sits in, so it never
// sweeps the Myne-managed YAML frontmatter into a selection the user might
// then delete (which would wipe canonical `title:` / `updated:` fields —
// MYND-145). Frontmatter boundaries come from the shared `locateFrontmatter`
// helper (no duplicate regex). No escalation: a second Mod-a re-selects the
// same section rather than expanding to the whole document; selecting
// frontmatter + body together is an explicit manual action.
//
// Pure so it's unit-testable without a DOM-backed EditorView. Returns the
// scoped selection range, or `null` when there's no frontmatter (caller
// falls back to CodeMirror's default whole-document selectAll).
export function scopedSelectAllRange(
  doc: Text,
  head: number,
): { anchor: number; head: number } | null {
  const fm = cachedLocateFrontmatter(doc);
  if (fm === null) return null;
  return head < fm.blockEnd
    ? { anchor: fm.bodyStart, head: fm.bodyEnd } // cursor in FM → YAML only
    : { anchor: fm.blockEnd, head: doc.length }; // cursor in body → body only
}

const selectAllScoped: Command = (view) => {
  const { state } = view;
  const selection = scopedSelectAllRange(state.doc, state.selection.main.head);
  if (selection === null) return false; // no frontmatter → default selectAll
  view.dispatch({ selection, userEvent: "select" });
  return true;
};

export const myneKeyBindings: readonly KeyBinding[] = [
  // Listed first so it shadows defaultKeymap's selectAll (earlier wins).
  { key: "Mod-a", run: selectAllScoped },
  { key: "Mod-b", run: wrapCommand("**", "**") },
  { key: "Mod-i", run: wrapCommand("*", "*") },
  { key: "Mod-e", run: wrapCommand("`", "`") },
  // Cmd+K is reserved for the global command palette (MYND-86); link
  // insertion is via the selection toolbar 🔗 button.
  { key: "Mod-Shift-h", run: cycleHeading },
  { key: "Mod-Shift-7", run: toggleListPrefix("1. ") },
  { key: "Mod-Shift-8", run: toggleListPrefix("- ") },
  { key: "Mod-Shift-m", run: toggleListPrefix("- [ ] ") },
];
