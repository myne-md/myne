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

const switchToNoteAction: CommandAction = {
  id: "note.switch",
  label: "Switch to note…",
  category: "Navigation",
  // The palette UI special-cases this id and replaces the action list with
  // a note-picker view when invoked. Hidden when not in editor stage OR
  // when the title cache is empty (no notes yet — the only path is to
  // create one via Cmd+N).
  visibility: (ctx) =>
    ctx.stageName === "editor" && ctx.noteTitles.size > 0 ? "show" : "hidden",
  run: () => {
    // No-op: the palette UI intercepts this action and switches to the
    // note-picker view instead of calling `run`. The `run` is a fallback
    // for unusual invocation paths (e.g., synthetic test dispatch).
  },
};

const importObsidianAction: CommandAction = {
  id: "vault.import-obsidian",
  label: "Import Obsidian vault…",
  category: "Vault",
  disabledHint: "Ships in Phase 1.x",
  visibility: () => "disabled",
  run: () => {
    // No-op while disabled.
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

export const COMMAND_ACTIONS: readonly CommandAction[] = Object.freeze([
  lockVaultAction,
  openSettingsAction,
  switchToNoteAction,
  importObsidianAction,
  convertWikilinksAction,
]);
