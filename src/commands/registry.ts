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
  /** Open the attachments library (full-pane center-pane view, MYND-170). */
  onOpenAttachments: () => void;
  /** Open the snapshots / file-recovery panel for the selected note (MYND-97). */
  onOpenSnapshots: () => void;
  /** Open the whole-vault graph view (modal carve-out, lazy-loaded) (MYND-198). */
  onShowGraph: () => void;
  /** Open the Obsidian vault import flow (folder picker → progress → summary) (MYND-53). */
  onImportObsidian: () => void;
  /** Collapse/expand the left (notes) sidebar (mirrors the top-bar toggle). */
  onToggleLeftSidebar: () => void;
  /** Collapse/expand the right (backlinks) sidebar (mirrors the top-bar toggle). */
  onToggleRightSidebar: () => void;
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
  /** Optional keyboard hint displayed at the right edge of the row. */
  kbd?: string;
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
