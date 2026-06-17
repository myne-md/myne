// Display catalog of keyboard-bindable commands for the Hotkeys settings panel
// (hotkeys epic, MYND-304; hotkeys-panel-view). The single source the panel (#3)
// + rebind flow (#4) read to list/search/rebind shortcuts. Each entry carries
// DISPLAY metadata (label, group, default chord) + a `rebindable` flag; the
// actual dispatch lives in the engine (window commands) or CodeMirror's keymap
// (the fixed editor-formatting rows, SYNC-9) — the catalog does not run anything.
//
// Bindings shown are the effective ones (`override ?? default`); the override
// comes from `vault.prefs.keymap` keyed by `id` (commands/keymap.ts). Grouping
// is panel-local (the registry `CommandAction.category` is left untouched — grill
// Q1). Widget-internal nav keys (modal/palette Esc/Enter/Tab/Arrows) are
// EXCLUDED (grill Q2); Ctrl+Tab is shown as a fixed row (literal-Ctrl, not in the
// rebindable keymap — see keybind-engine task 4).

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
  { id: "app.open-settings", label: "Open settings", group: "General", defaultBindings: ["Mod-,"], rebindable: true },

  // Notes
  { id: "note.new-tab", label: "New note", group: "Notes", defaultBindings: ["Mod-t"], rebindable: true },

  // Panes & Tabs
  { id: "pane.close-tab", label: "Close tab", group: "Panes & Tabs", defaultBindings: ["Mod-w"], rebindable: true },
  { id: "pane.split-row", label: "Split pane (right)", group: "Panes & Tabs", defaultBindings: ["Mod-\\"], rebindable: true },
  { id: "pane.split-column", label: "Split pane (down)", group: "Panes & Tabs", defaultBindings: ["Mod-Shift-\\"], rebindable: true },
  { id: "pane.focus-next", label: "Focus next pane", group: "Panes & Tabs", defaultBindings: ["Mod-Alt-ArrowRight", "Mod-Alt-ArrowDown"], rebindable: true },
  { id: "pane.focus-prev", label: "Focus previous pane", group: "Panes & Tabs", defaultBindings: ["Mod-Alt-ArrowLeft", "Mod-Alt-ArrowUp"], rebindable: true },
  { id: "pane.cycle-tab", label: "Cycle tabs", group: "Panes & Tabs", defaultBindings: ["Ctrl-Tab"], rebindable: false },

  // Navigation
  { id: "nav.back", label: "Navigate back", group: "Navigation", defaultBindings: ["Mod-["], rebindable: true },
  { id: "nav.forward", label: "Navigate forward", group: "Navigation", defaultBindings: ["Mod-]"], rebindable: true },

  // View
  { id: "graph.show", label: "Show graph view", group: "View", defaultBindings: ["Mod-Shift-g"], rebindable: true },

  // Editor formatting (CodeMirror-owned, SYNC-9 — fixed, not rebindable yet)
  { id: "editor.bold", label: "Bold", group: "Editor formatting", defaultBindings: ["Mod-b"], rebindable: false },
  { id: "editor.italic", label: "Italic", group: "Editor formatting", defaultBindings: ["Mod-i"], rebindable: false },
  { id: "editor.code", label: "Inline code", group: "Editor formatting", defaultBindings: ["Mod-e"], rebindable: false },
  { id: "editor.cycle-heading", label: "Cycle heading level", group: "Editor formatting", defaultBindings: ["Mod-Shift-h"], rebindable: false },
  { id: "editor.ordered-list", label: "Toggle numbered list", group: "Editor formatting", defaultBindings: ["Mod-Shift-7"], rebindable: false },
  { id: "editor.bullet-list", label: "Toggle bullet list", group: "Editor formatting", defaultBindings: ["Mod-Shift-8"], rebindable: false },
  { id: "editor.task-list", label: "Toggle task list", group: "Editor formatting", defaultBindings: ["Mod-Shift-m"], rebindable: false },
  { id: "editor.wikilink", label: "Insert wikilink", group: "Editor formatting", defaultBindings: ["Mod-Shift-l"], rebindable: false },
  { id: "editor.select-all", label: "Select all (scoped)", group: "Editor formatting", defaultBindings: ["Mod-a"], rebindable: false },
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
