// Myne editor keyboard shortcuts.
//
// PRD `editor-mvp-baseline` stories 41-46. Explicitly NOT bound: Cmd+1
// through Cmd+6 (browser/OS conflict — Cmd+Shift+H is the canonical
// heading-cycle shortcut); Cmd+Shift+L opens the `[[` wikilink note picker
// (MYND-38).

import { EditorSelection, type Text } from "@codemirror/state";
import { type KeyBinding, type Command } from "@codemirror/view";
import { foldAll, unfoldAll } from "@codemirror/language";
import { selectNextOccurrence } from "@codemirror/search";
import { undo, redo, indentMore, indentLess } from "@codemirror/commands";
import { toggleWrap } from "./wrap-toggle";
// List-prefix toggles are shared with the toolbar surfaces (single source).
import { toggleListPrefix } from "./toolbar/commands";
import { cachedLocateFrontmatter } from "./frontmatter-cache";
import { openWikilinkPicker } from "./wikilink/picker";
import { vimWantsEscape } from "./vim";

/** Escape collapses a multi-cursor / multi-range selection back to a single
 *  cursor at the primary range's head (multi-cursor story 6, MYND-306). Returns
 *  `false` when there is only one range, so the keystroke falls through to other
 *  Escape handlers (close the search bar, dismiss a menu) — it never swallows a
 *  plain Escape. */
export const collapseMultiSelection: Command = (view) => {
  // vim-keyboard-mode (MYND-313): while vim is in insert / visual / replace,
  // Escape's first job is the mode transition — "one Escape, one job" (design
  // session Q2). Declining here lets the key fall through to the vim engine,
  // which captures at the DOM level AFTER every CodeMirror keymap; returning
  // `true` here would silently steal the key and strand the user in insert mode.
  // A second Escape, now in normal mode, collapses the multi-selection.
  if (vimWantsEscape(view)) return false;
  if (view.state.selection.ranges.length <= 1) return false;
  view.dispatch({
    selection: EditorSelection.single(view.state.selection.main.head),
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
};

function wrapCommand(open: string, close: string): Command {
  const cmd = toggleWrap(open, close);
  return (view) =>
    cmd({ state: view.state, dispatch: view.dispatch.bind(view) });
}

export const cycleHeading: Command = (view) => {
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

/** One rebindable editor command: a stable `id` (the `vault.prefs.keymap`
 *  override key, shared verbatim with the Hotkeys catalog in
 *  `src/commands/bindableCatalog.ts`), its in-code default chord(s), the CM6
 *  `Command` it runs, and whether it swallows the browser default. */
interface RebindableEditorBinding {
  id: string;
  defaultKeys: readonly string[];
  run: Command;
  preventDefault?: boolean;
}

// The editor commands the Hotkeys panel can rebind (#184 track B — previously
// hardcoded here and marked "fixed, SYNC-9"). `id` is the SAME override key the
// catalog uses; `buildMyneKeymap(overrides)` turns `override ?? default` into the
// CM6 keymap the editor mounts in a Compartment (extensions.ts), so a rebind in
// the panel takes effect live with no remount. Keys reserved for other surfaces
// stay reserved: Cmd+K is the global palette (MYND-86), so link insert is the 🔗
// toolbar button; Cmd+1–6 are unbound (OS/browser conflict).
//
// undo/redo/indent/outdent moved here from `@codemirror/commands`'
// `historyKeymap` / `indentWithTab` so they are override-driven too. undo/redo
// keep `preventDefault` (the browser's own undo must not also fire). The obscure
// `Mod-u` undoSelection stays a fixed static binding in extensions.ts (never
// listed, so nothing to rebind). `Escape` (collapseMultiSelection) is also fixed
// — it is widget-nav, deliberately excluded from the panel (catalog grill Q2).
const REBINDABLE_EDITOR_BINDINGS: readonly RebindableEditorBinding[] = [
  // Listed first so Mod-a shadows defaultKeymap's selectAll (earlier wins).
  { id: "editor.select-all", defaultKeys: ["Mod-a"], run: selectAllScoped },
  { id: "editor.bold", defaultKeys: ["Mod-b"], run: wrapCommand("**", "**") },
  { id: "editor.italic", defaultKeys: ["Mod-i"], run: wrapCommand("*", "*") },
  { id: "editor.code", defaultKeys: ["Mod-e"], run: wrapCommand("`", "`") },
  { id: "editor.cycle-heading", defaultKeys: ["Mod-Shift-h"], run: cycleHeading },
  { id: "editor.ordered-list", defaultKeys: ["Mod-Shift-7"], run: toggleListPrefix("1. ") },
  { id: "editor.bullet-list", defaultKeys: ["Mod-Shift-8"], run: toggleListPrefix("- ") },
  { id: "editor.task-list", defaultKeys: ["Mod-Shift-m"], run: toggleListPrefix("- [ ] ") },
  // Cmd/Ctrl+Shift+L (MYND-38): open the `[[` note picker at the cursor.
  { id: "editor.wikilink", defaultKeys: ["Mod-Shift-l"], run: openWikilinkPicker },
  // Heading/list folding (MYND-300): CodeMirror's own foldAll/unfoldAll chords
  // (the Obsidian convention too). Per-fold is the gutter click; there is
  // intentionally NO toggle-fold-at-cursor chord (minimal keymap, PRD OOS).
  { id: "editor.fold-all", defaultKeys: ["Mod-Alt-["], run: foldAll },
  { id: "editor.unfold-all", defaultKeys: ["Mod-Alt-]"], run: unfoldAll },
  // Multi-cursor (MYND-306): Mod-d adds the next occurrence to the selection (the
  // VS Code / Obsidian convention). Bound EXPLICITLY (SYNC-2) — Myne installs only
  // `Escape` from @codemirror/search, never `searchKeymap` wholesale.
  { id: "editor.select-next", defaultKeys: ["Mod-d"], run: selectNextOccurrence },
  // History (#184): undo/redo, formerly `historyKeymap`. Two default redo chords
  // cover both conventions (Mod-y on Win/Linux, Mod-Shift-z on macOS).
  { id: "editor.undo", defaultKeys: ["Mod-z"], run: undo, preventDefault: true },
  { id: "editor.redo", defaultKeys: ["Mod-y", "Mod-Shift-z"], run: redo, preventDefault: true },
  // Indent / outdent (#184): the two halves of `@codemirror/commands`'
  // `indentWithTab` ({key:"Tab", run:indentMore, shift:indentLess}) split into
  // two rebindable chords — behaviour-identical, but now override-driven.
  { id: "editor.indent", defaultKeys: ["Tab"], run: indentMore },
  { id: "editor.outdent", defaultKeys: ["Shift-Tab"], run: indentLess },
];

/** In-code default chords keyed by id — the display defaults the Hotkeys catalog
 *  mirrors (a drift test pins the two equal) and the seed `buildMyneKeymap` uses
 *  when there is no override. */
export const EDITOR_KEYMAP_DEFAULTS: Readonly<Record<string, string[]>> =
  Object.fromEntries(REBINDABLE_EDITOR_BINDINGS.map((b) => [b.id, [...b.defaultKeys]]));

/** The set of editor-command ids that are override-driven — the Hotkeys panel's
 *  "these dispatch in the editor keymap, not the window engine" list. */
export const EDITOR_KEYMAP_IDS: readonly string[] = REBINDABLE_EDITOR_BINDINGS.map(
  (b) => b.id,
);

/**
 * Build the editor's rebindable CM6 keymap from the user override map
 * (`vault.prefs.keymap`, id → chords). Effective chords per id = `override ??
 * default`; an override of `[]` is an explicit unbind (no KeyBinding emitted), a
 * multi-chord value emits one KeyBinding per chord. The result seeds — and, on a
 * keymap change, reconfigures — the editor keymap Compartment (extensions.ts).
 */
export function buildMyneKeymap(
  overrides: Readonly<Record<string, readonly string[]>> = {},
): KeyBinding[] {
  const out: KeyBinding[] = [];
  for (const b of REBINDABLE_EDITOR_BINDINGS) {
    const keys = overrides[b.id] ?? b.defaultKeys;
    for (const key of keys) {
      out.push(
        b.preventDefault ? { key, run: b.run, preventDefault: true } : { key, run: b.run },
      );
    }
  }
  return out;
}

// The DEFAULT editor keymap (no overrides) plus the two fixed, non-rebindable
// bindings the panel never lists — kept as a named export because the test suite
// and the vim keymap tests mount `keymap.of([...myneKeyBindings])` directly and
// rely on Mod-b…Mod-d + Escape being present.
export const myneKeyBindings: readonly KeyBinding[] = [
  ...buildMyneKeymap(),
  // Multi-cursor (MYND-306) story 6: Escape collapses a multi-selection back to a
  // single cursor. Guarded (no-op + fall-through when already a single range) so
  // it never shadows the search-bar/menu Escape. Fixed (widget-nav, not listed).
  { key: "Escape", run: collapseMultiSelection },
];
