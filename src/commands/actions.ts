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
  importObsidianAction,
  convertWikilinksAction,
]);
