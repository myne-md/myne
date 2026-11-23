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
import type { IconName } from "../lib/icons";
import * as capabilities from "../platform/capabilities";
import { runWikilinkConvert } from "../editor/wikilink/convert-command";
import { foldAll, unfoldAll } from "@codemirror/language";
import { getActiveEditorView } from "../editor/active-view";
import { exportSelectionAsImage } from "../lib/noteImageExport";
import { showAttachmentToast } from "../editor/attachments/toast";
import { openInNoteFind } from "../editor/find/find-session";
import { cycleHeading, pickAndInsert, runImportAndConvert } from "@myne/editor";
import { sidebarCommands } from "../notes/sidebarCommands";
import { enterRegion } from "../lib/regions";
import { appDataDir, join } from "../platform/path";
import { openPath } from "../platform/opener";
import { activeVaultId } from "../lib/vault-list";
import {
  setEditorLineNumbers,
  setEditorVimMode,
  setSpellEnabled,
  setAiEnabled,
  setArchiveDisabled,
  setShowNoteTimestamps,
  setEditorFocusTypewriter,
  setEditorFocusDimInactive,
  setEditorFontFamily,
  setEditorTextSize,
  setEditorContentWidth,
  setEditorDefaultViewMode,
  setTheme,
  setCustomTheme,
  type ThemeChoice,
} from "../lib/prefs";
import { applyTheme } from "../lib/theme";
import { screenCaptureOverrideIsActive } from "../hooks/useScreenCaptureOverride";
import { applyScreenCaptureSetting } from "../lib/screen-capture-override";
import { viewsEnabled } from "../lib/viewsEnabled";
import i18n from "../i18n";

/** Next element after `current` (or `fallback` when unset) in a cyclic list. */
function cycleNext<T>(order: readonly T[], current: T | null | undefined, fallback: T): T {
  const i = order.indexOf((current ?? fallback) as T);
  return order[(i + 1) % order.length]!;
}

/** Editor-stage-only visibility (the palette is editor-stage anyway; keeps the
 *  action hidden on lock/unlock screens). */
const editorOnly = (ctx: { stageName: string }): "show" | "hidden" =>
  ctx.stageName === "editor" ? "show" : "hidden";

// ─── Wave 1: preference toggles / cycles + theme (palette-gap audit) ───────
// Self-contained: read the current value from `ctx.prefs`, compute the next,
// call the module-level `set*` setter (the same IPC the Settings panels use, so
// the change applies live via the prefs nonce). No CommandContext callback.

const toggleLineNumbersAction: CommandAction = {
  id: "editor.toggle-line-numbers",
  get label() {
    return i18n.t("commands.actions.toggleLineNumbers.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
  visibility: editorOnly,
  run: (ctx) => {
    void setEditorLineNumbers(!(ctx.prefs.editor_line_numbers ?? false));
  },
};

const toggleVimModeAction: CommandAction = {
  id: "editor.toggle-vim-mode",
  get label() {
    return i18n.t("commands.actions.toggleVimMode.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
  // Developer-mode gated (#181), for the reason the AI actions below are:
  // Settings hides the vim toggle while the mode is off, and a palette entry
  // that still flips it would reopen the door the gate just closed. Developer
  // mode covers three surfaces at once — the rail, settings search and this
  // registry — and one of them left open makes the other two decorative.
  // Hidden, not disabled: the action does not exist for a default user.
  visibility: (ctx) => (ctx.stageName === "editor" && ctx.prefs.developer_mode ? "show" : "hidden"),
  run: (ctx) => {
    void setEditorVimMode(!(ctx.prefs.editor_vim_mode ?? false));
  },
};

const toggleSpellCheckAction: CommandAction = {
  id: "editor.toggle-spell-check",
  get label() {
    return i18n.t("commands.actions.toggleSpellCheck.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
  visibility: editorOnly,
  run: (ctx) => {
    void setSpellEnabled(!(ctx.prefs.spell_enabled ?? true));
  },
};

const toggleTypewriterAction: CommandAction = {
  id: "editor.toggle-typewriter",
  get label() {
    return i18n.t("commands.actions.toggleTypewriter.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
  visibility: editorOnly,
  run: (ctx) => {
    void setEditorFocusTypewriter(!(ctx.prefs.editor_focus_typewriter ?? true));
  },
};

const toggleDimInactiveAction: CommandAction = {
  id: "editor.toggle-dim-inactive",
  get label() {
    return i18n.t("commands.actions.toggleDimInactive.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
  visibility: editorOnly,
  run: (ctx) => {
    void setEditorFocusDimInactive(!(ctx.prefs.editor_focus_dim_inactive ?? true));
  },
};

const toggleEditorFontAction: CommandAction = {
  id: "editor.toggle-font",
  get label() {
    return i18n.t("commands.actions.toggleEditorFont.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
  visibility: editorOnly,
  run: (ctx) => {
    void setEditorFontFamily(ctx.prefs.editor_font_family === "sans" ? "mono" : "sans");
  },
};

const EDITOR_TEXT_SIZES = ["sm", "md", "lg", "xl"] as const;
const cycleTextSizeAction: CommandAction = {
  id: "editor.cycle-text-size",
  get label() {
    return i18n.t("commands.actions.cycleTextSize.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
  visibility: editorOnly,
  run: (ctx) => {
    void setEditorTextSize(cycleNext(EDITOR_TEXT_SIZES, ctx.prefs.editor_text_size, "md"));
  },
};

const EDITOR_WIDTHS = ["narrow", "normal", "wide", "full"] as const;
const cycleContentWidthAction: CommandAction = {
  id: "editor.cycle-content-width",
  get label() {
    return i18n.t("commands.actions.cycleContentWidth.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
  visibility: editorOnly,
  run: (ctx) => {
    void setEditorContentWidth(cycleNext(EDITOR_WIDTHS, ctx.prefs.editor_content_width, "normal"));
  },
};

const VIEW_MODES = ["live", "reading", "source"] as const;
const cycleDefaultViewModeAction: CommandAction = {
  id: "editor.cycle-default-view-mode",
  get label() {
    return i18n.t("commands.actions.cycleDefaultViewMode.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
  visibility: editorOnly,
  run: (ctx) => {
    void setEditorDefaultViewMode(cycleNext(VIEW_MODES, ctx.prefs.editor_default_view_mode, "live"));
  },
};

const toggleTimestampsAction: CommandAction = {
  id: "appearance.toggle-timestamps",
  get label() {
    return i18n.t("commands.actions.toggleTimestamps.label");
  },
  get category() {
    return i18n.t("commands.actions.category.appearance");
  },
  visibility: editorOnly,
  run: (ctx) => {
    void setShowNoteTimestamps(!ctx.prefs.show_note_timestamps);
  },
};

const toggleArchivingAction: CommandAction = {
  id: "notes.toggle-archiving",
  get label() {
    return i18n.t("commands.actions.toggleArchiving.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
  visibility: editorOnly,
  run: (ctx) => {
    void setArchiveDisabled(!(ctx.prefs.archive_disabled ?? false));
  },
};

const toggleAiEnabledAction: CommandAction = {
  id: "ai.toggle-enabled",
  get label() {
    return i18n.t("commands.actions.toggleAiEnabled.label");
  },
  get category() {
    return i18n.t("commands.actions.category.app");
  },
  // Developer-mode gated (developer-mode feature, MYND-593): local AI moved
  // behind the Developer group in Settings, so a keyboard shortcut must not
  // be able to flip the opt-in the settings UI no longer offers while the
  // mode is off (PRD story 5). Hidden, not disabled — the point is that this
  // action does not exist for a default user, not that it's greyed out.
  visibility: (ctx) => (ctx.stageName === "editor" && ctx.prefs.developer_mode ? "show" : "hidden"),
  run: (ctx) => {
    void setAiEnabled(!ctx.prefs.ai_enabled);
  },
};

const toggleScreenCaptureAction: CommandAction = {
  id: "app.toggle-screen-capture",
  get label() {
    return i18n.t("commands.actions.toggleScreenCapture.label");
  },
  get category() {
    return i18n.t("commands.actions.category.app");
  },
  // Hidden while the device-local override is on (myne-md/myne#482), the same
  // state that renders the Privacy switch locked. Without this the palette
  // reopens the door the panel just closed: the write lands in `vault.prefs`,
  // reports success, and `screen_capture::resolve` turns it into `false` at the
  // native call, so the user is told protection changed over a window that did
  // not. Hidden rather than disabled because the palette has nowhere to put the
  // helper sentence the panel uses to explain it.
  //
  // The write goes through `applyScreenCaptureSetting` rather than the prefs
  // setter, because the panel's row now writes BOTH halves of the setting
  // (myne-md/myne#482's device file first, then the sealed preference) and a
  // palette that wrote one of them would leave the device in a different state
  // from the panel for the same setting.
  visibility: (ctx) =>
    screenCaptureOverrideIsActive() ? "hidden" : editorOnly(ctx),
  run: (ctx) => {
    void applyScreenCaptureSetting(!ctx.prefs.screen_capture_protection);
  },
};

/** Apply a built-in theme (or System) immediately (DOM) + persist it, clearing
 *  any active custom theme so the built-in fully takes over. */
function applyBuiltinTheme(choice: ThemeChoice | null): void {
  applyTheme(choice);
  void setCustomTheme(null);
  void setTheme(choice);
}

const THEME_CYCLE: readonly (ThemeChoice | null)[] = [null, "light", "dark", "amoled"];
const cycleThemeAction: CommandAction = {
  id: "appearance.cycle-theme",
  ribbon: { icon: "sun" },
  get label() {
    return i18n.t("commands.actions.cycleTheme.label");
  },
  get category() {
    return i18n.t("commands.actions.category.appearance");
  },
  visibility: editorOnly,
  run: (ctx) => {
    // A custom theme reads as `theme: null`; cycling from it lands on Light.
    const current = ctx.prefs.custom_theme != null ? null : ctx.prefs.theme;
    applyBuiltinTheme(cycleNext(THEME_CYCLE, current as ThemeChoice | null, null));
  },
};

function switchThemeAction(
  choice: ThemeChoice | null,
  idSuffix: string,
  labelKey: string,
): CommandAction {
  return {
    id: `appearance.theme-${idSuffix}`,
    get label() {
      return i18n.t(labelKey);
    },
    get category() {
      return i18n.t("commands.actions.category.appearance");
    },
    visibility: editorOnly,
    run: () => applyBuiltinTheme(choice),
  };
}

const switchThemeLightAction = switchThemeAction(
  "light",
  "light",
  "commands.actions.themeLight.label",
);
const switchThemeDarkAction = switchThemeAction("dark", "dark", "commands.actions.themeDark.label");
const switchThemeAmoledAction = switchThemeAction(
  "amoled",
  "amoled",
  "commands.actions.themeAmoled.label",
);
const switchThemeSystemAction = switchThemeAction(
  null,
  "system",
  "commands.actions.themeSystem.label",
);

// Palette-gap #31: open the custom-theme picker (QuickPicker) and apply the
// chosen saved theme. The picker + apply live in `commandCtx.onApplyCustomTheme`
// (needs `listCustomThemes` / `readCustomTheme`, both async IPC).
const applyCustomThemeAction: CommandAction = {
  id: "appearance.apply-custom-theme",
  get label() {
    return i18n.t("commands.actions.applyCustomTheme.label");
  },
  get category() {
    return i18n.t("commands.actions.category.appearance");
  },
  visibility: editorOnly,
  run: (c) => c.onApplyCustomTheme(),
};

// ─── Wave 2: layout / panes / tabs / navigation (palette-gap audit) ────────
// Thin dispatchers to the workspace controller via CommandContext callbacks
// (wired from the workspace in `commandCtx`).

function layoutAction(
  id: string,
  labelKey: string,
  invoke: CommandAction["run"],
): CommandAction {
  return {
    id,
    get label() {
      return i18n.t(labelKey);
    },
    get category() {
      return i18n.t("commands.actions.category.view");
    },
    visibility: editorOnly,
    run: invoke,
  };
}

const splitRightAction = layoutAction("pane.split-right", "commands.actions.splitRight.label", (c) =>
  c.onSplitRight(),
);
const splitDownAction = layoutAction("pane.split-down", "commands.actions.splitDown.label", (c) =>
  c.onSplitDown(),
);
const closePaneAction = layoutAction("pane.close", "commands.actions.closePane.label", (c) =>
  c.onClosePane(),
);
const closeTabAction = layoutAction("tab.close", "commands.actions.closeTab.label", (c) =>
  c.onCloseTab(),
);
const nextTabAction = layoutAction("tab.next", "commands.actions.nextTab.label", (c) => c.onNextTab());
const prevTabAction = layoutAction("tab.prev", "commands.actions.prevTab.label", (c) => c.onPrevTab());
const focusNextPaneAction = layoutAction(
  "pane.focus-next",
  "commands.actions.focusNextPane.label",
  (c) => c.onFocusNextPane(),
);
const focusPrevPaneAction = layoutAction(
  "pane.focus-prev",
  "commands.actions.focusPrevPane.label",
  (c) => c.onFocusPrevPane(),
);
// The three-region keyboard model (myne#728). These take no `CommandContext`
// callback on purpose: entering a region is a DOM operation on the live
// document (`src/lib/regions.ts`), with no workspace state behind it, so
// threading four more callbacks through the context would add a layer that
// only forwards. `enterRegion` also owns the deferral the palette needs - see
// its comment; a synchronous focus move from a palette row is undone by the
// closing modal's focus-trap restore.
const focusSidebarRegionAction = layoutAction(
  "focus.sidebar",
  "commands.actions.focusSidebarRegion.label",
  () => enterRegion("sidebar"),
);
const focusEditorRegionAction = layoutAction(
  "focus.editor",
  "commands.actions.focusEditorRegion.label",
  () => enterRegion("editor"),
);
const focusRightPanelRegionAction = layoutAction(
  "focus.right-panel",
  "commands.actions.focusRightPanelRegion.label",
  () => enterRegion("right-panel"),
);
const cycleRegionAction = layoutAction(
  "focus.cycle-region",
  "commands.actions.cycleRegion.label",
  () => enterRegion("next"),
);
const goBackAction = layoutAction("nav.back", "commands.actions.goBack.label", (c) => c.onGoBack());
const goForwardAction = layoutAction("nav.forward", "commands.actions.goForward.label", (c) =>
  c.onGoForward(),
);
const togglePreviewAction = layoutAction(
  "view.toggle-preview",
  "commands.actions.togglePreview.label",
  (c) => c.onTogglePreview(),
);

// ─── Wave 3: find, note ops, right-panel tabs (palette-gap audit) ──────────

/** Editor-stage AND a selected note. */
const editorWithNote = (ctx: {
  stageName: string;
  selectedNoteId: unknown;
}): "show" | "hidden" =>
  ctx.stageName === "editor" && ctx.selectedNoteId !== null ? "show" : "hidden";

function notesAction(
  id: string,
  labelKey: string,
  invoke: CommandAction["run"],
  needsNote = true,
  ribbonIcon?: IconName,
): CommandAction {
  return {
    id,
    get label() {
      return i18n.t(labelKey);
    },
    get category() {
      return i18n.t("commands.actions.category.notes");
    },
    ...(ribbonIcon !== undefined ? { ribbon: { icon: ribbonIcon } } : {}),
    visibility: needsNote ? editorWithNote : editorOnly,
    run: invoke,
  };
}

const findInNoteAction: CommandAction = {
  id: "editor.find",
  get label() {
    return i18n.t("common.findinnote");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
  visibility: editorOnly,
  run: () => {
    openInNoteFind();
  },
};

const findReplaceAction: CommandAction = {
  id: "editor.find-replace",
  get label() {
    return i18n.t("commands.actions.findReplace.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
  visibility: editorOnly,
  // The find bar carries the replace toggle; opening it is the entry point.
  run: () => {
    openInNoteFind();
  },
};

const newNoteAction = notesAction(
  "note.new",
  "commands.actions.newNote.label",
  (c) => c.onNewNote(),
  false,
  "plus",
);
const duplicateNoteAction = notesAction("note.duplicate", "commands.actions.duplicateNote.label", (c) =>
  c.onDuplicateNote(),
);
const openInNewWindowAction = notesAction(
  "note.open-in-new-window",
  "commands.actions.openInNewWindow.label",
  (c) => c.onOpenInNewWindow(),
);
const archiveNoteAction: CommandAction = {
  id: "note.archive",
  get label() {
    return i18n.t("commands.actions.archiveNote.label");
  },
  get category() {
    return i18n.t("commands.actions.category.notes");
  },
  // The sidebar context menu omits its archive entries while the archive
  // feature is off (`archive_disabled`, NoteList) — mirror that gate here so
  // the palette never offers the disabled surface.
  visibility: (ctx) =>
    editorWithNote(ctx) === "show" && !(ctx.prefs.archive_disabled ?? false)
      ? "show"
      : "hidden",
  run: (c) => c.onArchiveNote(),
};
const renameNoteAction = notesAction("note.rename", "commands.actions.renameNote.label", (c) =>
  c.onRenameNote(),
);
const trashNoteAction = notesAction("note.trash", "commands.actions.trashNote.label", (c) =>
  c.onTrashNote(),
);
const toggleFavoriteAction = notesAction(
  "note.toggle-favorite",
  "commands.actions.toggleFavorite.label",
  (c) => c.onToggleFavorite(),
);
// Palette-gap #32: move the selected note to a folder via the QuickPicker (the
// folder-target list + move live in `commandCtx.onMoveNote`).
const moveNoteAction = notesAction("note.move", "commands.actions.moveNote.label", (c) =>
  c.onMoveNote(),
);
const emptyTrashAction = notesAction(
  "trash.empty",
  "commands.actions.emptyTrash.label",
  (c) => c.onEmptyTrash(c.activatedByKey === true),
  false,
);

const showBacklinksAction = layoutAction(
  "view.show-backlinks",
  "commands.actions.showBacklinks.label",
  (c) => c.onShowBacklinks(),
);
const showOutlineAction = layoutAction(
  "view.show-outline",
  "commands.actions.showOutline.label",
  (c) => c.onShowOutline(),
);
const showUnlinkedAction = layoutAction(
  "view.show-unlinked",
  "commands.actions.showUnlinked.label",
  (c) => c.onShowUnlinked(),
);

// ─── Wave 4: sidebar surfaces + cycle heading + restore + sync (palette-gap) ─

/** Run a sidebar-owned surface handler, expanding the collapsed (`inert`)
 *  sidebar first — a width-forced collapse can't expand (MYND-192), in which
 *  case the surface is skipped rather than ghost-opened. */
function runInSidebar(invoke: () => void): void {
  if (sidebarCommands.revealSidebar?.() === false) return;
  invoke();
}

const newFolderAction = notesAction(
  "folder.new",
  "commands.actions.newFolder.label",
  () => runInSidebar(() => sidebarCommands.newFolder?.()),
  false,
);
const openTrashAction = notesAction(
  "trash.open",
  "commands.actions.openTrash.label",
  () => runInSidebar(() => sidebarCommands.openTrash?.()),
  false,
  "trash-2",
);
const openArchiveAction: CommandAction = {
  id: "archive.open",
  ribbon: { icon: "archive" },
  get label() {
    return i18n.t("commands.actions.openArchive.label");
  },
  get category() {
    return i18n.t("commands.actions.category.notes");
  },
  // Gated on `archive_disabled` the same way `note.archive` is (myne-md/myne#762).
  // The sidebar footer used to keep an Archive row while any archived note still
  // existed, so nothing could be stranded; that row is gone and the rail is the
  // entry point now. Disabling the feature auto-empties the archive, so the
  // stranded case is unreachable in the normal flow, and re-enabling the toggle
  // is what reaches anything a hand-edited pref left behind.
  visibility: (ctx) =>
    ctx.stageName === "editor" && !(ctx.prefs.archive_disabled ?? false)
      ? "show"
      : "hidden",
  run: () => runInSidebar(() => sidebarCommands.openArchive?.()),
};

const cycleHeadingAction: CommandAction = {
  id: "editor.cycle-heading",
  get label() {
    return i18n.t("commands.actions.cycleHeading.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
  visibility: editorOnly,
  run: () => {
    const view = getActiveEditorView();
    if (view !== null) cycleHeading(view);
  },
};

const restoreBackupAction: CommandAction = {
  id: "vault.restore",
  get label() {
    return i18n.t("commands.actions.restoreBackup.label");
  },
  get category() {
    return i18n.t("commands.actions.category.vault");
  },
  visibility: editorOnly,
  run: (c) => c.onRestoreBackup(),
};
const revealVaultFolderAction: CommandAction = {
  id: "vault.reveal-folder",
  get label() {
    return i18n.t("commands.actions.revealVaultFolder.label");
  },
  get category() {
    return i18n.t("commands.actions.category.vault");
  },
  visibility: editorOnly,
  // Opens THIS vault's directory, `<app_data_dir>/vaults/<id>/` — the
  // multi-vault layout (`decisions.md` 2026-06-09 "Vault disk layout:
  // vaults/<id>/ + eager boot migration"), NOT the retired Phase-1 single
  // `<app_data_dir>/vault` the previous version opened. The id comes from the
  // AUTHORITATIVE runtime slot (`activeVaultId()`), never from `listVaults()`'s
  // `last_unlock`-ordered registry cache, which names a different vault after a
  // quick-unlock or recovery (#250). `null` means no vault is unlocked, and a
  // reveal must never guess one — so it no-ops. Resolution is UI-side because a
  // backend-resolved path may not cross IPC (`src-tauri/AGENTS.md` "Never
  // crosses IPC"); the two `join` hops mirror `StoragePanel`'s.
  run: () => {
    void (async () => {
      try {
        const id = await activeVaultId();
        if (id === null) return;
        await openPath(await join(await appDataDir(), "vaults", id));
      } catch {
        /* best-effort — reveal failure is non-fatal */
      }
    })();
  },
};


const lockVaultAction: CommandAction = {
  id: "vault.lock",
  ribbon: { icon: "lock" },
  get label() {
    return i18n.t("commands.actions.lockVault.label");
  },
  get category() {
    return i18n.t("commands.actions.category.vault");
  },
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: async (ctx) => {
    await ctx.onLock();
  },
};

/**
 * Open the command palette — from the palette's own rail entry (myne-md/myne#773).
 *
 * The palette had no clickable entry point at all before this: `palette.toggle`
 * lived only in `bindableCatalog.ts` as a keybinding, and the left rail's
 * roster is derived from `COMMAND_ACTIONS` entries carrying a `ribbon` block,
 * so it was not absent from the default rail — it could not be pinned to it.
 *
 * `visibility` is the interesting half. The action hides from the PALETTE while
 * the palette is open, because a palette row that opens the palette is a no-op
 * that reads as a broken command, and the rule at the top of this file is that
 * the palette never exposes an action unavailable in the current state.
 *
 * The RAIL gets its own answer (`railVisibility`), and the first version of this
 * entry did not: it reused `visibility`, which the rail reads, so pressing the
 * sidebar's search row made the rail's own search glyph disappear for as long as
 * the palette was up and reappear when it closed. That is the flicker the user
 * reported (issue #970, item 5): a pinned rail entry is furniture, and it must
 * not blink because another surface opened. Pressing it while the palette is up
 * re-focuses rather than toggling shut, which is what a search affordance should
 * do when you press it twice.
 */
const openPaletteAction: CommandAction = {
  id: "palette.open",
  ribbon: { icon: "search" },
  get label() {
    return i18n.t("commands.actions.openPalette.label");
  },
  get category() {
    return i18n.t("commands.actions.category.app");
  },
  visibility: (ctx) =>
    ctx.stageName === "editor" && !ctx.paletteOpen ? "show" : "hidden",
  // Never hidden by the palette's own state: the rail is where this affordance
  // was missing for the longest, and it is the one entry that must not blink
  // while the palette it opens is on screen.
  railVisibility: editorOnly,
  run: (ctx) => {
    ctx.onOpenPalette();
  },
};

const openSettingsAction: CommandAction = {
  id: "app.open-settings",
  ribbon: { icon: "settings" },
  get label() {
    return i18n.t("commands.actions.openSettings.label");
  },
  get category() {
    return i18n.t("commands.actions.category.app");
  },
  kbd: "⌘,",
  defaultBinding: "Mod-,",
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onOpenSettings();
  },
};

const backupVaultAction: CommandAction = {
  id: "vault.backup",
  ribbon: { icon: "download" },
  get label() {
    return i18n.t("commands.actions.backupVault.label");
  },
  get category() {
    return i18n.t("commands.actions.category.vault");
  },
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
  get label() {
    return i18n.t("commands.actions.exportVaultMarkdown.label");
  },
  get category() {
    return i18n.t("commands.actions.category.vault");
  },
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
  get label() {
    return i18n.t("commands.actions.importObsidian.label");
  },
  get category() {
    return i18n.t("commands.actions.category.vault");
  },
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
  ribbon: { icon: "layout-grid" },
  get label() {
    return i18n.t("commands.actions.manageTemplates.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
  // Editor-only, like Open settings — the management surface mounts inside the
  // Editor (modal carve-out). Free + local; no paywall, no hosted-sync gate.
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onManageTemplates();
  },
};

const manageViewsAction: CommandAction = {
  id: "views.manage",
  get label() {
    return i18n.t("commands.actions.manageViews.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
  // Editor-only, and NOT gated on the device-local Views toggle the way
  // `views.show` is. The toggle hides the sidebar flyout, which is a navigation
  // preference; this action is how a reader reaches views at all when it is on
  // the other side of that preference, including the first imported view that
  // arrived before anyone could have flipped it. A door that closes with the
  // window it leads to strands what is behind it.
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onManageViews();
  },
};

const newNoteFromTemplateAction: CommandAction = {
  id: "templates.new-note",
  ribbon: { icon: "file-plus" },
  get label() {
    return i18n.t("commands.actions.newNoteFromTemplate.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
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
  ribbon: { icon: "calendar-days" },
  get label() {
    return i18n.t("commands.actions.openTodayNote.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
  // Idempotent open-or-create over ordinary notes (folder + date-title key).
  // Palette-only in v1 — no sidebar button, no built-in hotkey; past days are
  // reached via the ordinary Daily/ sidebar folder (no calendar, no date-picker).
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onOpenPeriodNote("daily");
  },
};

const openThisWeekNoteAction: CommandAction = {
  id: "periodic.open-this-week",
  ribbon: { icon: "calendar-plus" },
  get label() {
    return i18n.t("commands.actions.openThisWeekNote.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
  // The weekly sibling of `daily.open-today` (myne#177), and deliberately the
  // same shape: palette-only, no built-in hotkey, and past weeks reached
  // through the ordinary sidebar folder. There is no previous/next command and
  // no picker. That is the anti-calendar line daily already drew.
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onOpenPeriodNote("weekly");
  },
};

const openThisMonthNoteAction: CommandAction = {
  id: "periodic.open-this-month",
  ribbon: { icon: "calendar" },
  get label() {
    return i18n.t("commands.actions.openThisMonthNote.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onOpenPeriodNote("monthly");
  },
};

const randomNoteAction: CommandAction = {
  id: "notes.random",
  ribbon: { icon: "shuffle" },
  get label() {
    return i18n.t("commands.actions.randomNote.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
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
  ribbon: { icon: "paperclip" },
  get label() {
    return i18n.t("commands.actions.openAttachments.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
  // Editor-only, like Open settings — the library is a full-pane center-pane
  // view inside the Editor (SYNC-9), not a Stage. Free + local.
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onOpenAttachments();
  },
};

/**
 * "Attach file…" (audit T6.13 item 1) — the palette entry the `/attach` slash
 * command already had. Runs the same picker-backed import on the active view;
 * a no-op when no view is mounted (the visibility guard keeps it out of the
 * palette anyway, but the run path is defensive like `cycleHeading`.
 */
const attachFileAction: CommandAction = {
  id: "attachments.attach-file",
  get label() {
    return i18n.t("commands.actions.attachFile.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
  visibility: editorOnly,
  run: () => {
    const view = getActiveEditorView();
    if (view !== null) void pickAndInsert(view);
  },
};

/**
 * "Convert imported attachments…" (audit T6.13 item 1) — the palette entry
 * `runImportAndConvert` was exported for and never got, so the command was
 * unreachable from any surface. Opens the same diff-preview-then-rewrite flow.
 */
const convertImportedAttachmentsAction: CommandAction = {
  id: "attachments.convert-imported",
  get label() {
    return i18n.t("commands.actions.convertImportedAttachments.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
  visibility: editorOnly,
  run: () => {
    const view = getActiveEditorView();
    if (view !== null) void runImportAndConvert(view);
  },
};

const convertWikilinksAction: CommandAction = {
  id: "wikilinks.convert-in-this-note",
  get label() {
    return i18n.t("commands.actions.convertWikilinks.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
  // R2 (MYND-84): per-note conversion of imported title-only wikilinks to the
  // canonical §3 path form, with a mandatory diff preview. Editor-only + per-note
  // (acts on the active buffer); the empty case shows a toast, never a modal.
  visibility: (ctx) =>
    ctx.stageName === "editor" && ctx.selectedNoteId !== null ? "show" : "hidden",
  run: () => {
    void runWikilinkConvert();
  },
};

const exportSelectionImageAction: CommandAction = {
  id: "note.export-selection-image",
  get label() {
    return i18n.t("commands.actions.exportSelectionImage.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
  // MYND-361 note→image: rasterize the current editor selection to a shareable
  // PNG "card" and save it. Editor-only + per-note; the empty-selection case
  // toasts (never a modal), the same self-contained-feedback discipline as the
  // wikilink-convert action above. Uses the module-level toast so no
  // CommandContext callback / Editor plumbing is needed.
  visibility: (ctx) =>
    ctx.stageName === "editor" && ctx.selectedNoteId !== null ? "show" : "hidden",
  run: () => exportSelectionImageWithToast(),
};

/**
 * Run the selection→image export and toast the coarse outcome. Shared by the
 * palette action above and the floating-toolbar button (wired via
 * `setSelectionExportHandler`) so both paths behave identically. `cancelled`
 * (user dismissed the save dialog) is silent; every other outcome toasts.
 */
export function exportSelectionImageWithToast(): void {
  void exportSelectionAsImage().then((outcome) => {
    const key =
      outcome === "saved"
        ? "commands.actions.exportSelectionImage.saved"
        : outcome === "no-selection"
          ? "commands.actions.exportSelectionImage.noSelection"
          : outcome === "failed"
            ? "commands.actions.exportSelectionImage.failed"
            : null;
    if (key !== null) showAttachmentToast(i18n.t(key));
  });
}

// Shared AI command surface (local-ai epic, ai-ux-surface MYND-408, SYNC-9).
// The stub sibling that proves the `ai.*` surface + the shared gate: editor
// stage + `ai_enabled`. When AI is OFF it renders **disabled** (not hidden) so
// the feature is discoverable and the user learns it is a toggle away
// (disabled-control discipline). Capability actions (siblings 4/6/7) register
// through the same gate + the reserved `ai.*` id / `ai.insert`/`ai.rewrite`/
// `ai.title` userEvent namespace.
//
// Developer-mode gated on top of that (MYND-593): local AI now lives behind
// the Developer group, and the palette can flip `ai_enabled` without Settings
// being involved at all — so while the mode is off, all five ai.* actions are
// HIDDEN outright, not merely disabled. The disabled-control discipline above
// still applies once the mode is on; it just no longer applies before it.
const aiOpenChatAction: CommandAction = {
  id: "ai.open-chat",
  get label() {
    return i18n.t("commands.actions.aiOpenChat.label");
  },
  get category() {
    return i18n.t("commands.actions.category.ai");
  },
  visibility: (ctx) =>
    ctx.stageName !== "editor" || !ctx.prefs.developer_mode
      ? "hidden"
      : ctx.aiEnabled
        ? "show"
        : "disabled",
  run: (ctx) => {
    ctx.onOpenAiChat();
  },
};

// Open the agent tab on its vault-general Hub (myne-md/myne#771). The pair of
// agent entries exists so "work on my vault" and "work on this note" are two
// deliberate choices; the scope word in each label carries the difference, which
// is what makes them distinguishable BEFORE either is invoked.
const aiOpenAgentVaultAction: CommandAction = {
  id: "ai.open-agent-vault",
  get label() {
    return i18n.t("commands.actions.aiOpenAgentVault.label");
  },
  get category() {
    return i18n.t("commands.actions.category.ai");
  },
  // The ONE pinnable agent item (myne-md/myne#771). It opens the agent tab on
  // whatever view it was last left on: the reveal keeps an open tab's
  // `agentView`, so a tab left in Focus comes back in Focus and a fresh one is
  // born on the Hub. That is the "last-used view" behaviour without a second
  // preference to keep in step.
  ribbon: { icon: "message-square" },
  visibility: (ctx) =>
    ctx.stageName !== "editor" || !ctx.prefs.developer_mode
      ? "hidden"
      : ctx.aiEnabled
        ? "show"
        : "disabled",
  run: (ctx) => {
    ctx.onOpenAgentVault();
  },
};

// Open the agent tab on its Focus view for the open note (myne-md/myne#771).
// Needs a note, like the summarize/rewrite actions; without one the handler
// lands on the Hub rather than a Focus with nothing behind it.
const aiOpenAgentNoteAction: CommandAction = {
  id: "ai.open-agent-note",
  get label() {
    return i18n.t("commands.actions.aiOpenAgentNote.label");
  },
  get category() {
    return i18n.t("commands.actions.category.ai");
  },
  visibility: (ctx) =>
    ctx.stageName !== "editor" || !ctx.prefs.developer_mode
      ? "hidden"
      : ctx.aiEnabled
        ? "show"
        : "disabled",
  run: (ctx) => {
    ctx.onOpenAgentNote();
  },
};

// Summarize the open note / selection (note-summarization MYND-409). Per-note
// AI action: needs a selected note (the exportNote pattern) AND ai_enabled AND
// developer_mode. In the editor with a note, mode on, but AI off → disabled
// (discoverable); with no note, mode off, or outside the editor → hidden. The
// excluded-folder block (SYNC-14) + the ephemeral AI Chat render are the
// handler's concern; this is the gate + entry.
const aiSummarizeNoteAction: CommandAction = {
  id: "ai.summarize-note",
  get label() {
    return i18n.t("commands.actions.aiSummarizeNote.label");
  },
  get category() {
    return i18n.t("commands.actions.category.ai");
  },
  visibility: (ctx) =>
    ctx.stageName !== "editor" || ctx.selectedNoteId === null || !ctx.prefs.developer_mode
      ? "hidden"
      : ctx.aiEnabled
        ? "show"
        : "disabled",
  run: (ctx) => {
    ctx.onSummarizeNote();
  },
};

// Re-run the meeting AI pass on the open note (meeting-ai). The pass is offered
// once after a meeting stops, and this is the way back to it: a note whose offer
// was dismissed, or one the user wants to regenerate. Same gate as
// `ai.summarize-note` (editor + selected note + developer mode), because the
// meeting feature itself is developer-gated.
const meetingSummarizeAction: CommandAction = {
  id: "meeting.summarize",
  get label() {
    return i18n.t("commands.actions.meetingSummarize.label");
  },
  get category() {
    return i18n.t("commands.actions.category.ai");
  },
  visibility: (ctx) =>
    ctx.stageName !== "editor" || ctx.selectedNoteId === null || !ctx.prefs.developer_mode
      ? "hidden"
      : ctx.aiEnabled
        ? "show"
        : "disabled",
  run: (ctx) => {
    ctx.onSummarizeMeeting();
  },
};

// There is no `ai.suggest-tags` action. Auto-tag ran as an explicit palette
// action while its output rendered in the AI Chat tab; MYND-651 made suggestion
// always-on in the inline band, so a "suggest tags" command would be a second
// trigger for something the editor already does on its own.

const aiRewriteSelectionAction: CommandAction = {
  id: "ai.rewrite-selection",
  get label() {
    return i18n.t("commands.actions.aiRewriteSelection.label");
  },
  get category() {
    return i18n.t("commands.actions.category.ai");
  },
  visibility: (ctx) =>
    ctx.stageName !== "editor" || ctx.selectedNoteId === null || !ctx.prefs.developer_mode
      ? "hidden"
      : ctx.aiEnabled
        ? "show"
        : "disabled",
  run: (ctx) => {
    ctx.onRewriteSelection();
  },
};

const foldAllAction: CommandAction = {
  id: "editor.fold-all",
  get label() {
    return i18n.t("commands.actions.foldAll.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
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
  get label() {
    return i18n.t("commands.actions.unfoldAll.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
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
  get label() {
    return i18n.t("commands.actions.openSnapshots.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
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
  get label() {
    return i18n.t("commands.actions.exportNoteMarkdown.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
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
  get label() {
    return i18n.t("commands.actions.exportNotePdf.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
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
  get label() {
    return i18n.t("commands.actions.exportNoteHtml.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
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

const setNoteCoverAction: CommandAction = {
  id: "note.set-cover",
  get label() {
    return i18n.t("commands.actions.setNoteCover.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
  // Same visibility rule as the export siblings: editor stage AND a selected
  // note, else hidden. This is the cover feature's KEYBOARD door — the banner's
  // Change/Remove controls and the title-row Add control are all hover-revealed,
  // so without this entry the feature is mouse-only (myne-md/myne#410).
  visibility: editorWithNote,
  run: (ctx) => {
    ctx.onSetNoteCover();
  },
};

const removeNoteCoverAction: CommandAction = {
  id: "note.remove-cover",
  get label() {
    return i18n.t("commands.actions.removeNoteCover.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
  // A SEPARATE action from `note.set-cover`, and not an oversight that the two
  // are not one. Removing is only reachable from the banner's hover control,
  // which lives inside CodeMirror content where `Tab` is bound to
  // `editor.indent`, so focus cannot land on it. The picker's own Remove is
  // gated on `hasCover`, which neither non-pointer entry point can determine.
  // Without this action a cover can be added and changed without a pointer but
  // never removed, which fails PRODUCT.md's keyboard-first principle.
  //
  // Offered whenever a note is open rather than only when it has a cover: the
  // shell cannot see the note's frontmatter, and clearing an absent field is a
  // no-op write rather than an error (myne-md/myne#410).
  visibility: editorWithNote,
  run: (ctx) => {
    ctx.onRemoveNoteCover();
  },
};

const exportNoteTxtAction: CommandAction = {
  id: "note.export-txt",
  get label() {
    return i18n.t("commands.actions.exportNoteTxt.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
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
  ribbon: { icon: "share-2" },
  get label() {
    return i18n.t("commands.actions.showGraph.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
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

const showIsolatedGraphAction: CommandAction = {
  // The isolated notes, opened in the graph. Deliberately its own command
  // rather than a second mode of `graph.show`: the graph pane's filter is local
  // state, so "open the graph, on this view" is a different request from "open
  // the graph", and a user who wants the isolated view wants it directly rather
  // than a pane they then have to filter. No keybinding by default, it is a
  // once-in-a-while view, and the palette is where those live.
  id: "graph.show-isolated",
  get label() {
    return i18n.t("commands.actions.showIsolatedGraph.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onShowIsolatedGraph();
  },
};

const showCalendarAction: CommandAction = {
  // The identifier is FROZEN here for the reason `tasks.show` records: command
  // ids carry migration weight the moment a user rebinds one.
  id: "calendar.show",
  ribbon: { icon: "calendar" },
  get label() {
    return i18n.t("commands.actions.showCalendar.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
  kbd: "⌘⇧K",
  defaultBinding: "Mod-Shift-k",
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onShowCalendar();
  },
};

const showHomeAction: CommandAction = {
  // The identifier is FROZEN here for the reason `tasks.show` records: command
  // ids carry migration weight the moment a user rebinds one.
  id: "home.show",
  ribbon: { icon: "house" },
  get label() {
    return i18n.t("commands.actions.showHome.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
  kbd: "⌘⇧H",
  defaultBinding: "Mod-Shift-h",
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onShowHome();
  },
};

const showTasksAction: CommandAction = {
  // The identifier is FROZEN here. Command ids carry migration weight the
  // moment a user rebinds one — a rename silently drops their keybinding — so
  // this string must not change even if the surface is renamed.
  id: "tasks.show",
  ribbon: { icon: "list-todo" },
  get label() {
    return i18n.t("commands.actions.showTasks.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
  kbd: "⌘⇧T",
  defaultBinding: "Mod-Shift-t",
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onShowTasks();
  },
};

const showTagsAction: CommandAction = {
  id: "tags.show",
  ribbon: { icon: "hash" },
  get label() {
    return i18n.t("commands.actions.showTags.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
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
  get label() {
    return i18n.t("commands.actions.importBaseView.label");
  },
  get category() {
    return i18n.t("commands.actions.category.vault");
  },
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
  ribbon: { icon: "layout-grid" },
  get label() {
    return i18n.t("commands.actions.showViews.label");
  },
  get category() {
    return i18n.t("commands.actions.category.editor");
  },
  // Editor-only, like the other navigation entries, AND behind the Views feature
  // toggle (Settings → Editor). That second half arrived with myne-md/myne#762:
  // the flyout used to be opened by a sidebar row that the same toggle hid, so
  // turning Views off took the entry point with it. The row is gone and this
  // command is the entry point, and the flyout it opens does not mount while the
  // toggle is off — so without the gate the rail would carry a button that does
  // nothing. `viewsEnabled` is device-local (localStorage, not `vault.prefs`),
  // hence the back-compat `hasViews` argument rather than a plain pref read.
  visibility: (ctx) =>
    ctx.stageName === "editor" && viewsEnabled((ctx.prefs.saved_views?.length ?? 0) > 0)
      ? "show"
      : "hidden",
  run: (ctx) => {
    ctx.onShowViews();
  },
};

const toggleLeftSidebarAction: CommandAction = {
  id: "view.toggle-notes-sidebar",
  ribbon: { icon: "panel-left" },
  get label() {
    return i18n.t("commands.actions.toggleLeftSidebar.label");
  },
  get category() {
    return i18n.t("commands.actions.category.view");
  },
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onToggleLeftSidebar();
  },
};

const toggleRightSidebarAction: CommandAction = {
  id: "view.toggle-backlinks-sidebar",
  ribbon: { icon: "panel-right" },
  get label() {
    return i18n.t("commands.actions.toggleRightSidebar.label");
  },
  get category() {
    return i18n.t("commands.actions.category.view");
  },
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onToggleRightSidebar();
  },
};

const toggleStackedTabsAction: CommandAction = {
  id: "view.toggle-stacked-tabs",
  get label() {
    return i18n.t("commands.actions.toggleStackedTabs.label");
  },
  get category() {
    return i18n.t("commands.actions.category.view");
  },
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
  get label() {
    return i18n.t("commands.actions.toggleReading.label");
  },
  get category() {
    return i18n.t("commands.actions.category.view");
  },
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
  get label() {
    return i18n.t("commands.actions.toggleSource.label");
  },
  get category() {
    return i18n.t("commands.actions.category.view");
  },
  // Secondary live ⇄ source toggle on the focused note tab. No default chord
  // (grill D2) — palette + the bottom-bar switcher are its entry points.
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onToggleSource();
  },
};

const toggleFocusAction: CommandAction = {
  id: "view.toggle-focus",
  ribbon: { icon: "maximize-2" },
  get label() {
    return i18n.t("commands.actions.toggleFocus.label");
  },
  get category() {
    return i18n.t("commands.actions.category.view");
  },
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
  get label() {
    return i18n.t("commands.actions.saveWorkspaceAs.label");
  },
  get category() {
    return i18n.t("commands.actions.category.view");
  },
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onSaveWorkspaceAs();
  },
};

const switchWorkspaceAction: CommandAction = {
  id: "workspace.switch",
  get label() {
    return i18n.t("commands.actions.switchWorkspace.label");
  },
  get category() {
    return i18n.t("commands.actions.category.view");
  },
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onSwitchWorkspace();
  },
};

const renameWorkspaceAction: CommandAction = {
  id: "workspace.rename",
  get label() {
    return i18n.t("commands.actions.renameWorkspace.label");
  },
  get category() {
    return i18n.t("commands.actions.category.view");
  },
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onRenameWorkspace();
  },
};

const deleteWorkspaceAction: CommandAction = {
  id: "workspace.delete",
  get label() {
    return i18n.t("commands.actions.deleteWorkspace.label");
  },
  get category() {
    return i18n.t("commands.actions.category.view");
  },
  visibility: (ctx) => (ctx.stageName === "editor" ? "show" : "hidden"),
  run: (ctx) => {
    ctx.onDeleteWorkspace();
  },
};

/**
 * Which capability each gated action needs. Absent from this map = ungated.
 *
 * Capability gating happens HERE, at the registry, rather than at each render
 * site (MYND-574 task 27). The command palette, the keyboard-shortcut resolver
 * and the settings-search index all read `COMMAND_ACTIONS`, so filtering once
 * is what makes "unreachable by menu, still reachable by shortcut" impossible
 * rather than merely unlikely — that gap is the specific failure the task names.
 */
const ACTION_CAPABILITY: Readonly<Record<string, capabilities.Capability>> = Object.freeze({
  "ai.toggle-enabled": "localAi",
  "ai.open-chat": "localAi",
  "ai.open-agent-vault": "localAi",
  "ai.open-agent-note": "localAi",
  "ai.summarize-note": "localAi",
  "ai.rewrite-selection": "localAi",
  "app.toggle-screen-capture": "screenCaptureProtection",
  "vault.backup": "backup",
  "vault.restore": "backup",
  "vault.export-markdown": "vaultExport",
  // Task 48. The one export whose obstacle is the OUTPUT rather than the
  // destination: it drives a hidden Tauri WebView, prints it and collects the
  // result. `note.export-markdown` and `note.export-html` are deliberately NOT
  // here — their obstacle was where the file goes, and the browser download flow
  // answers that (`src/platform/download.ts`), so they stay reachable.
  "note.export-pdf": "pdfExport",
  // myne#678 (epic #173): pop a note into its own OS window. Desktop-only; web
  // and mobile cannot spawn OS windows, so the action is filtered out there and
  // is unreachable by menu AND by shortcut, per the gate-once discipline above.
  "note.open-in-new-window": "detachedWindows",
  // `note.export-selection-image` is NOT gated: it renders to a canvas and
  // hands the bytes to a download, which a browser does natively. It is task
  // 48's shape, not `nativeSaveAs`.
  //
  // Task 97 verdicts for the three formats task 48 left unnamed, recorded here
  // because "ungated" is the claim that has to be TRUE rather than merely
  // unwritten. All three are ungated, and all three now have a download arm
  // that makes that honest:
  //
  //   - `note.export-html` — SHIPS, as a standalone single file. The sidecar
  //     image variant does NOT ship on the download path: it needs a multi-file
  //     delivery mechanism task 48 settled only for single-file exports, and
  //     inventing a second one is what task 97's criterion forbids. The
  //     download arm therefore emits the document alone, which is the same
  //     inert degrade the flow already documents for a render with no modal
  //     mount (images stay in-app-only `attachment://` refs).
  //   - `note.export-txt` — SHIPS. One file, never a sidecar; nothing owed.
  //   - `note.export-selection-image` — SHIPS. Steps 1–3 of its pipeline are
  //     WebView work on every platform and the bytes are a finished PNG before
  //     any delivery decision.
  //
  // Until those arms existed the claim was false in a specific, invisible way:
  // each flow called the save dialog unconditionally, and a browser's typed
  // refusal landed in a `.catch(() => null)` that reads as "the user
  // dismissed it". The commands were offered, did nothing, and said nothing.
  //
  // Theme-JSON export SHIPS too, and it is not a palette action at all — it
  // lives on a row in Settings → Appearance, so it has no entry here. Its
  // verdict is recorded on `saveJsonAsFile`, which is where the download arm
  // is. It was the only one of the four whose absence would have had to reach
  // a settings section as well as the palette; shipping it makes that question
  // moot, and shipping is the right answer because it is a single file — the
  // exact case task 48 settled — and because a palette is colour values the
  // user authored, not vault content.
});

const ALL_COMMAND_ACTIONS: readonly CommandAction[] = Object.freeze([
  lockVaultAction,
  openPaletteAction,
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
  openThisWeekNoteAction,
  openThisMonthNoteAction,
  randomNoteAction,
  manageTemplatesAction,
  manageViewsAction,
  openAttachmentsAction,
  attachFileAction,
  convertImportedAttachmentsAction,
  foldAllAction,
  unfoldAllAction,
  openSnapshotsAction,
  exportNoteMarkdownAction,
  exportNotePdfAction,
  exportNoteHtmlAction,
  setNoteCoverAction,
  removeNoteCoverAction,
  exportNoteTxtAction,
  showGraphAction,
  showIsolatedGraphAction,
  showHomeAction,
  showTasksAction,
  showCalendarAction,
  showTagsAction,
  showViewsAction,
  importBaseViewAction,
  importObsidianAction,
  backupVaultAction,
  exportVaultMarkdownAction,
  convertWikilinksAction,
  exportSelectionImageAction,
  // Wave 1 — prefs toggles/cycles + theme (palette-gap audit)
  toggleLineNumbersAction,
  toggleVimModeAction,
  toggleSpellCheckAction,
  toggleTypewriterAction,
  toggleDimInactiveAction,
  toggleEditorFontAction,
  cycleTextSizeAction,
  cycleContentWidthAction,
  cycleDefaultViewModeAction,
  toggleTimestampsAction,
  toggleArchivingAction,
  toggleAiEnabledAction,
  toggleScreenCaptureAction,
  cycleThemeAction,
  switchThemeLightAction,
  switchThemeDarkAction,
  switchThemeAmoledAction,
  switchThemeSystemAction,
  applyCustomThemeAction,
  // Wave 2 — layout / panes / tabs / navigation
  splitRightAction,
  splitDownAction,
  closePaneAction,
  closeTabAction,
  nextTabAction,
  prevTabAction,
  focusNextPaneAction,
  focusPrevPaneAction,
  focusSidebarRegionAction,
  focusEditorRegionAction,
  focusRightPanelRegionAction,
  cycleRegionAction,
  goBackAction,
  goForwardAction,
  togglePreviewAction,
  // Wave 3 — find, note ops, right-panel tabs
  findInNoteAction,
  findReplaceAction,
  newNoteAction,
  duplicateNoteAction,
  openInNewWindowAction,
  archiveNoteAction,
  renameNoteAction,
  trashNoteAction,
  toggleFavoriteAction,
  moveNoteAction,
  emptyTrashAction,
  showBacklinksAction,
  showOutlineAction,
  showUnlinkedAction,
  // Wave 4 — sidebar surfaces + cycle heading + restore + sync
  newFolderAction,
  openTrashAction,
  openArchiveAction,
  cycleHeadingAction,
  restoreBackupAction,
  revealVaultFolderAction,
  aiOpenChatAction,
  aiOpenAgentVaultAction,
  aiOpenAgentNoteAction,
  aiSummarizeNoteAction,
  meetingSummarizeAction,
  aiRewriteSelectionAction,
]);

/**
 * The actions this platform actually offers.
 *
 * Filtered, not flagged: an action left in the list with a `disabled` marker
 * would still be found by palette search and still bound by the shortcut
 * resolver — visible-and-broken, which `decisions.md` 2026-07-26 rules out.
 */
export const COMMAND_ACTIONS: readonly CommandAction[] = Object.freeze(
  ALL_COMMAND_ACTIONS.filter((a) => {
    const needed = ACTION_CAPABILITY[a.id];
    return needed === undefined || capabilities.has(needed);
  }),
);
