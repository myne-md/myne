// Myne editor keyboard shortcuts.
//
// PRD `editor-mvp-baseline` stories 41-46. Explicitly NOT bound: Cmd+1
// through Cmd+6 (browser/OS conflict — Cmd+Shift+H is the canonical
// heading-cycle shortcut); Cmd+Shift+L (wikilink autocomplete — ships in
// `editor-mvp-wikilinks` PRD).

import { type ChangeSpec } from "@codemirror/state";
import { type KeyBinding, type Command } from "@codemirror/view";
import { toggleWrap } from "./wrap-toggle";

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

export const myneKeyBindings: readonly KeyBinding[] = [
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
