// Concrete command-action set for the v1 command palette.
//
// Five actions per MYND-86 acceptance: Lock vault, Open settings, Switch to
// note, Import Obsidian vault, Convert wikilinks in this note.
//
// "Convert imported wikilinks in this note" went live in MYND-84 (R2, §7.1).
// Any remaining `disabled` stub ships in its own future PRD — it appears in the
// palette so the discoverable surface is honest about what's coming; per the
// work item: "palette never exposes actions unavailable in the current state"
// — such a stub IS "available in the current state" (it doesn't depend on
// stage), it's just not yet built.

import type { CommandAction } from "./registry";
import { runWikilinkConvert } from "../editor/wikilink/convert-command";
import { foldAll, unfoldAll } from "@codemirror/language";
import { getActiveEditorView } from "../editor/active-view";

const lockVaultAction: CommandAction = {
  id: "vault.lock",
  label: "Lock vault",
  category: "Vault",
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: async (ctx) => {
    await ctx.onLock();
  },
};

const openSettingsAction: CommandAction = {
  id: "app.open-settings",
  label: "Open settings…",
  category: "App",
  kbd: "⌘,",
  defaultBinding: "Mod-,",
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onOpenSettings();
  },
};

const backupVaultAction: CommandAction = {
  id: "vault.backup",
  label: "Back up vault…",
  category: "Vault",
  // Editor-stage guarded like the importer entry: the flow's natural home
  // is the unlocked session (and the unlocked export records
  // `last_backup_at` — spec §9.5.2).
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onBackupVault();
  },
};

const exportVaultMarkdownAction: CommandAction = {
  id: "vault.export-markdown",
  label: "Export vault as Markdown…",
  category: "Vault",
  // Editor-stage guarded, vault-level (no note selection needed): the
  // plaintext tree export requires an unlocked vault, and the editor is the
  // only stage that satisfies that. Opens the SAME three-phase modal as the
  // Settings → Storage Export block (MYND-211) — zero divergence.
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onExportVaultMarkdown();
  },
};

const importObsidianAction: CommandAction = {
  id: "vault.import-obsidian",
  label: "Import Obsidian vault…",
  category: "Vault",
  // Enabled on the PR that lands the importer backend + UI (MYND-53), per the
  // established disabled-control discipline. Editor-stage guarded: import
  // requires an unlocked vault (note_create is Slot::Unlocked-gated), and the
  // editor is the only stage that satisfies that.
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onImportObsidian();
  },
};

const manageTemplatesAction: CommandAction = {
  id: "templates.manage",
  label: "Manage templates…",
  category: "Editor",
  // Editor-only, like Open settings — the management surface mounts inside the
  // Editor (modal carve-out). Free + local; no paywall, no hosted-sync gate.
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onManageTemplates();
  },
};

const newNoteFromTemplateAction: CommandAction = {
  id: "templates.new-note",
  label: "New note from template…",
  category: "Editor",
  // Editor-only; opens the picker → prompt-first name → render+create flow. The
  // instant-blank path (bare Cmd+N + the five instant-create surfaces) is
  // untouched — this is the deliberate, opt-in template path (split-path).
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onNewNoteFromTemplate();
  },
};

const openTodayNoteAction: CommandAction = {
  id: "daily.open-today",
  label: "Open today's note",
  category: "Editor",
  // Idempotent open-or-create over ordinary notes (folder + date-title key).
  // Palette-only in v1 — no sidebar button, no built-in hotkey; past days are
  // reached via the ordinary Daily/ sidebar folder (no calendar, no date-picker).
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onOpenTodayNote();
  },
};

const randomNoteAction: CommandAction = {
  id: "notes.random",
  label: "Open random note",
  category: "Editor",
  // Editor-only like "Open today's note" (MYND-323): serendipitous review opens
  // a random live, non-template note. The empty-vault case shows a toast at run
  // time (never a modal), so visibility stays a simple stage guard.
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onOpenRandomNote();
  },
};

const openAttachmentsAction: CommandAction = {
  id: "attachments.open",
  label: "Open attachments…",
  category: "Editor",
  // Editor-only, like Open settings — the library is a full-pane center-pane
  // view inside the Editor (SYNC-9), not a Stage. Free + local.
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onOpenAttachments();
  },
};

const convertWikilinksAction: CommandAction = {
  id: "wikilinks.convert-in-this-note",
  label: "Convert imported wikilinks in this note…",
  category: "Editor",
  // R2 (MYND-84): per-note conversion of imported title-only wikilinks to the
  // canonical §3 path form, with a mandatory diff preview. Editor-only + per-note
  // (acts on the active buffer); the empty case shows a toast, never a modal.
  visibility: (ctx) =>
    ctx.stageName === "editor" && ctx.selectedNoteId !== null ? "show" : "hidden",
  run: () => {
    void runWikilinkConvert();
  },
};

const foldAllAction: CommandAction = {
  id: "editor.fold-all",
  label: "Fold all",
  category: "Editor",
  kbd: "⌘⌥[",
  defaultBinding: "Mod-Alt-[",
  // Editor-only; reaches the focused pane's view directly via getActiveEditorView()
  // (the convertWikilinksAction pattern) — folding is ephemeral CM6 state, so no
  // CommandContext callback is threaded through React. foldAll/unfoldAll are the
  // CM Commands; this is the palette twin of the Mod-Alt-[/] keymap entries.
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: () => {
    const view = getActiveEditorView();
    if (view !== null) foldAll(view);
  },
};

const unfoldAllAction: CommandAction = {
  id: "editor.unfold-all",
  label: "Unfold all",
  category: "Editor",
  kbd: "⌘⌥]",
  defaultBinding: "Mod-Alt-]",
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: () => {
    const view = getActiveEditorView();
    if (view !== null) unfoldAll(view);
  },
};

const openSnapshotsAction: CommandAction = {
  id: "snapshots.open",
  label: "Snapshots…",
  category: "Editor",
  // Editor-only and per-note: the panel is scoped to the selected note, so it is
  // hidden when nothing is selected (MYND-97).
  visibility: (ctx) =>
    ctx.stageName === "editor" && ctx.selectedNoteId !== null
      ? "show"
      : "hidden",
  run: (ctx) => {
    ctx.onOpenSnapshots();
  },
};

const exportNoteMarkdownAction: CommandAction = {
  id: "note.export-markdown",
  label: "Export note as Markdown…",
  category: "Editor",
  // Editor-only and per-note like Snapshots (MYND-97): the flow exports the
  // SELECTED note, so it is hidden when nothing is open. Runs the exact same
  // shared flow as the sidebar context-menu item (src/notes/exportFlow.ts) —
  // deliberate plaintext egress (TB3); the OS save dialog is the consent.
  visibility: (ctx) =>
    ctx.stageName === "editor" && ctx.selectedNoteId !== null
      ? "show"
      : "hidden",
  run: (ctx) => {
    ctx.onExportNoteMarkdown();
  },
};

const exportNotePdfAction: CommandAction = {
  id: "note.export-pdf",
  label: "Export note as PDF…",
  category: "Editor",
  // Sibling of note.export-markdown with the SAME visibility rules
  // (MYND-255, SYNC-5): editor stage AND a selected note, else hidden.
  // Runs the exact same shared flow as the sidebar context-menu item
  // (src/notes/exportFlow.ts::runNotePdfExportFlow) — deliberate
  // plaintext egress (TB3); the OS save dialog is the consent.
  visibility: (ctx) =>
    ctx.stageName === "editor" && ctx.selectedNoteId !== null
      ? "show"
      : "hidden",
  run: (ctx) => {
    ctx.onExportNotePdf();
  },
};

const exportNoteHtmlAction: CommandAction = {
  id: "note.export-html",
  label: "Export note as HTML…",
  category: "Editor",
  // Sibling of note.export-markdown / note.export-pdf with the SAME
  // visibility rules (MYND-340): editor stage AND a selected note, else
  // hidden. Runs the exact same shared flow as the sidebar context-menu
  // item (src/notes/exportFlow.ts::runNoteHtmlExportFlow) — deliberate
  // plaintext egress (TB3); the OS save dialog is the consent.
  visibility: (ctx) =>
    ctx.stageName === "editor" && ctx.selectedNoteId !== null
      ? "show"
      : "hidden",
  run: (ctx) => {
    ctx.onExportNoteHtml();
  },
};

const exportNoteTxtAction: CommandAction = {
  id: "note.export-txt",
  label: "Export note as Plain Text…",
  category: "Editor",
  // Sibling of the other per-note export actions (MYND-340): editor stage
  // AND a selected note. Runs the shared
  // src/notes/exportFlow.ts::runNoteTxtExportFlow — deliberate plaintext
  // egress (TB3); the OS save dialog is the consent.
  visibility: (ctx) =>
    ctx.stageName === "editor" && ctx.selectedNoteId !== null
      ? "show"
      : "hidden",
  run: (ctx) => {
    ctx.onExportNoteTxt();
  },
};

const showGraphAction: CommandAction = {
  id: "graph.show",
  label: "Show graph view…",
  category: "Editor",
  kbd: "⌘⇧G",
  defaultBinding: "Mod-Shift-g",
  // Editor-only, like the other modal carve-outs. The whole-vault graph is a
  // wedge-first-class surface, so it ALSO has a persistent BottomBar affordance
  // (SYNC-7) — the palette action is one of two entry points, not the only one.
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onShowGraph();
  },
};

const showTagsAction: CommandAction = {
  id: "tags.show",
  label: "Browse tags…",
  category: "Editor",
  // Editor-only, like the other modal carve-outs. A navigation surface reached
  // often, so it ALSO has a persistent BottomBar affordance (SYNC-7 refinement,
  // tag-system #2) — the palette action is one of two entry points.
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onShowTags();
  },
};

const importBaseViewAction: CommandAction = {
  id: "views.import-base",
  label: "Import .base view…",
  category: "Vault",
  // Live as of Saved Views #6 (MYND-276, task 6): the file-picker → parse → map →
  // persist → SYNC-12 import-summary tally dispatch now lands. Editor-stage only
  // (import needs an unlocked vault); hidden elsewhere, mirroring
  // importObsidianAction.
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onImportBaseView();
  },
};

const showViewsAction: CommandAction = {
  id: "views.show",
  label: "Browse views…",
  category: "Editor",
  // Editor-only, like the other navigation entries. The Saved Views surface is
  // reached often, so it ALSO has a persistent BottomBar affordance (SYNC-7
  // dual-entry, Saved Views #4) — the palette action is one of two entry points.
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onShowViews();
  },
};

const toggleLeftSidebarAction: CommandAction = {
  id: "view.toggle-notes-sidebar",
  label: "Toggle notes sidebar",
  category: "View",
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onToggleLeftSidebar();
  },
};

const toggleRightSidebarAction: CommandAction = {
  id: "view.toggle-backlinks-sidebar",
  label: "Toggle backlinks sidebar",
  category: "View",
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onToggleRightSidebar();
  },
};

const toggleStackedTabsAction: CommandAction = {
  id: "view.toggle-stacked-tabs",
  label: "Toggle stacked tabs",
  category: "View",
  // tab-modes (MYND-319): per-leaf-pane layout flag on the FOCUSED pane — the
  // palette is the sole entry point (no pane-header chrome this slice). Editor-
  // only like the other view toggles; the pane state is always present there.
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onToggleStackedTabs();
  },
};

const toggleReadingAction: CommandAction = {
  id: "view.toggle-reading",
  label: "Toggle reading view",
  category: "View",
  kbd: "⇧⌘E",
  // reading-source-modes (MYND-299): Edit ⇄ Reading on the focused note tab. The
  // live chord fires through the WorkspaceHotkeys keybind entry + catalog default
  // (Mod-Shift-e); this `defaultBinding` is the palette display hint (SYNC-4).
  defaultBinding: "Mod-Shift-e",
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onToggleReading();
  },
};

const toggleSourceAction: CommandAction = {
  id: "view.toggle-source",
  label: "Toggle source mode",
  category: "View",
  // Secondary live ⇄ source toggle on the focused note tab. No default chord
  // (grill D2) — palette + the bottom-bar switcher are its entry points.
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onToggleSource();
  },
};

const toggleFocusAction: CommandAction = {
  id: "view.toggle-focus",
  label: "Toggle focus mode",
  category: "View",
  kbd: "⇧⌘F",
  // focus-mode (MYND-348): distraction-free toggle. Live chord fires through the
  // WorkspaceHotkeys keybind entry + catalog default (Mod-Shift-f); this
  // `defaultBinding` is the palette display hint (SYNC-4).
  defaultBinding: "Mod-Shift-f",
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onToggleFocus();
  },
};

// named-workspaces (MYND-308): save-as / switch / rename / delete the active
// named workspace. No default chord (deliberately none — rebindable only,
// catalog `defaultBindings: []`); the bottom-bar dropdown is the discoverable
// twin entry point. Editor-only like the other view commands.
const saveWorkspaceAsAction: CommandAction = {
  id: "workspace.save-as",
  label: "Save workspace as…",
  category: "View",
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onSaveWorkspaceAs();
  },
};

const switchWorkspaceAction: CommandAction = {
  id: "workspace.switch",
  label: "Switch workspace…",
  category: "View",
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onSwitchWorkspace();
  },
};

const renameWorkspaceAction: CommandAction = {
  id: "workspace.rename",
  label: "Rename workspace…",
  category: "View",
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onRenameWorkspace();
  },
};

const deleteWorkspaceAction: CommandAction = {
  id: "workspace.delete",
  label: "Delete workspace…",
  category: "View",
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onDeleteWorkspace();
  },
};

export const COMMAND_ACTIONS: readonly CommandAction[] = Object.freeze([
  lockVaultAction,
  openSettingsAction,
  toggleLeftSidebarAction,
  toggleRightSidebarAction,
  toggleStackedTabsAction,
  toggleReadingAction,
  toggleSourceAction,
  toggleFocusAction,
  saveWorkspaceAsAction,
  switchWorkspaceAction,
  renameWorkspaceAction,
  deleteWorkspaceAction,
  newNoteFromTemplateAction,
  openTodayNoteAction,
  randomNoteAction,
  manageTemplatesAction,
  openAttachmentsAction,
  foldAllAction,
  unfoldAllAction,
  openSnapshotsAction,
  exportNoteMarkdownAction,
  exportNotePdfAction,
  exportNoteHtmlAction,
  exportNoteTxtAction,
  showGraphAction,
  showTagsAction,
  showViewsAction,
  importBaseViewAction,
  importObsidianAction,
  backupVaultAction,
  exportVaultMarkdownAction,
  convertWikilinksAction,
]);
