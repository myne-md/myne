// Display catalog of keyboard-bindable commands for the Hotkeys settings panel
// (hotkeys epic, MYND-304; hotkeys-panel-view). The single source the panel (#3)
// + rebind flow (#4) read to list/search/rebind shortcuts. Each entry carries
// DISPLAY metadata (label, group, default chord) + a `rebindable` flag; the
// actual dispatch lives in the window keybind engine (window commands) or the
// EDITOR keymap Compartment (editor-formatting + undo/indent/select, #184) — the
// catalog does not run anything. The editor ids here mirror
// `@myne/editor`'s `EDITOR_KEYMAP_DEFAULTS` verbatim (a drift test pins them
// equal), and `vault.prefs.keymap` overrides feed BOTH the window dispatcher and
// the editor keymap builder, so a rebind of either kind takes effect with no
// other change.
//
// Bindings shown are the effective ones (`override ?? default`); the override
// comes from `vault.prefs.keymap` keyed by `id` (commands/keymap.ts). Grouping
// is panel-local (the registry `CommandAction.category` is left untouched — grill
// Q1). Widget-internal nav keys (modal/palette Esc/Enter/Tab/Arrows) are
// EXCLUDED (grill Q2). #184 made the editor-formatting group + undo/redo/indent/
// outdent/select-next rebindable (previously "fixed, SYNC-9"); the ONE remaining
// fixed row is Ctrl+Tab (`pane.cycle-tab`) — a cross-platform literal-Ctrl chord
// the `Mod`-token chord layer cannot yet distinctly represent on non-mac (its
// dispatch stays the inline handler in Editor.tsx).

import i18n from "../i18n";

export type BindGroup =
  | "General"
  | "Notes"
  | "Panes & Tabs"
  | "Navigation"
  | "View"
  | "Editor formatting";

export interface BindableCommand {
  /** Stable id — the keymap override key (SYNC-4) for rebindable entries. */
  id: string;
  /** Human label shown in the panel row. */
  label: string;
  /** Panel-local display group. */
  group: BindGroup;
  /** In-code default chords (canonical SYNC-1 form). */
  defaultBindings: string[];
  /**
   * Whether the user can rebind this command. `false` rows render as fixed
   * (CodeMirror editor-formatting, SYNC-9; and the literal-Ctrl Ctrl+Tab).
   */
  rebindable: boolean;
}

// Order within the array is the in-group display order.
export const BINDABLE_COMMANDS: readonly BindableCommand[] = [
  // General
  // command-palette (MYND-86 + MYND-40): the unified palette toggle. Cmd/Ctrl+K
  // and Cmd/Ctrl+P both open the same palette by default — two conventional
  // chords (command-palette vs quick-open) folded onto one command. Rebindable
  // like any other window command (was a hardcoded window listener before).
  { id: "palette.toggle", get label() { return i18n.t("commands.hotkeys.command.paletteToggle"); }, group: "General", defaultBindings: ["Mod-k", "Mod-p"], rebindable: true },
  { id: "app.open-settings", get label() { return i18n.t("commands.hotkeys.command.openSettings"); }, group: "General", defaultBindings: ["Mod-,"], rebindable: true },
  // In-note find (MYND-175 → #184): was a hardcoded window listener with no
  // catalog entry; now an engine command so it is listed + rebindable. App.tsx
  // still suppresses the WebView's native Cmd+F app-wide (the engine only opens
  // the bar on the editor stage).
  { id: "find.open", get label() { return i18n.t("commands.hotkeys.command.findInNote"); }, group: "General", defaultBindings: ["Mod-f"], rebindable: true },

  // Notes
  // Two default chords: Mod-t (new-tab convention) + Mod-n (the OS "new" chord,
  // formerly a separate hardcoded Cmd+N listener, folded in here — #184 C).
  { id: "note.new-tab", get label() { return i18n.t("commands.hotkeys.command.newNote"); }, group: "Notes", defaultBindings: ["Mod-t", "Mod-n"], rebindable: true },

  // Panes & Tabs
  { id: "pane.close-tab", get label() { return i18n.t("commands.hotkeys.command.closeTab"); }, group: "Panes & Tabs", defaultBindings: ["Mod-w"], rebindable: true },
  { id: "pane.split-row", get label() { return i18n.t("commands.hotkeys.command.splitPaneRight"); }, group: "Panes & Tabs", defaultBindings: ["Mod-\\"], rebindable: true },
  // `Mod-Shift-|`, not `Mod-Shift-\` (myne#337). The chord a keydown produces is
  // built from `keyName(event)`, which reports the SHIFTED character — so
  // Shift+`\` arrives as `|` on every platform, and the stored `Mod-Shift-\`
  // could never match. The shortcut was dead while the Hotkeys panel, the
  // command palette and the conflict detector all presented it as live; its
  // unshifted sibling `Mod-\` works, which is why the pair read as "split right
  // works, split down is broken".
  { id: "pane.split-column", get label() { return i18n.t("commands.hotkeys.command.splitPaneDown"); }, group: "Panes & Tabs", defaultBindings: ["Mod-Shift-|"], rebindable: true },
  { id: "pane.focus-next", get label() { return i18n.t("commands.hotkeys.command.focusNextPane"); }, group: "Panes & Tabs", defaultBindings: ["Mod-Alt-ArrowRight", "Mod-Alt-ArrowDown"], rebindable: true },
  { id: "pane.focus-prev", get label() { return i18n.t("commands.hotkeys.command.focusPrevPane"); }, group: "Panes & Tabs", defaultBindings: ["Mod-Alt-ArrowLeft", "Mod-Alt-ArrowUp"], rebindable: true },
  { id: "pane.cycle-tab", get label() { return i18n.t("commands.hotkeys.command.cycleTabs"); }, group: "Panes & Tabs", defaultBindings: ["Ctrl-Tab"], rebindable: false },

  // Navigation
  { id: "nav.back", get label() { return i18n.t("commands.hotkeys.command.navigateBack"); }, group: "Navigation", defaultBindings: ["Mod-["], rebindable: true },
  { id: "nav.forward", get label() { return i18n.t("commands.hotkeys.command.navigateForward"); }, group: "Navigation", defaultBindings: ["Mod-]"], rebindable: true },
  // The three-region keyboard model (myne#728). Tab keeps indenting inside the
  // note, which is why the editor body had no keyboard exit at all; these are
  // the exit. F6 is the platform convention for "next pane group" (Windows,
  // GNOME, Firefox and Chrome all use it) and is free in this catalog and in
  // `EDITOR_KEYMAP_DEFAULTS`, checked rather than assumed. The three direct
  // commands ship with NO default chord: the cycle is the discoverable path and
  // three more reserved chords would be three more conflicts for a user who
  // never wanted them. They are bindable, which is the point of story 4.
  { id: "focus.cycle-region", get label() { return i18n.t("commands.hotkeys.command.cycleRegion"); }, group: "Navigation", defaultBindings: ["F6"], rebindable: true },
  { id: "focus.sidebar", get label() { return i18n.t("commands.hotkeys.command.focusSidebarRegion"); }, group: "Navigation", defaultBindings: [], rebindable: true },
  { id: "focus.editor", get label() { return i18n.t("commands.hotkeys.command.focusEditorRegion"); }, group: "Navigation", defaultBindings: [], rebindable: true },
  { id: "focus.right-panel", get label() { return i18n.t("commands.hotkeys.command.focusRightPanelRegion"); }, group: "Navigation", defaultBindings: [], rebindable: true },

  // View
  { id: "graph.show", get label() { return i18n.t("commands.hotkeys.command.showGraphView"); }, group: "View", defaultBindings: ["Mod-Shift-g"], rebindable: true },
  // MYND-616. `Mod-Shift-t` was free: Mod-t is new-tab, and Shift-t is unused in
  // both the app catalog and the editor keymap (checked, not assumed).
  { id: "tasks.show", get label() { return i18n.t("commands.hotkeys.command.showTasks"); }, group: "View", defaultBindings: ["Mod-Shift-t"], rebindable: true },
  { id: "calendar.show", get label() { return i18n.t("commands.hotkeys.command.showCalendar"); }, group: "View", defaultBindings: ["Mod-Shift-k"], rebindable: true },
  // reading-source-modes (MYND-299): Edit⇄Reading default Mod-Shift-e (inline-code
  // keeps Mod-e); the secondary live↔source toggle ships with NO default chord.
  { id: "view.toggle-reading", get label() { return i18n.t("commands.hotkeys.command.toggleReadingView"); }, group: "View", defaultBindings: ["Mod-Shift-e"], rebindable: true },
  { id: "view.toggle-source", get label() { return i18n.t("commands.hotkeys.command.toggleSourceMode"); }, group: "View", defaultBindings: [], rebindable: true },
  // focus-mode (MYND-348): distraction-free toggle, default Mod-Shift-f.
  { id: "view.toggle-focus", get label() { return i18n.t("commands.hotkeys.command.toggleFocusMode"); }, group: "View", defaultBindings: ["Mod-Shift-f"], rebindable: true },
  // named-workspaces (MYND-308): no default chord (rebindable only).
  { id: "workspace.save-as", get label() { return i18n.t("commands.hotkeys.command.saveWorkspaceAs"); }, group: "View", defaultBindings: [], rebindable: true },
  { id: "workspace.switch", get label() { return i18n.t("commands.hotkeys.command.switchWorkspace"); }, group: "View", defaultBindings: [], rebindable: true },
  { id: "workspace.rename", get label() { return i18n.t("commands.hotkeys.command.renameWorkspace"); }, group: "View", defaultBindings: [], rebindable: true },
  { id: "workspace.delete", get label() { return i18n.t("commands.hotkeys.command.deleteWorkspace"); }, group: "View", defaultBindings: [], rebindable: true },

  // Editor formatting (#184: now REBINDABLE via the editor keymap Compartment —
  // ids + default chords mirror @myne/editor EDITOR_KEYMAP_DEFAULTS, drift-tested).
  { id: "editor.bold", get label() { return i18n.t("commands.hotkeys.command.bold"); }, group: "Editor formatting", defaultBindings: ["Mod-b"], rebindable: true },
  { id: "editor.italic", get label() { return i18n.t("commands.hotkeys.command.italic"); }, group: "Editor formatting", defaultBindings: ["Mod-i"], rebindable: true },
  { id: "editor.code", get label() { return i18n.t("commands.hotkeys.command.inlineCode"); }, group: "Editor formatting", defaultBindings: ["Mod-e"], rebindable: true },
  { id: "editor.cycle-heading", get label() { return i18n.t("commands.hotkeys.command.cycleHeadingLevel"); }, group: "Editor formatting", defaultBindings: ["Mod-Shift-h"], rebindable: true },
  { id: "editor.ordered-list", get label() { return i18n.t("commands.hotkeys.command.toggleNumberedList"); }, group: "Editor formatting", defaultBindings: ["Mod-Shift-7"], rebindable: true },
  { id: "editor.bullet-list", get label() { return i18n.t("commands.hotkeys.command.toggleBulletList"); }, group: "Editor formatting", defaultBindings: ["Mod-Shift-8"], rebindable: true },
  { id: "editor.task-list", get label() { return i18n.t("commands.hotkeys.command.toggleTaskList"); }, group: "Editor formatting", defaultBindings: ["Mod-Shift-m"], rebindable: true },
  { id: "editor.wikilink", get label() { return i18n.t("commands.hotkeys.command.insertWikilink"); }, group: "Editor formatting", defaultBindings: ["Mod-Shift-l"], rebindable: true },
  { id: "editor.select-all", get label() { return i18n.t("commands.hotkeys.command.selectAllScoped"); }, group: "Editor formatting", defaultBindings: ["Mod-a"], rebindable: true },
  // Multi-cursor (MYND-306): add the next occurrence of the selection.
  { id: "editor.select-next", get label() { return i18n.t("commands.hotkeys.command.selectNextOccurrence"); }, group: "Editor formatting", defaultBindings: ["Mod-d"], rebindable: true },
  // Heading/list folding (MYND-300). Per-fold is the gutter click.
  { id: "editor.fold-all", get label() { return i18n.t("commands.hotkeys.command.foldAll"); }, group: "Editor formatting", defaultBindings: ["Mod-Alt-["], rebindable: true },
  { id: "editor.unfold-all", get label() { return i18n.t("commands.hotkeys.command.unfoldAll"); }, group: "Editor formatting", defaultBindings: ["Mod-Alt-]"], rebindable: true },
  // History + indentation (#184: formerly historyKeymap / indentWithTab, now
  // override-driven). redo carries both conventions (Mod-y + Mod-Shift-z).
  { id: "editor.undo", get label() { return i18n.t("commands.hotkeys.command.undo"); }, group: "Editor formatting", defaultBindings: ["Mod-z"], rebindable: true },
  { id: "editor.redo", get label() { return i18n.t("commands.hotkeys.command.redo"); }, group: "Editor formatting", defaultBindings: ["Mod-y", "Mod-Shift-z"], rebindable: true },
  { id: "editor.indent", get label() { return i18n.t("commands.hotkeys.command.indent"); }, group: "Editor formatting", defaultBindings: ["Tab"], rebindable: true },
  { id: "editor.outdent", get label() { return i18n.t("commands.hotkeys.command.outdent"); }, group: "Editor formatting", defaultBindings: ["Shift-Tab"], rebindable: true },
];

/** The display groups in panel order. */
export const BIND_GROUPS: readonly BindGroup[] = [
  "General",
  "Notes",
  "Panes & Tabs",
  "Navigation",
  "View",
  "Editor formatting",
];

/** In-code defaults keyed by id — feeds the effective-keymap merge for the panel. */
export function catalogDefaults(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const c of BINDABLE_COMMANDS) out[c.id] = c.defaultBindings;
  return out;
}
