// Typed command-action registry for the global command palette (MYND-86).
//
// Per the work item acceptance: "action registry is typed; actions respect
// app state guards; palette never exposes actions unavailable in the
// current state; no plugin API or user scripting surface is introduced."
//
// Visibility shape:
//   - `"show"`     → render the action; selectable + invokable.
//   - `"disabled"` → render dimmed; user can see the action exists but
//                     it isn't runnable (used for "coming soon" stubs).
//   - `"hidden"`   → omit from the palette entirely (state-unavailable).
//
// The registry itself is a frozen array; mutation requires editing this
// file. Plugin / scripting extensibility is explicitly out of scope per
// the work item acceptance.

import type { StageVaultStatus, SuspicionReason } from "../lib/stage";
import type { NoteId } from "../notes/sidebarState";
import type { PrefsView } from "../lib/prefs";

export type AppStageName =
  | "welcome"
  | "create-vault"
  | "unlock"
  | "editor"
  | "recover";

/**
 * Slice of app state visible to command actions. Kept narrow so actions
 * don't reach into UI internals. New fields are added here only when an
 * action actually needs them.
 */
export type CommandContext = {
  stageName: AppStageName;
  /** Current selection in the editor (or null when not in editor stage). */
  selectedNoteId: NoteId | null;
  /**
   * Whether local AI is enabled (`ai_enabled` pref, local-ai epic MYND-408,
   * SYNC-9). The shared gate every AI capability action reads:
   * `ctx.stageName === "editor" && ctx.aiEnabled`. Off-by-default; when off,
   * AI actions render **disabled** (not hidden — disabled-control discipline).
   */
  aiEnabled: boolean;
  /**
   * The live `vault.prefs` view — read by the toggle/cycle/set actions
   * (line numbers, spell-check, theme, typography, focus, etc.) to compute the
   * NEXT value before calling the module-level `set*` setter. Module-level
   * actions can't use the `usePrefs` hook, so the current values ride here.
   */
  prefs: PrefsView;
  /**
   * Reveal the AI Chat right-panel tab (the shared render target siblings 4/6/7
   * mount output into). Sets the right-panel active tab to `ai-chat`.
   */
  onOpenAiChat: () => void;
  /**
   * Summarize the open note / selection (note-summarization MYND-409). Runs the
   * local `Engine.infer` on a RAM-assembled prompt and renders ephemerally in
   * the AI Chat tab; blocked for a note in an `ai_excluded_folders` folder
   * (SYNC-14). Gated by the action on `editor + selectedNote + aiEnabled`.
   */
  onSummarizeNote: () => void;
  /**
   * Suggest tags for the open note (auto-tag-link MYND-411). Runs the local
   * `Engine.infer` once on the note body + existing-vocabulary hint, ranks the
   * candidates, and renders chips in the AI Chat tab; blocked for a note in an
   * `ai_excluded_folders` folder (SYNC-14). Gated on `editor + selectedNote +
   * aiEnabled`.
   */
  onSuggestTags: () => void;
  /**
   * Rewrite the current editor selection in place (writing-assistant MYND-410
   * `/yeniden-yaz` as a palette action — a slash trigger has no selection). Runs
   * the local `Engine.infer` on the selection and replaces it as plain markdown
   * (`ai.rewrite`); a no-op on an empty selection. Gated on `editor +
   * selectedNote + aiEnabled`.
   */
  onRewriteSelection: () => void;
  /** Invoke the lock-vault flow (mirrors BottomBar Lock button). */
  onLock: () => Promise<void>;
  /** Open the Settings modal (mirrors gear button). */
  onOpenSettings: () => void;
  /** Open the template-management surface (MYND-189). */
  onManageTemplates: () => void;
  /** Open the new-note-from-template flow (picker → name → create) (MYND-190). */
  onNewNoteFromTemplate: () => void;
  /** Open (or idempotently create) today's daily note (MYND-191). */
  onOpenTodayNote: () => void;
  /** Pick a random non-trashed, non-template note from the vault and open it (MYND-323). */
  onOpenRandomNote: () => void;
  /** Open the attachments library (full-pane center-pane view, MYND-170). */
  onOpenAttachments: () => void;
  /** Open the snapshots / file-recovery panel for the selected note (MYND-97). */
  onOpenSnapshots: () => void;
  /** Run the per-note markdown-export flow for the selected note (MYND-116). */
  onExportNoteMarkdown: () => void;
  /** Run the per-note PDF-export flow for the selected note (MYND-255). */
  onExportNotePdf: () => void;
  /** Run the per-note HTML-export flow for the selected note (MYND-340). */
  onExportNoteHtml: () => void;
  /** Run the per-note plain-text export flow for the selected note (MYND-340). */
  onExportNoteTxt: () => void;
  /** Open the whole-vault graph view (modal carve-out, lazy-loaded) (MYND-198). */
  onShowGraph: () => void;
  /** Open the tag browser (modal carve-out: tree + multi-select filter) (MYND-46). */
  onShowTags: () => void;
  /** Reveal the Saved Views surface — the sidebar "Views" section (MYND-274). */
  onShowViews: () => void;
  /** Open the Obsidian vault import flow (folder picker → progress → summary) (MYND-53). */
  onImportObsidian: () => void;
  /** Open the `.base` saved-views import flow (file picker → parse/map/persist → summary toast) (Saved Views #6, MYND-276). */
  onImportBaseView: () => void;
  /** Open the backup-export flow (save dialog → verified .myne-backup) (MYND-56). */
  onBackupVault: () => void;
  /** Open the whole-vault markdown export modal (three-phase, MYND-211). */
  onExportVaultMarkdown: () => void;
  /** Collapse/expand the left (notes) sidebar (mirrors the top-bar toggle). */
  onToggleLeftSidebar: () => void;
  /** Collapse/expand the right (backlinks) sidebar (mirrors the top-bar toggle). */
  onToggleRightSidebar: () => void;
  /** Flip the focused pane's stacked tab-layout (tab-modes / MYND-319). */
  onToggleStackedTabs: () => void;
  /** Toggle the focused note tab between Edit and Reading view (MYND-299). */
  onToggleReading: () => void;
  /** Toggle the focused note tab's Edit surface between live-preview and source (MYND-299). */
  onToggleSource: () => void;
  /** Toggle distraction-free focus mode — fade chrome, collapse sidebars (MYND-348). */
  onToggleFocus: () => void;
  /** Save the active layout as a new named workspace (MYND-308). */
  onSaveWorkspaceAs: () => void;
  /** Switch to another named workspace (MYND-308). */
  onSwitchWorkspace: () => void;
  /** Rename the active named workspace (MYND-308). */
  onRenameWorkspace: () => void;
  /** Delete the active named workspace (MYND-308). */
  onDeleteWorkspace: () => void;
  /** Switch active selection to the given note id (mirrors sidebar click). */
  onSelectNote: (id: NoteId) => Promise<void>;
  /** Drive Stage transitions for force-relock paths. */
  onForceRelock?: (status: StageVaultStatus, reason?: SuspicionReason) => void;
};

export type ActionVisibility = "show" | "disabled" | "hidden";

export type CommandAction = {
  id: string;
  label: string;
  /** Optional category label for grouped display. */
  category?: string;
  /**
   * Optional keyboard hint displayed at the right edge of the palette row.
   * **Display only** — NOT a binding source of truth (SYNC-4). Once the keybind
   * engine lands, this is derived from {@link defaultBinding} via `formatChord`;
   * read the effective binding through `effectiveBinding` (commands/keymap.ts),
   * never this field.
   */
  kbd?: string;
  /**
   * The command's DEFAULT key binding as a canonical chord string (hotkeys epic,
   * MYND-304) — spec-owned, CodeMirror-`KeyBinding.key`-compatible (`Mod-Shift-g`
   * form, logical key, cross-platform `Mod`). Lives in code (defaults are never
   * persisted); a user override in `vault.prefs.keymap` shadows it. `undefined` ≡
   * the command has no default chord. Resolve the effective binding via
   * `effectiveBinding` (commands/keymap.ts): `override ?? [defaultBinding]`.
   */
  defaultBinding?: string;
  /** Optional helper text shown when the action is disabled. */
  disabledHint?: string;
  /**
   * Whether the action shows up in the palette and whether it's runnable.
   * Called every render with the current app context.
   */
  visibility: (ctx: CommandContext) => ActionVisibility;
  /** Invocation handler. May be async. */
  run: (ctx: CommandContext) => void | Promise<void>;
};
