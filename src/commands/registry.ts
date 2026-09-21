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
import type { Period } from "../notes/dailyNote";
import type { PrefsView } from "../lib/prefs";
import type { IconName } from "../lib/icons";

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
  /** Open (or idempotently create) one period's note: daily (MYND-191),
   *  weekly or monthly (myne#177). ONE callback for all three: the prefs
   *  asymmetry between daily and the other two lives in `periodSettings`, and
   *  a second callback for daily would put that knowledge in a second place. */
  onOpenPeriodNote: (period: Period) => void;
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
  /** Open the cover picker for the selected note (myne-md/myne#410). The other
   *  two entry points are hover-revealed, so this is the keyboard door. */
  onSetNoteCover: () => void;
  /** Clear the selected note's cover. A separate entry because the only other
   *  Remove lives on the banner's hover controls, inside CodeMirror content
   *  where Tab is bound to indent, so it is unreachable by keyboard. */
  onRemoveNoteCover: () => void;
  /** Open the whole-vault graph view (modal carve-out, lazy-loaded) (MYND-198). */
  onShowGraph: () => void;
  /** Open the graph view on the ISOLATED notes, the notes with no links in or
   *  out (myne-md/myne#727, task 14). Its own entry rather than a chip in the
   *  pane header: a view nobody opens daily belongs in the palette, and the
   *  pane header has to hold the controls for the view you are already in. */
  onShowIsolatedGraph: () => void;
  /** Open (or reveal) the vault-wide task list (MYND-616). */
  onShowTasks: () => void;
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
  // ── Wave 2: layout / workspace / panes / tabs / navigation (palette-gap) ──
  /** Split the focused pane to the right (row split). */
  onSplitRight: () => void;
  /** Split the focused pane downward (column split). */
  onSplitDown: () => void;
  /** Close the focused pane (no-op on the last pane). */
  onClosePane: () => void;
  /** Close the focused pane's active tab. */
  onCloseTab: () => void;
  /** Activate the next / previous tab in the focused pane (wraps). */
  onNextTab: () => void;
  onPrevTab: () => void;
  /** Move focus to the next / previous pane (wraps). */
  onFocusNextPane: () => void;
  onFocusPrevPane: () => void;
  /** Step the focused pane's note history back / forward. */
  onGoBack: () => void;
  onGoForward: () => void;
  /** Toggle the focused pane's side-by-side companion (live preview). */
  onTogglePreview: () => void;
  // ── Wave 3: note ops + right-panel tabs (palette-gap) ──
  /** Create a new blank note and start inline rename. */
  onNewNote: () => void;
  /** Duplicate the selected note (clone → open the copy). */
  onDuplicateNote: () => void;
  /** Pop the selected note out into its own OS window (desktop-only, myne#173). */
  onOpenInNewWindow: () => void;
  /** Archive the selected note. */
  onArchiveNote: () => void;
  /** Start inline rename of the selected note. */
  onRenameNote: () => void;
  /** Move the selected note to the trash (soft delete, recoverable). */
  onTrashNote: () => void;
  /**
   * Whether THIS invocation was activated by a key rather than a pointer.
   *
   * Set per call by whoever runs the action (`CommandPalette` clones the context
   * with it), so it is a fact about one activation rather than ambient state.
   * Absent when nobody knows, which reads as "not a key".
   *
   * It exists for one consumer, `onEmptyTrash`, and the reason is below.
   */
  activatedByKey?: boolean;
  /**
   * Permanently empty the trash, taking whether the ACTIVATION was a key.
   *
   * It reaches `DeleteConfirmModal`'s `openedByKey`, which makes Enter wait for
   * an Enter keyup before it will confirm. The dialog behind this action is one
   * of the two that perform the cryptographic erase of
   * `docs/decisions/storage/0105`, and it opens DURING the Enter keydown that
   * selects the palette row, so the key that opened it may still be down.
   *
   * A constant `true` here was tried and is wrong in the other direction: a
   * palette row that was CLICKED leaves no Enter to release, so the user's first
   * Enter would be eaten on a dialog that has to answer the first press.
   * `e2e/palette-empty-trash.e2e.ts` caught exactly that, three runs over.
   */
  onEmptyTrash: (viaKey: boolean) => void;
  /** Add/remove the selected note from favorites. */
  onToggleFavorite: () => void;
  /** Reveal a specific right-panel tab. */
  onShowBacklinks: () => void;
  onShowOutline: () => void;
  onShowUnlinked: () => void;
  // ── Wave 4 ──
  /** Route into the restore-from-backup flow (sibling of onBackupVault). */
  onRestoreBackup: () => void;
  /**
   * Open the folder target-picker (QuickPicker) for the selected note and move
   * it to the chosen folder (palette-gap #32). No-op when no note is selected;
   * the action already guards on `selectedNoteId`.
   */
  onMoveNote: () => void;
  /**
   * Open the custom-theme target-picker (QuickPicker), then read + apply the
   * chosen saved theme and persist it as the active choice (palette-gap #31).
   */
  onApplyCustomTheme: () => void;
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
   * Opt-in left-ribbon metadata (myne-md/myne#699). A command is
   * ribbon-eligible **if and only if** it declares this, and the icon is the
   * glyph the rail renders. Declared at the command so eligibility cannot drift
   * from the registry; commands left unmarked (destructive, structural,
   * context-fragile) are not pinnable.
   */
  ribbon?: { icon: IconName };
  /**
   * Whether the action shows up in the palette and whether it's runnable.
   * Called every render with the current app context.
   */
  visibility: (ctx: CommandContext) => ActionVisibility;
  /** Invocation handler. May be async. */
  run: (ctx: CommandContext) => void | Promise<void>;
};

/**
 * The curated default rail a fresh vault starts with (myne-md/myne#699). This
 * is the CLIENT-side default: the stored `ribbon_items` pref is `null` until the
 * user configures the rail, and this list is what renders in that state. Every
 * id here must exist in the registry and declare `ribbon` (the metadata test
 * enforces it). Kept next to `CommandAction` because eligibility is defined
 * there; the resolver lives in `src/notes/ribbonItems.ts`.
 */
export const RIBBON_DEFAULT_IDS: readonly string[] = [
  "note.new",
  "daily.open-today",
  "periodic.open-this-week",
];
