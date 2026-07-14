// Shared editor formatting commands — the SINGLE source of the toolbar/keyboard
// actions, consumed by the desktop selection toolbar (toolbar/plugin.ts), the
// keymap (keymap.ts), and any client-supplied accessory bar (e.g. the mobile
// above-keyboard bar). Each command takes a live `EditorView`, so the exact same
// logic drives every surface: add or refine a command here and every toolbar
// that maps to it gets the change — the desktop selection toolbar and the mobile
// keyboard bar never drift.

import { EditorSelection, type ChangeSpec } from "@codemirror/state";
import { type Command, type EditorView } from "@codemirror/view";
import { toggleWrap } from "../wrap-toggle";

/** A formatting action bound to a live view. */
export type ToolbarCommand = (view: EditorView) => void;

/** Wrap/unwrap the selection in a markdown delimiter pair (bold, italic, code,
 *  highlight, link, …). Delegates to the shared `toggleWrap` smart-toggle. */
export function wrapCommand(open: string, close: string): ToolbarCommand {
  const cmd = toggleWrap(open, close);
  return (view) => {
    cmd({ state: view.state, dispatch: view.dispatch.bind(view) });
    view.focus();
  };
}

/** The ATX heading level (1–6) of the cursor's line, or 0 for a plain
 *  paragraph — drives the toolbar's leading block-type indicator. */
export function currentHeadingLevel(view: EditorView): number {
  const line = view.state.doc.lineAt(view.state.selection.main.from);
  const m = view.state.doc.sliceString(line.from, line.to).match(/^(#{1,6})\s/);
  return m ? m[1]!.length : 0;
}

/** Set (or clear, `level === 0`) the ATX heading level of the cursor's line. */
export function applyHeadingLevel(view: EditorView, level: number): void {
  const range = view.state.selection.main;
  const line = view.state.doc.lineAt(range.from);
  const text = view.state.doc.sliceString(line.from, line.to);
  const oldPrefixLen = text.match(/^#{1,6}\s+/)?.[0].length ?? 0;
  const cleaned = text.slice(oldPrefixLen);
  const newPrefix = level === 0 ? "" : "#".repeat(level) + " ";
  const next = newPrefix + cleaned;
  // Keep the caret on the same spot WITHIN the heading text rather than letting
  // CodeMirror strand it before the "# " marker. Without an explicit selection,
  // inserting "# " on an empty line leaves the caret at "|# " — the user then
  // types before the hashes. Re-anchor each end past the new prefix: an empty
  // line lands the caret right after "# ", ready for the heading text.
  const remap = (pos: number): number =>
    line.from + newPrefix.length + Math.max(0, pos - line.from - oldPrefixLen);
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: next },
    selection: EditorSelection.range(remap(range.anchor), remap(range.head)),
    userEvent: "toolbar.heading",
  });
  view.focus();
}

/** Toggle a line prefix (list bullet, numbered, checkbox, quote) on every line
 *  the selection touches — a line already carrying the prefix loses it. */
export const toggleListPrefix = (prefix: string): Command => (view) => {
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
      changes.push({ from: line.from, to: line.from + prefix.length, insert: "" });
    } else {
      changes.push({ from: line.from, insert: prefix });
    }
  }
  view.dispatch({ changes, userEvent: "keymap.list" });
  return true;
};

function prefixCommand(prefix: string): ToolbarCommand {
  const cmd = toggleListPrefix(prefix);
  return (view) => {
    cmd(view);
    view.focus();
  };
}

/** The canonical formatting command set. Keys are stable ids a toolbar surface
 *  maps its buttons to; each value applies the edit to the given view. */
export const editorCommands = {
  bold: wrapCommand("**", "**"),
  italic: wrapCommand("*", "*"),
  strike: wrapCommand("~~", "~~"),
  code: wrapCommand("`", "`"),
  highlight: wrapCommand("==", "=="),
  heading1: (view: EditorView) => applyHeadingLevel(view, 1),
  heading2: (view: EditorView) => applyHeadingLevel(view, 2),
  heading3: (view: EditorView) => applyHeadingLevel(view, 3),
  bulletList: prefixCommand("- "),
  numberedList: prefixCommand("1. "),
  checklist: prefixCommand("- [ ] "),
  quote: prefixCommand("> "),
  link: wrapCommand("[", "](url)"),
  wikilink: wrapCommand("[[", "]]"),
} satisfies Record<string, ToolbarCommand>;

/** Stable id of a canonical formatting command. */
export type EditorCommandId = keyof typeof editorCommands;
