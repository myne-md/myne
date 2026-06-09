// Concrete command-action set for the v1 command palette.
//
// Five actions per MYND-86 acceptance: Lock vault, Open settings, Switch to
// note, Import Obsidian vault, Convert wikilinks in this note.
//
// Two of the five are intentionally `disabled` stubs in v1.0 — the
// underlying features ship in their own future PRDs. They appear in the
// palette so the discoverable surface is honest about what's coming; per
// the work item: "palette never exposes actions unavailable in the
// current state" — these stubs ARE "available in the current state"
// (they don't depend on stage), they're just not yet built.

import type { CommandAction } from "./registry";

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
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onOpenSettings();
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
  label: "Convert wikilinks in this note…",
  category: "Editor",
  disabledHint: "Ships in editor-mvp-wikilinks",
  visibility: (ctx) =>
    ctx.stageName === "editor" && ctx.selectedNoteId !== null
      ? "disabled"
      : "hidden",
  run: () => {
    // No-op while disabled.
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

const showGraphAction: CommandAction = {
  id: "graph.show",
  label: "Show graph view…",
  category: "Editor",
  kbd: "⌘⇧G",
  // Editor-only, like the other modal carve-outs. The whole-vault graph is a
  // wedge-first-class surface, so it ALSO has a persistent BottomBar affordance
  // (SYNC-7) — the palette action is one of two entry points, not the only one.
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onShowGraph();
  },
};

export const COMMAND_ACTIONS: readonly CommandAction[] = Object.freeze([
  lockVaultAction,
  openSettingsAction,
  newNoteFromTemplateAction,
  openTodayNoteAction,
  manageTemplatesAction,
  openAttachmentsAction,
  openSnapshotsAction,
  showGraphAction,
  importObsidianAction,
  convertWikilinksAction,
]);
