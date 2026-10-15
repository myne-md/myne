// Terminal post-vault-creation screen - empty shell.
//
// Mounted by App.tsx when stage transitions to "editor" from
// <CreateVault>'s onComplete callback (which fires from <ReadyStep>'s
// "Done" button).
//
// T-shape layout (per design session 2026-04-28-empty-editor-shell.md
// Q2 = A): outer flex column with a row of three panes on top
// (260 left + flex center + 280 right) and a 28 px full-width status
// bar on the bottom.
//
// All copy is intentionally honest: no "Encrypted" / "synced" claims
// (there is no sync server, no per-note encryption pipeline yet);
// the account-number chip is a static MY-XXXX-… placeholder
// (the real account number is owned by <CreateVault>'s reducer and
// not threaded through to App-level - it becomes a vault-unlock
// concern when that feature lands). The status-bar word counter is
// live (MYND-143): it counts the active note's body words, frontmatter
// excluded, on a short debounce.
//
// References:
//   - PRD: agent-tooling/features/empty-editor-shell/prd.md
//   - Design session: agent-tooling/sessions/design/2026-04-28-empty-editor-shell.md
//   - Mockup (structural reference only, NOT copied):
//     docs/design/ui_kits/desktop/Editor.jsx

import { recordCommandRun } from "../lib/commandRecency";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import { useTranslation } from "react-i18next";
import { useRovingFocus } from "@myne/editor/host/lib/roving-focus";
import {
  shouldMirrorSelection,
  shouldOpenIntoFocusedPane,
} from "../notes/selectionBridges";
import { openCommandForKind } from "../notes/tabKinds";
import { CommandPalette } from "../components/CommandPalette";
import { LeftRibbon } from "../notes/components/LeftRibbon";
import { ribbonCommands } from "../notes/ribbonCommands";
import { COMMAND_ACTIONS, type CommandContext } from "../commands";
import { useKeybindDispatcher } from "../commands/useKeybindDispatcher";
import { useConflictMaterializer } from "../hooks/useConflictMaterializer";
import type { KeybindEntry } from "../commands/keybindEngine";
import { catalogDefaults } from "../commands/bindableCatalog";
import { asViewMode, type ViewMode } from "../editor/view-mode";
import { VIM_MODE_EVENT, type VimModeEventDetail } from "../editor/vim";
import { CLOSE_ACTIVE_TAB_EVENT } from "../notes/closeActiveTabSignal";
import { topRightFloatsShown as topRightFloats } from "../notes/topRightFloats";
import { requestGraphViewFilter } from "../notes/graphViewFilter";
import {
  OPEN_COVER_PICKER_EVENT,
  REMOVE_COVER_EVENT,
  type OpenCoverPickerDetail,
  type RemoveCoverDetail,
} from "@myne/editor/cover-signal";
import { CoverPicker, type CoverChoice } from "../components/attachments/CoverPicker";
import { setNoteCover } from "../notes/setNoteCover";
import { backfillDeliberateFolders } from "../notes/folderBackfill";
import { COVER_FIELD_KEY } from "../dialect";
import { installTaskChipEditor } from "@myne/editor/decorations/task-chip-listener";
import { focusKindOf } from "../commands/scope";
import { FailClosedError } from "../components/FailClosedError";
import { StorageLost } from "./StorageLost";
import { DeviceRevoked } from "./DeviceRevoked";
import { useSyncStatus } from "../hooks/useSyncStatus";
import { deleteVault } from "../lib/vault-delete";
import {
  openDetachedWindow,
  detachedWindowsSnapshot,
  detachedNoteId as currentDetachedNoteId,
} from "../lib/detachedWindow";
import { decidePopOutRoute } from "../notes/detachedRoute";
import { planDetachedRestore } from "../notes/detachedRestore";
import { readDisplays, getCurrentWindow } from "../platform/window";
import { activeVaultId } from "../lib/vault-list";
import { useUnsyncedEdits } from "../hooks/useUnsyncedEdits";
import { useStorageHealth } from "../hooks/useStorageHealth";
import { SyncBanners } from "../components/sync/SyncBanners";
import { UpdateBanner } from "../components/UpdateBanner";
import { RemoteMergeHint } from "../components/sync/RemoteMergeHint";
import { Icon } from "../components/primitives/Icon";
import {
  CenteredCard,
  CARD_TITLE_STYLE,
  CARD_BODY_STYLE,
} from "../components/primitives/CenteredCard";
import { Button } from "../components/primitives/Button";
import { PanelToggleGlyph } from "../components/primitives/PanelToggleGlyph";
import { Tooltip } from "../components/primitives/Tooltip";
import {
  hoverSurface,
  HOVER_TRANSITION,
} from "../components/primitives/hoverSurface";
import { SettingsModal, type PanelId } from "../components/SettingsModal";
import { MeetingAiDialog } from "../components/meeting/MeetingAiDialog";
import { offerMeetingAi } from "../components/meeting/meetingAiStore";
import { extractMeetingTranscript } from "../notes/ai/meetingTranscript";
import { ThemeInstallDialog } from "../components/ThemeInstallDialog";
import { Spinner } from "../components/Spinner";
import { SnapshotsPanel } from "../notes/components/SnapshotsPanel";
import { SnapshotFailedIndicator } from "../notes/components/SnapshotFailedIndicator";
import { AiHydrationProbe } from "../notes/components/AiHydrationProbe";
import { AiOnboardingSurface } from "../components/settings/AiOnboardingSurface";
import {
  readAiOnboardingSeen,
  writeAiOnboardingSeen,
} from "../lib/aiOnboardingSeen";
import { has } from "../platform/capabilities";
import { NewNoteFromTemplateModal } from "../components/NewNoteFromTemplateModal";
import { Toast, type ToastAction, type ToastVariant } from "../components/Toast";
import { NoteExportModal } from "../components/export/NoteExportModal";
import { ObsidianImportModal } from "../notes/import/ObsidianImportModal";
import { ImporterOnboardingOffer } from "../notes/import/ImporterOnboardingOffer";
import { open as openDialog } from "../platform/dialog";
import {
  importBaseFilePath,
  BaseImportPersistError,
} from "../notes/import/base/importBase";
import { BaseParseError } from "../notes/import/base/parseBase";
import { BackupExportModal } from "../components/backup/BackupExportModal";
import { VaultExportModal } from "../components/export/VaultExportModal";
import { collectFolderOptions } from "../components/export/vaultExportFlow";
import type { ImportResult } from "../notes/import/engine";
import { isVaultUnlocked, lockVault } from "../lib/vault-unlock";
import { onExitIntent, setUnsavedGuard } from "../platform/exit-signals";
import { takeDeepLinkNoteId, useNoteRoute } from "../lib/routing";
import { takeRequestedNoteOpen } from "../notes/pendingNoteOpen";
import type { StageVaultStatus, SuspicionReason, VaultId } from "../lib/stage";
import {
  noteList,
  loadNoteBatch,
  createNoteFromTemplate,
  singleDay,
  createBlankNamedNote,
  resolvePeriodNote,
  periodSettings,
  zonedNow,
  type Period,
  convertNoteToTemplate,
  convertTemplateToNote,
} from "../notes";
import {
  prefsRead,
  normalizeStartupOpen,
  notifyVaultPrefsChanged,
  PREFS_SYNC_APPLIED_EVENT,
} from "../lib/prefs";
import { bumpPrefsNonce } from "../notes/prefsNonce";
import { flushGraphLayoutNow } from "../notes/graphLayoutPersist";
import { showAttachmentToast } from "../editor/attachments/toast";
import {
  exportToastAction,
  noteExportOptions,
  runNoteExportFlow,
  runNoteHtmlExportFlow,
  runNotePdfExportFlow,
  runNoteTxtExportFlow,
  type AttachmentPreflightChoice,
  type ExportToast,
  type NoteExportUiHooks,
} from "../notes/exportFlow";
import {
  noteExportFormats,
  type NoteExportFormat,
} from "../notes/noteExportMenu";
import { NotePdfExportNotice } from "../components/export/NotePdfExportNotice";
import { ExportEgressNotice } from "../components/export/ExportEgressNotice";
import type { ExcludedAttachment } from "../dialect/html/emitNoteHtml";
import { NoteList as NotesSidebarList } from "../notes/components/NoteList";
import {
  NoteActionsMenu,
  type NoteActionMenuItem,
} from "../notes/components/NoteActionsMenu";
import { dragEdgeX, insertionLineStyleX } from "../notes/components/reorderDnd";
import {
  BAR_ITEMS,
  RIGHT_CLUSTER_DEFAULT_ORDER,
  resolveBarOrder,
  reorderByDrop,
  moveBarItem,
  canMoveBarItem,
} from "../notes/barItemsOrder";
import { vaultIndicesPersist } from "../notes/vaultIndices";
import { requestRevealViews } from "../notes/views/revealViewsSignal";
import { useResolverNotes } from "../notes/resolverNotes";
import { UnlinkedMentionsSection } from "../notes/components/UnlinkedMentionsSection";
import { AiChatTab } from "../notes/components/AiChatTab";
// myne#529: the agent surface. The composer rides the AI tab, so a run starts
// where the user already talks to the AI. The review screen is a takeover
// rather than a panel because approval is a separate, attention-requiring act
// and half the feature's other decisions rest on it being one.
import { clearAgentForLock } from "../notes/agent/agentStore";
import { AgentReviewTakeover } from "../notes/agent/components/AgentReviewTakeover";
import { NoteTasksPanel } from "../notes/components/TasksPane";
import { TASK_WRITE_EVENT } from "../notes/toggleTask";
import { NOTE_REMOVED_EVENT, type NoteRemovedDetail } from "../notes/noteRemoved";
import { CLI_NOTES_CHANGED_EVENT } from "../lib/cli-access";
import { clearAiOutput } from "../notes/ai/aiOutputStore";
import { clearChat } from "../notes/ai/chatStore";
import { runSummarizeToChat } from "../notes/ai/aiToChat";
import { appendSummaryBlock, SUMMARIZE_BUDGET_CHARS } from "../notes/ai/summarize";
import { infer as aiInfer } from "../lib/writing-assistant";
import { isNoteAiExcluded } from "../lib/aiExcludedFolders";
import { getActiveEditorView } from "../editor/active-view";
import { BacklinksTab } from "../notes/components/BacklinksTab";
import { WhoIsHereTab } from "../notes/components/WhoIsHereTab";
import { OutlineTab } from "../notes/components/OutlineTab";
import { ToolbarLayoutSync } from "../notes/ToolbarLayoutSync";
import {
  RIGHT_PANEL_TABS,
  RIGHT_PANEL_DEFAULT_ORDER,
  resolveActiveTab,
} from "../notes/rightPanelTabs";
import { linkMention } from "../notes/linkMention";
import type { UnlinkedMention } from "../notes/unlinkedMentions";
import { SaveStatus as SaveStatusBadge } from "../notes/components/SaveStatus";
import { DeleteConfirmModal } from "../notes/components/DeleteConfirmModal";
import {
  SidebarStateProvider,
  useSelectedNote,
  trashedRecords,
  type NoteId,
} from "../notes/sidebarState";
import { settleFrontmatterWrite as settleFrontmatterWriteFor } from "../notes/settleFrontmatterWrite";
import { sidebarCommands } from "../notes/sidebarCommands";
import { setMeetingSidebarSurface } from "../notes/meetingSession";
import type { SaveStatus as SaveStatusValue } from "../notes/useAutosave";
import { getCurrentWebviewWindow } from "../platform/webviewWindow";
import { listen } from "../platform/event";
import { useActivityHeartbeat } from "../hooks/useActivityHeartbeat";
import { useBackupScheduler } from "../hooks/useBackupScheduler";
import { BACKUP_SCHEDULE_FAILED_TOAST } from "../lib/load-bearing-copy";
import { ResizeHandle } from "../components/primitives/ResizeHandle";
import { VaultSwitcher } from "../components/VaultSwitcher";
import { useEditorLayout } from "./editorLayout";
import { usePrefs } from "../hooks/usePrefs";
import { useDateTimeDisplaySync } from "../hooks/useDateTimeDisplaySync";
import { useReminderScheduler } from "../hooks/useReminderScheduler";
import { createInAppNotifier } from "../lib/reminderNotifier";
import { useLiveVaultTasks } from "../notes/taskIndex";
import { TASK_CHIP_INK } from "../notes/taskDisplay";
import i18n from "../i18n";
import { useIdleAutoLock } from "../hooks/useIdleAutoLock";
import { effectiveAutoLockSecs } from "@myne/client-core";
import { runFlushChain } from "../lib/flush-chain";
import {
  ContextMenu,
  type ContextMenuItem,
} from "../notes/components/ContextMenu";
import {
  HAS_OVERLAY_WINDOW_CONTROLS,
  TITLE_BAR_CONTROL_HEIGHT,
  TITLE_BAR_CONTROL_TOP,
  TITLE_BAR_RIGHT_EDGE,
  TRAFFIC_LIGHT_GAP,
  dragRegionProps,
} from "./titlebar";
import { useIsFullscreen } from "../hooks/useIsFullscreen";
import { LEFT_BOUNDS, RIGHT_BOUNDS } from "./layoutClamp";
import { useResponsiveCollapse } from "./responsiveCollapse";
import { REVEAL_ATTACHMENT_EVENT } from "../editor/attachments/fileCardActions";
import {
  WorkspaceProvider,
  panesNotSettledMessage,
  useWorkspace,
} from "../notes/workspaceContext";
import { ClipDispatchListener } from "../clip/ClipDispatchListener";
import { PaneTree } from "../notes/components/PaneTree";
import { enterRegion, REGION_ATTR } from "../lib/regions";
import { STRIP_HEIGHT } from "../notes/components/TabStrip";
import type { PaneReadout } from "../notes/components/PaneView";
import type { DocStats } from "../notes/documentStats";
import {
  defaultSlotName,
  emptyWorkspace,
  findItemPane,
  openInFocusedTab,
  resolveActiveSlot,
  sameItem,
  shouldFlushWorkspace,
  switchToSlot,
  wrapAsSingleSlot,
  type SlotId,
  type WorkspaceSlot,
} from "../notes/workspaceState";
import {
  deserializeWorkspaces,
  serializeWorkspaces,
  workspaceRead,
  workspaceStage,
  workspaceWrite,
  withDetached,
} from "../lib/workspace-persist";
import {
  setActiveWorkspace,
  setCustomTheme,
  toggleFavoriteOnDisk,
} from "../lib/prefs";
import { promptForText } from "../lib/promptForText";
import { QuickPicker, type QuickPickItem } from "../components/QuickPicker";
import { listCustomThemes } from "../lib/themes";
import { applyCustomTheme } from "../lib/theme";
import { ornamentRole } from "@myne/ornaments";
import { rewriteSelectionToEditor } from "../notes/ai/rewriteToEditor";

// Lazy-loaded so the tag-browser modal chunk stays out of the editor's initial
// bundle (tag-system #2 / MYND-46, task-1 criterion - confirmed as a separate
// build chunk). (GraphPane's shell is statically imported by PaneView and lazies
// only its heavy d3 canvas; TagBrowser has no comparable static host, so the whole modal
// splits.)
const TagBrowser = lazy(() =>
  import("../notes/components/TagBrowser").then((m) => ({
    default: m.TagBrowser,
  })),
);

const STATUS_TEXT_STYLE: CSSProperties = {
  fontSize: 12,
  color: "var(--fg-3)",
};

/**
 * Poll cadence (ms) for the MYND-308 coalesced workspace flush. The timer fires
 * often (~30 s) but the pure `shouldFlushWorkspace` gate only permits an actual
 * disk write ≤ once per `WORKSPACE_FLUSH_INTERVAL_MS` (5 min) of dirty activity,
 * so the blob's mtime stays a coarse (≤ ~5 min) signal - the SYNC-6 mtime-defense
 * relaxation, bounded + documented.
 */
const COALESCED_FLUSH_POLL_MS = 30_000;

/**
 * The toggleable BottomBar element ids + their menu labels (bottom-bar
 * customization). Single source of truth: the BottomBar gates each element's
 * render on `!hiddenItems.includes(id)`, and the right-click menu in
 * `EditorChrome` maps over this list to build its checkable items. Ids are a
 * closed, non-secret UI vocabulary persisted in `vault.prefs.hidden_bar_items`.
 */
/** vim-keyboard-mode (MYND-313): track the focused editor's vim mode for the
 *  bottom-bar indicator. The editor announces transitions as a bubbling
 *  `myne-vim-mode` event (and `null` when vim is switched off), so the indicator
 *  stays decoupled from CodeMirror internals and from the pane tree. */
function useVimMode(): string | null {
  const [mode, setMode] = useState<string | null>(null);
  useEffect(() => {
    const onMode = (e: Event) => {
      const { detail } = e as CustomEvent<VimModeEventDetail>;
      setMode(detail?.mode ?? null);
    };
    window.addEventListener(VIM_MODE_EVENT, onMode);
    return () => window.removeEventListener(VIM_MODE_EVENT, onMode);
  }, []);
  return mode;
}

// There is deliberately NO left cluster and NO graph launcher here any more.
// myne-md/myne#396 asked for a bottom-left launcher and this branch shipped one;
// using it settled the question the other way. A launcher pinned to a corner is
// a second, uncustomizable place for a command that the LEFT RIBBON already
// hosts on the user's own terms (myne-md/myne#699), and the graph also has a
// shortcut and a palette entry. So `graph.show` declares ribbon metadata and the
// bottom bar carries utilities only. #396 closes as superseded by the ribbon.

/** reading-source-modes (MYND-299): short i18n keys for the BottomBar view-mode
 *  switcher labels (resolved with t() at the render consumer to stay reactive). */
const VIEW_MODE_LABEL_KEY: Record<ViewMode, string> = {
  live: "editor.chrome.viewMode.live",
  reading: "editor.chrome.viewMode.reading",
  source: "editor.chrome.viewMode.source",
};
/** The switcher click cycles live → reading → source → live. */
const NEXT_VIEW_MODE: Record<ViewMode, ViewMode> = {
  live: "reading",
  reading: "source",
  source: "live",
};

/**
 * Device-local dismissal flag for the Obsidian-import onboarding offer (MYND-53,
 * story 1). The offer shows whenever an unlocked editor mounts AND this flag is
 * unset; picking "Choose folder…" or "Not now" sets it, so it appears until the
 * user dismisses it once and then never again (the migration wedge). A
 * non-sensitive UI boolean - a per-vault `vault.prefs` flag is a possible future
 * hardening (it would survive a localStorage clear + scope per-vault), but
 * device-local is sufficient for v0.1.
 */
const IMPORTER_OFFER_KEY = "myne.importer.onboarding-offer-dismissed";

interface EditorProps {
  /**
   * Callback invoked when the Editor mount guard fires (slot empty
   * despite Stage = `editor`) and the user clicks the "Lock" CTA
   * on the resulting `<FailClosedError reason="invalid-state" />`.
   * The parent (App.tsx) is responsible for re-probing
   * `vault_status` and routing to welcome/unlock based on the result.
   * The component itself only fires `vault_lock` (idempotent on
   * already-empty slot) before invoking this callback.
   */
  /**
   * The ACTIVE vault's id, threaded from `stage.vaultId` (#250).
   *
   * `undefined` only on the boot-probe slot-priority entry (a post-reload
   * editor), where no WebView-side id exists yet - the component resolves the
   * authoritative answer from the runtime slot in that case. Everything that
   * targets a vault (the danger-zone delete, the backup scheduler, the Settings
   * schedule block) reads the resolved value rather than ordering a
   * best-effort disk cache, which is what used to name the wrong vault after a
   * quick-unlock or a recovery.
   */
  vaultId?: string;
  onResetRequested?: () => void;
  /**
   * Settings → Storage "Restore from backup…" (MYND-56): routes OUT of the
   * editor into the pre-unlock-class restore Stage flow (`editor.restore-backup`).
   * The vault stays Unlocked - restore never touches the slot map.
   */
  onRestoreBackup: () => void;
  /**
   * Callback invoked when the user clicks the Lock affordance in the
   * editor's bottom bar. The parent (App.tsx) dispatches the
   * `editor.lock` Stage transition → `unlock(Exists)` (no intermediate
   * "locked" screen - the user lands directly on the password form).
   * This component fires `vault_lock()` IPC (idempotent) before
   * invoking the callback so the slot is wiped before the unlock form
   * renders.
   *
   * **Implicit decrypting-hide invariant:** Lock affordance only
   * mounts when stage = `editor`; `decrypting` is an `unlock` sub-
   * state during which `editor` is not mounted, so the affordance is
   * structurally absent during Argon2id (MYND-35 acceptance "decrypting
   * hide" satisfied without explicit conditional render).
   */
  onLock?: () => void;
  /**
   * Out-of-band Stage set wired from App.tsx's `setStageWithSuspicion`
   * callback. Threaded through to SettingsModal → AccountPanel for the
   * change-password force-relock paths: `InvalidVaultMeta` routes
   * through `{kind:"Corrupted"}` (no suspicionReason);
   * `VaultMetaChangedExternally` and `VaultLockedDuringChange` route
   * through `{kind:"Exists"}` with a `SuspicionReason` set. See
   * `decisions.md` 2026-05-08 "`Stage.unlock.suspicionReason?` field".
   */
  onForceRelock?: (status: StageVaultStatus, reason?: SuspicionReason) => void;
  /**
   * Pass-through to SettingsModal → AccountPanel. Fired on successful
   * `vault_delete` IPC OR Continue-after-partial-fail click. App.tsx
   * wires this to `reprobe()`; boot routing picks the return surface by
   * remaining vault count (picker at ≥2, unlock at 1, welcome at 0),
   * this Editor unmounts, the SettingsModal unmounts in cascade.
   */
  onDeleteVaultSuccess: () => void;
  /**
   * Multi-vault switch trigger (MYND-205, sub-feature 4). Invoked by the
   * account-chip switcher dropdown (task 5) when the user picks a non-active
   * vault. App.tsx's `switchVault` fires the param-less `vault_lock()`
   * (four-surface teardown + `flushIfDirty`, SYNC-8) then routes to the
   * target's unlock screen via `editor.switch-vault` → `unlock(Exists,
   * vaultId: target)`. The target's password entry happens on the Unlock
   * screen; selecting the active vault is a no-op the dropdown itself
   * suppresses. Optional so the component renders without the switcher wired
   * (single-vault users / pre-task-5 state).
   */
  onSwitchVault?: (targetVaultId: VaultId) => void;
  /**
   * Route to vault creation from the switcher dropdown's "Create another
   * vault" footer (MYND-205 task 5). App.tsx dispatches `editor.create-vault`
   * → the existing vault-creation flow (the same target as the picker's
   * "Create another" affordance). Optional - omitted → the footer is hidden
   * alongside the switcher (single-vault / pre-task-5 state).
   */
  onCreateAnother?: () => void;
  /**
   * Open the device-join modal from the switcher dropdown's "Add this device to
   * an account" footer (myne#221). App.tsx tears this vault down first - flush +
   * `vault_lock()` + `editor.lock` - and opens the modal it mounts globally over
   * the resulting unlock screen, because `sync_join_account` unlocks a DIFFERENT
   * vault and SYNC-1 zeroizes this one on the way.
   *
   * Optional and capability-gated by App.tsx: a client that holds one container
   * per origin cannot bootstrap a second vault, and an unavailable affordance is
   * omitted rather than disabled. Absence hides that one row, not the switcher -
   * so it is deliberately NOT part of `SidebarVaultSwitcher`'s null gate.
   */
  onJoinDevice?: () => void;
  /**
   * True while a switch's `vault_lock()` IPC is in flight (the brief
   * "switching…" window during which the prior vault flushes + tears down).
   * The account-chip dropdown (task 5) reads it to disable the chip + show the
   * per-row "switching…" caption.
   */
  switching?: boolean;
  /**
   * Set only inside a detached (pop-out) note window (myne#678 render, epic
   * #173). When present, this Editor instance opens that ONE note in a single
   * pane with both sidebars collapsed and skips the saved-workspace restore, so
   * a pop-out is the note's own focused surface rather than a second full app
   * window that could open other notes (SYNC-6: one note, one surface). `null`
   * everywhere else, including web/mobile where no OS window is ever spawned.
   */
  detachedNoteId?: string | null;
}

/**
 * Mount-time reality check (Q5β-1 belt+suspenders): the React Stage
 * machine says we're in `editor`, but the Rust-side slot might
 * actually be empty (devtools manipulation, routing regression,
 * post-lock race). Probe `vault_is_unlocked` once on mount; if the
 * slot is empty, render the fail-closed error UI in place of the
 * editor body.
 */
export function Editor({
  vaultId: stageVaultId,
  onResetRequested,
  onRestoreBackup,
  onLock,
  onForceRelock,
  onDeleteVaultSuccess,
  onSwitchVault,
  onCreateAnother,
  onJoinDevice,
  switching = false,
  detachedNoteId = null,
}: EditorProps) {
  const [slotPopulated, setSlotPopulated] = useState<boolean | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<EditorToast | null>(null);

  // myne#279 - publish the resolved date/time display settings into the shared
  // store every formatting surface reads. Mounted once, here, so nothing below
  // has to thread the three prefs down to the rows that print a date.
  useDateTimeDisplaySync();

  // #250 - the authoritative active-vault id for every vault-targeting surface
  // below. Prefer the id the stage already carries; fall back to the runtime
  // slot ONLY where the stage has none (post-reload editor entry). The old
  // answer, `resolveActiveVaultId()`, ordered the non-authoritative
  // `registry.json` cache - which only the password path ever stamped, so a
  // quick-unlocked or recovered session pointed the delete at another vault.
  const [activeId, setActiveId] = useState<string | null>(stageVaultId ?? null);
  useEffect(() => {
    if (stageVaultId != null) {
      setActiveId(stageVaultId);
      return;
    }
    let cancelled = false;
    void activeVaultId().then((id) => {
      if (!cancelled) setActiveId(id);
    });
    return () => {
      cancelled = true;
    };
  }, [stageVaultId]);

  const probed = useRef(false);
  useEffect(() => {
    if (probed.current) return; // StrictMode double-invoke guard
    probed.current = true;
    void (async () => {
      try {
        const ok = await isVaultUnlocked();
        setSlotPopulated(ok);
      } catch (e) {
        // IPC error itself is treated as invalid state - fail-closed
        // UI instead of the editor body. Surface to dev console so a
        // genuinely broken IPC channel doesn't masquerade as a
        // slot-empty signal silently.
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn("[Editor] vault_is_unlocked IPC rejected:", e);
        }
        setSlotPopulated(false);
      }
    })();
  }, []);

  // Device revocation, treated as TERMINAL on a client whose local copy is a
  // cache of a server-held vault (task 94). On desktop the same server code
  // keeps parking at re-enrol: erasing a user's own machine on a server signal
  // would be a new and unasked-for destructive power, so the gate is the
  // capability, not a platform name.
  const { status: syncStatusForRevocation } = useSyncStatus();
  const revokedTerminal =
    !has("localOnlyVault") &&
    syncStatusForRevocation?.state === "error" &&
    syncStatusForRevocation.detail === "device_revoked";

  // Mid-session storage health (task 22). Held as a one-way latch alongside the
  // unsynced set AT THE MOMENT OF LOSS: an evicted store cannot be read to find
  // out afterwards what had not been pushed, so the running session's own last
  // answer is the only place that knowledge still exists.
  const { lost: storageIsLost, health: storageHealthState } = useStorageHealth();
  const storageLost: "evicted" | "unopenable" | null = storageIsLost
    ? storageHealthState?.state === "unopenable"
      ? "unopenable"
      : "evicted"
    : null;
  // The unsynced set as of the loss. `useUnsyncedEdits` is polled here rather
  // than reached for from `EditorChrome` because THIS component is the one that
  // survives the loss - the editor body unmounts, and with it any memory of what
  // had not been pushed.
  const { unsyncedIds: unsyncedNoteIds } = useUnsyncedEdits();
  const lostUnsyncedRef = useRef<string[] | null>(null);
  if (storageIsLost && lostUnsyncedRef.current === null) {
    // Latched at the transition, not recomputed: the set is derived from storage
    // that no longer exists, so a later poll would legitimately return empty and
    // silently erase the report the user is standing in front of.
    lostUnsyncedRef.current = [...unsyncedNoteIds];
  }
  const lostUnsyncedTitles = lostUnsyncedRef.current ?? [];

  // Cmd/Ctrl+, (toggle Settings) now flows through the central keybind engine as
  // the rebindable `app.open-settings` command (#184 track D) - a WorkspaceHotkeys
  // entry wired to `setSettingsOpen`, no longer a hardcoded window listener here.

  if (slotPopulated === null) {
    // Loading shim - the IPC takes microseconds (single RwLock read);
    // a flash of nothing is invisible at human latency. Returning
    // null avoids any flash of the editor body before the guard
    // result arrives.
    return null;
  }

  // The local store went away underneath this live session (task 22). Checked
  // AFTER the slot guard and BEFORE the editor body: the slot guard answers "is
  // this session real", this answers "is the storage it reads from still there",
  // and rendering the editor between the two would put a user in a document they
  // cannot save.
  if (revokedTerminal) {
    return (
      <DeviceRevoked
        onEraseLocalCopy={async () => {
          // Lock first, then erase - the desktop ordering, and for the same
          // reason: keys must be gone before the bytes they could still read
          // are, so a failure part-way never leaves an unlocked session over a
          // half-erased container.
          await lockVault().catch(() => {});
          clearAgentForLock();
          // ONE erase (task 72), not a second implementation. The target is
          // required since #250 - a lock has already emptied the slot, so the
          // id must come from the stage-resolved value captured above, not from
          // a post-lock probe that would answer `null`.
          if (activeId != null) await deleteVault(activeId).catch(() => {});
        }}
        onDismiss={() => onResetRequested?.()}
      />
    );
  }

  if (storageLost !== null) {
    return (
      <StorageLost
        kind={storageLost}
        unsyncedTitles={lostUnsyncedTitles}
        onReDownload={() => {
          void (async () => {
            // Reuse the ONE erase (task 72) rather than writing a second: the
            // remaining container is unusable either way, and a second erase
            // path is a second thing to keep correct. A failure here is not
            // fatal - the boot probe re-routes regardless, and a browser that
            // could not erase an already-broken store has lost nothing more.
            if (activeId != null) await deleteVault(activeId).catch(() => {});
            onResetRequested?.();
          })();
        }}
        onLock={() => {
          void (async () => {
            await lockVault().catch(() => {});
            onResetRequested?.();
          })();
        }}
      />
    );
  }

  if (slotPopulated === false) {
    return (
      <FailClosedError
        reason={{ kind: "invalid-state" }}
        onCtaClick={() => {
          void (async () => {
            // vault_lock is idempotent (Ok(()) on already-empty slot)
            // - safe to call regardless of whether the slot is
            // genuinely empty or the IPC failed.
            await lockVault().catch(() => {
              // Even if lock rejects, we still want to re-probe
              // and route the user out of editor stage.
            });
            onResetRequested?.();
          })();
        }}
      />
    );
  }

  return (
    <SidebarStateProvider>
      {/* display:contents marker - the E2E suites' "editor mounted"
          signal (SYNC-8 testid pass). Renders after the mount-time
          vault_is_unlocked guard has passed, so its presence implies
          the Rust slot agreed with the React stage. */}
      <div style={{ display: "contents" }} data-testid="editor.root">
      <WorkspaceProvider>
        <EditorChrome
          vaultId={activeId}
          onLock={onLock}
          onForceRelock={onForceRelock}
          onDeleteVaultSuccess={onDeleteVaultSuccess}
          onSwitchVault={onSwitchVault}
          onCreateAnother={onCreateAnother}
          onJoinDevice={onJoinDevice}
          switching={switching}
          detachedNoteId={detachedNoteId}
          settingsOpen={settingsOpen}
          onRestoreBackup={onRestoreBackup}
          setSettingsOpen={setSettingsOpen}
          toast={toast}
          setToast={setToast}
        />
      </WorkspaceProvider>
      </div>
    </SidebarStateProvider>
  );
}

/**
 * Inner editor body - mounts inside `<SidebarStateProvider>` so it can
 * use `useSelectedNote()`. Owns the loaded-body state, the autosave
 * hook, Tauri close-intercept (T28), editor-blur listener (T29), and
 * the BottomBar's save-status / Lock-flush wiring.
 */
/** The Editor's single bottom-right toast: a message plus an optional
 *  inline action (the export flow's "Show in folder", MYND-116 task 4 -
 *  the soft-trash Undo precedent lives in NoteList's own toast). */
type EditorToast = {
  message: string;
  action?: ToastAction;
  variant?: ToastVariant;
};

type EditorChromeProps = {
  /** The resolved active vault id (#250) - `null` while still resolving. Feeds
   *  the backup scheduler and the Settings panels that target a vault. */
  vaultId: string | null;
  onLock?: () => void;
  onForceRelock?: (status: StageVaultStatus, reason?: SuspicionReason) => void;
  onDeleteVaultSuccess: () => void;
  onSwitchVault?: (targetVaultId: VaultId) => void;
  onCreateAnother?: () => void;
  onJoinDevice?: () => void;
  switching: boolean;
  /** Detached (pop-out) note id, or null in the main window. See `EditorProps`. */
  detachedNoteId: string | null;
  settingsOpen: boolean;
  onRestoreBackup: () => void;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  toast: EditorToast | null;
  setToast: Dispatch<SetStateAction<EditorToast | null>>;
};

function EditorChrome({
  vaultId,
  onLock,
  onForceRelock,
  onDeleteVaultSuccess,
  onSwitchVault,
  onCreateAnother,
  onJoinDevice,
  switching,
  detachedNoteId,
  settingsOpen,
  onRestoreBackup,
  setSettingsOpen,
  toast,
  setToast,
}: EditorChromeProps) {
  const { t } = useTranslation();
  const ctx = useSelectedNote();
  const ws = useWorkspace();

  // The meeting-session controller needs the sidebar surface (`refreshOne` +
  // `open`) at STOP, to register and open the note the session created. The
  // `EditorHost` seam only carries the `EditorView`, so the surface is bound
  // here — the one place `useSelectedNote()` is in scope — and the `/meeting`
  // slash command reads the binding at dispatch. Same shape `voiceRecord` uses:
  // the trigger lives in the shared package, the flow stays desktop-side.
  useEffect(() => {
    setMeetingSidebarSurface({
      refreshOne: (id) => ctx.refreshOne(id as NoteId),
      open: (id) => ctx.open(id as NoteId),
    });
    return () => {
      setMeetingSidebarSurface(null);
    };
  }, [ctx]);
  // First-run AI onboarding (myne-md/myne#805): offered once per DEVICE, after
  // the first successful unlock, gated on a localStorage flag so it covers every
  // entry path (create/restore/recover/join). Skippable; the app works without
  // AI. It lives here, in the chrome, because the modal mounts are local to
  // `EditorChrome`. Initialised from the flag so it opens on the first render
  // after unlock and closes for the rest of the process.
  const [aiOnboardingOpen, setAiOnboardingOpen] = useState<boolean>(
    () => !readAiOnboardingSeen(),
  );
  const closeAiOnboarding = useCallback(() => {
    writeAiOnboardingSeen();
    setAiOnboardingOpen(false);
  }, []);
  // Task-chip ink is a device-local display choice (myne-md/myne#656 item 4).
  // Published as a CSS variable at the document root so BOTH the panel rows and
  // the editor's inline chips follow it by construction - no per-surface
  // plumbing, no CodeMirror theme recompilation. `chipColor` is a closed enum,
  // so only a token this app owns ever reaches the style.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--task-chip-ink", TASK_CHIP_INK[ws.taskDisplay.chipColor]);
    if (ws.taskDisplay.iconOnly) root.setAttribute("data-task-chip-icon-only", "true");
    else root.removeAttribute("data-task-chip-icon-only");
    return () => {
      root.style.removeProperty("--task-chip-ink");
      root.removeAttribute("data-task-chip-icon-only");
    };
  }, [ws.taskDisplay.chipColor, ws.taskDisplay.iconOnly]);
  // Panel Settings should open on (myne-md/myne#699): the left ribbon's
  // "Customize ribbon…" asks for Appearance; every other entry point clears it.
  const [settingsPanel, setSettingsPanel] = useState<PanelId | null>(null);
  // The setting to land ON, not merely the panel it lives in. A panel is nine
  // blocks tall and "Customize ribbon…" used to drop the user at the top of it.
  const [settingsAnchor, setSettingsAnchor] = useState<string | null>(null);
  const openSettings = useCallback(
    (panel: PanelId | null = null, anchor: string | null = null) => {
      setSettingsPanel(panel);
      setSettingsAnchor(anchor);
      setSettingsOpen(true);
    },
    [setSettingsOpen],
  );
  // The rail is a sibling subtree, so its right-click entry reaches Settings
  // through the service locator.
  useEffect(() => {
    ribbonCommands.customizeRibbon = () =>
      openSettings("appearance", "appearance.ribbon");
    return () => {
      ribbonCommands.customizeRibbon = undefined;
    };
  }, [openSettings]);
  // myne#681 task 2 (SYNC-11): in a detached (pop-out) window, set when the note
  // this window holds is deleted from ANOTHER surface (a `notes://deleted` event
  // whose payload matches `detachedNoteId`). The window then shows a terminal
  // "deleted elsewhere" state rather than reloading to an empty editor or yanking
  // shut mid-edit. Never set in the main window (`detachedNoteId` is null there).
  const [deletedElsewhere, setDeletedElsewhere] = useState(false);
  // Keep-both (MYND-427): drain the sync engine's staged concurrent-edit
  // conflicts → materialize each remote revision as a `conflict_of:` copy →
  // refresh the sidebar so it appears. Both edits survive; nothing is lost.
  useConflictMaterializer(
    useCallback(() => {
      void noteList()
        .then((ids) => ctx.refreshAll(ids))
        .catch(() => {});
    }, [ctx]),
  );
  // Plain-message sink for the pre-existing string consumers (Settings,
  // backup export, importer); the export flow goes through the structured
  // `showExportToast` below so success can carry its reveal action.
  const showToastMessage = useCallback(
    (message: string, variant?: ToastVariant) => setToast({ message, variant }),
    [setToast],
  );
  /** MYND-643: copy a note's body to the clipboard. Takes the target note id
   *  explicitly - the export modal's Copy fires for the note the pre-flight is
   *  about, which the sidebar context-menu path raises for a note that is not
   *  necessarily open (the ne4 defect: falling back to `ctx.selectedId` copied
   *  nothing when nothing was open). A clipboard write has no visible result,
   *  so success MUST toast - otherwise the button reads as broken - and so must
   *  failure, or the user pastes stale content believing it worked. */
  const copyNoteMarkdownById = useCallback(
    async (id: string) => {
      try {
        const { copyNoteMarkdown } = await import("../notes/copyNoteMarkdown");
        await copyNoteMarkdown(id, {
          onSuccess: {
            kind: "toast",
            run: () =>
              setToast({ message: i18n.t("export.note.modal.copied"), variant: "success" }),
          },
          onFailure: {
            kind: "toast",
            run: () =>
              setToast({ message: i18n.t("export.note.modal.copyFailed"), variant: "error" }),
          },
        });
      } catch {
        // The READ failed (or the module import did). Distinct from a refused
        // clipboard, which the pair above already reported, but the user-facing
        // outcome is the same sentence: nothing reached the clipboard.
        setToast({ message: i18n.t("export.note.modal.copyFailed"), variant: "error" });
      }
    },
    [setToast],
  );

  const showExportToast = useCallback(
    (t: ExportToast) =>
      setToast({
        message: t.message,
        action: exportToastAction(t, () => setToast(null)),
      }),
    [setToast],
  );
  // Pre-flight "Include N attachments" modal (MYND-116 task 3): the flow
  // asks through a promise-backed hook; the payload state mounts the
  // modal, and settling either way unmounts it. Identical from the
  // context-menu and palette paths - both receive the same hooks.
  const [exportPreflight, setExportPreflight] = useState<{
    count: number;
    noteId: string;
    resolve: (choice: AttachmentPreflightChoice | null) => void;
  } | null>(null);
  const confirmAttachments = useCallback(
    (count: number, noteId: string) =>
      new Promise<AttachmentPreflightChoice | null>((resolve) => {
        setExportPreflight({ count, noteId, resolve });
      }),
    [],
  );
  // PDF pre-export exclusion notice (MYND-255 task 5) - same promise-
  // backed pattern: the payload state mounts `NotePdfExportNotice`, and
  // settling either way unmounts it.
  const [pdfPreflight, setPdfPreflight] = useState<{
    excluded: readonly ExcludedAttachment[];
    resolve: (proceed: boolean) => void;
  } | null>(null);
  const confirmPdfExclusions = useCallback(
    (excluded: readonly ExcludedAttachment[]) =>
      new Promise<boolean>((resolve) => {
        setPdfPreflight({ excluded, resolve });
      }),
    [],
  );
  // Egress disclosure for the DOWNLOAD delivery path (phase3-web-client task
  // 98) - same promise-backed pattern again. Reached only where `nativeSaveAs`
  // is absent: on desktop the save dialog's title carries the sentence and the
  // flows never call this.
  const [egressPreflight, setEgressPreflight] = useState<{
    sentence: string;
    resolve: (proceed: boolean) => void;
  } | null>(null);
  const confirmEgress = useCallback(
    (sentence: string) =>
      new Promise<boolean>((resolve) => {
        setEgressPreflight({ sentence, resolve });
      }),
    [],
  );
  // If the Editor unmounts mid-question (lock / force-relock), resolve
  // any pending pre-flight with its cancel value so the awaiting flow
  // (and, on the PDF path, its held body string) isn't stranded forever.
  const exportPreflightRef = useRef(exportPreflight);
  exportPreflightRef.current = exportPreflight;
  const pdfPreflightRef = useRef(pdfPreflight);
  pdfPreflightRef.current = pdfPreflight;
  const egressPreflightRef = useRef(egressPreflight);
  egressPreflightRef.current = egressPreflight;
  useEffect(
    () => () => {
      exportPreflightRef.current?.resolve(null);
      pdfPreflightRef.current?.resolve(false);
      // Unmounting mid-question resolves to REFUSE, not proceed: a lock or a
      // force-relock is the one moment where silently delivering plaintext the
      // user never confirmed would be worst.
      egressPreflightRef.current?.resolve(false);
    },
    [],
  );
  const exportHooks = useMemo<NoteExportUiHooks>(
    () => ({
      showToast: showExportToast,
      confirmAttachments,
      confirmPdfExclusions,
      confirmEgress,
    }),
    [showExportToast, confirmAttachments, confirmPdfExclusions, confirmEgress],
  );
  const [paletteOpen, setPaletteOpen] = useState<boolean>(false);
  // Backup-export modal (MYND-56 task 1).
  const [backupExportOpen, setBackupExportOpen] = useState<boolean>(false);
  // Whole-vault markdown export modal (MYND-211 task 3) - same Editor-local
  // boolean carve-out; opened from Settings → Storage and the palette.
  const [vaultExportOpen, setVaultExportOpen] = useState<boolean>(false);
  // Scope-dropdown options: the sidebar's folder-tree source, derived only
  // while the modal is open (cache identity changes on every mutation).
  const vaultExportFolders = useMemo(
    () =>
      vaultExportOpen ? collectFolderOptions(ctx.cache.values()) : [],
    [vaultExportOpen, ctx.cache],
  );
  const [snapshotsOpen, setSnapshotsOpen] = useState<boolean>(false);
  // Tag browser (tag-system #2 / MYND-46): modal carve-out + an optional seed
  // tag (set by the editor `#tag` chip, #3, to open filtered to one tag).
  const [tagsOpen, setTagsOpen] = useState<boolean>(false);
  const [tagsSeed, setTagsSeed] = useState<string | null>(null);
  // MYND-53 - Obsidian importer: the active-import modal + the onboarding offer
  // (shown on editor mount until dismissed once; IMPORTER_OFFER_KEY).
  const [importerOpen, setImporterOpen] = useState<boolean>(false);
  const [offerOpen, setOfferOpen] = useState<boolean>(false);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(IMPORTER_OFFER_KEY) !== "1") {
        setOfferOpen(true);
      }
    } catch {
      // localStorage unavailable (private mode / blocked) → just skip the offer.
    }
  }, []);

  const dismissImporterOffer = useCallback(() => {
    setOfferOpen(false);
    try {
      window.localStorage.setItem(IMPORTER_OFFER_KEY, "1");
    } catch {
      // Best-effort - if persistence fails the worst case is the offer reappears.
    }
  }, []);

  const handleImported = useCallback(
    (result: ImportResult | null) => {
      // A null result = the import ended in a hard error (the modal shows its own
      // error); skip the success toast but STILL refresh the sidebar below so any
      // notes created before the failure appear immediately.
      if (result !== null) {
        const skipped =
          result.skippedExisting > 0
            ? t("editor.chrome.import.skippedSuffix", {
                count: result.skippedExisting,
              })
            : "";
        showToastMessage(
          t("editor.chrome.import.imported", {
            count: result.imported,
            skipped,
          }),
        );
      }
      // Repopulate the sidebar so the imported notes appear immediately.
      void noteList()
        .then((ids) => ctx.refreshAll(ids))
        .catch(() => {
          /* sidebar stays as-is until the next refresh - non-fatal */
        });
    },
    [ctx, showToastMessage, t],
  );

  // Cmd/Ctrl+Shift+G opens the whole-vault graph tab (MYND-198, SYNC-7) - the
  // third entry point alongside the command-palette action + BottomBar button.
  // Now the rebindable `graph.show` command routed through the keybind engine
  // (#184 track D), a WorkspaceHotkeys entry → `ws.openGraph()`; no longer a
  // hardcoded window listener here.
  // Editor `#tag` chip click (tag-system #3 / MYND-45): the chip decoration
  // dispatches a bubbling `myne-open-tag` event; open the tag browser seeded to
  // that tag. A single Editor-level listener (the modal is Editor-global) - no
  // per-pane prop threading.
  useEffect(() => {
    const onOpenTag = (e: Event) => {
      const tag = (e as CustomEvent<{ tag?: string }>).detail?.tag;
      if (typeof tag === "string" && tag !== "") {
        setTagsSeed(tag);
        setTagsOpen(true);
      }
    };
    window.addEventListener("myne-open-tag", onOpenTag);
    return () => window.removeEventListener("myne-open-tag", onOpenTag);
  }, []);
  // A task written from a LIST surface (MYND-616 task 8) changes a note's bytes
  // out-of-band of any pane's own autosave, so every open pane must re-read.
  // `reloadOpenNote` is the existing blanket bump used after a sync pull - each
  // pane applies its own dirty guard, so it never clobbers in-flight typing.
  useEffect(() => {
    const onWritten = (): void => ctx.reloadOpenNote();
    window.addEventListener(TASK_WRITE_EVENT, onWritten);
    return () => window.removeEventListener(TASK_WRITE_EVENT, onWritten);
  }, [ctx]);
  // Editor task-field chip activation (MYND-614 tasks 6 + 7): the chip
  // decoration dispatches a bubbling `myne-open-task-chip` event; open the
  // field editor anchored to that chip and write the result back through the
  // single writer seam. Same Editor-level-listener shape as the `#tag` chip
  // above, and for the same reason - no per-pane prop threading.
  //
  // Because the chips never open on caret entry, this listener is the ONLY way
  // to edit these values in live mode. It is therefore load-bearing rather than
  // convenience wiring: without it the chips render and do nothing. The listener
  // itself lives in the shared editor package so desktop and mobile install the
  // SAME implementation (`installTaskChipEditor`) rather than two copies.
  useEffect(() => installTaskChipEditor(), []);
  const [newFromTemplateOpen, setNewFromTemplateOpen] = useState<boolean>(false);
  // Bottom-bar readout (save status + word count) - reported up by
  // whichever PaneView is currently focused (MYND-166). Per-pane PaneViews
  // own content load, autosave, word count, and the surgical sidebar
  // refresh-after-save; the chrome just mirrors the focused pane's readout.
  const [readout, setReadout] = useState<PaneReadout>({
    status: { status: "clean" },
    stats: null,
    selectionStats: null,
    retry: () => {},
  });
  const onReadout = useCallback((r: PaneReadout) => setReadout(r), []);
  // MYND-170 (SYNC-9): which surface the center pane shows. The shell +
  // sidebars persist; only this region swaps.

  // Resizable/collapsible sidebar layout (MYND-137). Widths + collapse
  // flags are persisted to vault.prefs and clamped on load; `rowRef`
  // measures the three-pane row live so a drag honors the center-pane
  // minimum.
  const layout = useEditorLayout();
  const rowRef = useRef<HTMLDivElement | null>(null);

  // Bottom-bar customization: persisted set of hidden BottomBar element ids +
  // its right-click menu anchor. `usePrefs` reads the set reactively (and
  // re-reads on the cross-surface prefs nonce); `setHiddenBarItems` persists
  // optimistically. `barMenu` holds the click coords while the menu is open.
  const { prefs: barPrefs, setHiddenBarItems, setBarItemsOrder } = usePrefs();
  const hiddenBarItems = barPrefs.hidden_bar_items;

  // Task reminders, in-app tier (MYND-618). Mounted in THIS component rather than
  // the outer `Editor`, and the reason is structural: the task index reads the
  // sidebar's live/trashed set, so it needs `<SidebarStateProvider>` - which is
  // what this component is inside. In the outer one the hook would also run on
  // the fail-closed path, where no provider exists and no editor body renders.
  // It reads `barPrefs` rather than calling `usePrefs` again, since a second call
  // is a second `prefsRead` IPC for a value already in hand.
  //
  // This component's lifetime is still the unlocked session's, so the scheduler's
  // is too, and `reminderLifecycle`'s cancel-everything-on-lock is satisfied by
  // this unmount rather than by a second signal kept in step with the first.
  //
  // The toast is deliberately **content-free** even though it never leaves the
  // app. `ReminderPayload` carries `{id, at}` and nothing else; resolving the id
  // back to its task here to quote the text would make that contract look soft,
  // while a reminder can still surface over a shared screen. It says a reminder
  // is due - the task surfaces say which.
  const reminderTasks = useLiveVaultTasks();
  const reminderNotifier = useMemo(
    () =>
      createInAppNotifier({
        deliver: () => setToast({ message: i18n.t("tasks.reminder.due"), variant: "info" }),
      }),
    [setToast],
  );
  useEffect(() => () => reminderNotifier.dispose(), [reminderNotifier]);
  useReminderScheduler({
    enabled: barPrefs.reminders_enabled,
    tasks: reminderTasks,
    notifier: reminderNotifier,
    horizonDays: barPrefs.reminder_horizon_days,
  });
  // `barMenu` holds the open menu's anchor coords + which mode it is in: a
  // plain `{x, y}` opens the bar-wide visibility checklist (right-click on
  // empty bar space); an entry with `itemId` opens the per-item menu (move
  // left / move right / hide) for that specific dragged-or-clicked item, with
  // `visibleIds` (the currently-rendered ordered ids) for move-availability.
  const [barMenu, setBarMenu] = useState<{
    x: number;
    y: number;
    itemId?: string;
    visibleIds?: string[];
  } | null>(null);

  // MYND-192 - transient responsive auto-collapse. When the window gets too
  // narrow to fit the center editor + sidebars, the backlinks (right) pane
  // yields first, then the notes (left). It is a non-persisted override:
  // effective collapse = the user's persisted choice OR a width-forced
  // collapse, and widening restores the manual state untouched. Feed the
  // RENDERED widths (0 for a manually-collapsed side) so a collapsed side
  // frees room for the other.
  const forced = useResponsiveCollapse(
    rowRef,
    layout.leftCollapsed ? 0 : layout.leftWidth,
    layout.rightCollapsed ? 0 : layout.rightWidth,
  );
  // focus-mode (MYND-348): ephemeral distraction-free state. When active the
  // sidebars collapse (reclaiming editor width) and the tab strip / bottom bar /
  // title-bar cluster fade via the `[data-focus-active]` CSS rule (tokens.css).
  // Not persisted (opt in each session); exit via ⇧⌘F or Esc.
  const [focusActive, setFocusActive] = useState(false);
  const toggleFocus = useCallback(() => setFocusActive((v) => !v), []);
  const exitFocus = useCallback(() => setFocusActive(false), []);
  // myne#678: a detached (pop-out) window force-collapses BOTH sidebars, so the
  // note it was popped out for is its only surface and no sidebar can open
  // another (SYNC-6). This is the render half of the single-note seed above.
  const detached = detachedNoteId != null;
  // Whether the left ribbon is actually on screen (myne-md/myne#699). Mirrors
  // `LeftRibbon`'s own hidden conditions plus the show/hide pref, and gates the
  // title-band rule so a ribbon that is off leaves no stray line at the edge.
  const ribbonShown =
    barPrefs.ribbon_visible !== false &&
    !(focusActive || detached || forced.forceLeftCollapsed);
  const leftCollapsed =
    layout.leftCollapsed || forced.forceLeftCollapsed || focusActive || detached;
  const rightCollapsed =
    layout.rightCollapsed || forced.forceRightCollapsed || focusActive || detached;
  // macOS floats the traffic lights over the top-left, so windowed builds inset
  // the sidebar toggle past them. In fullscreen the traffic lights are hidden -
  // drop that gap so the toggle sits flush-left (matching the non-mac layout).
  const isFullscreen = useIsFullscreen();
  const leftToggleX =
    HAS_OVERLAY_WINDOW_CONTROLS && !isFullscreen ? TRAFFIC_LIGHT_GAP + 16 : 12;
  const leftClearance = leftToggleX + LEFT_CONTROLS_WIDTH + 8;
  // Is anything FLOATED in the top-right corner? Two things can be, the
  // note-actions "…" menu and the right-sidebar toggle, and they share one
  // condition, because both act on the OPEN NOTE: a non-note tab (the graph, the
  // task list, a saved view) has no note for either to act on, and the
  // attachments view replaces the pane entirely (myne-md/myne#656 review).
  //
  // It is one constant because three consumers must agree about it: the tab
  // strip's right clearance, the toggle's own render, and the "…" menu's. They
  // were two copies before, and the copy the clearance used did not know about
  // the note-tab condition, so on the graph tab the strip reserved room for two
  // controls that were not there and its caret floated a control's width off the
  // right edge (myne-md/myne#727).
  const topRightFloatsShown = topRightFloats({
    focusedTabKind: ws.focusedLeaf.activeTab?.kind,
    pendingNewTabPaneId: ws.pendingNewTabPaneId,
    focusedPaneId: ws.focusedPaneId,
  });

  // Reveal the Saved Views surface (MYND-274) - the "Views" section lives in the
  // left (notes) sidebar, so revealing it ensures that sidebar is expanded, then
  // nudges the section to scroll into view + briefly highlight so the click
  // always lands somewhere visible (even when the sidebar was already open). A
  // width-forced collapse can't be toggled away (MYND-192) and the section would
  // be unmounted, so there is nothing to reveal - bail without firing the signal.
  // Shared by the palette `views.show` action + the BottomBar `editor.views-cta`
  // (SYNC-7).
  const revealViews = useCallback(() => {
    if (forced.forceLeftCollapsed) return;
    if (layout.leftCollapsed) {
      layout.toggleLeftCollapsed();
    }
    requestRevealViews();
  }, [layout, forced.forceLeftCollapsed]);

  // Expand the left sidebar for the palette's sidebar-owned surfaces (Wave 4:
  // new folder / trash / archive). Their UI lives inside the left SidebarPane,
  // which is `inert` while collapsed - including focus mode - so the actions
  // would no-op or open a ghost surface without this. Same reveal discipline as
  // `revealViews` above: exit focus mode, un-collapse a manual collapse, and
  // report a width-forced collapse (MYND-192) as unexpandable so the caller
  // skips its surface instead of ghost-opening it. Registered on the Editor
  // (not NoteList) because the layout + focus state live here.
  useEffect(() => {
    sidebarCommands.revealSidebar = () => {
      if (forced.forceLeftCollapsed) return false;
      if (focusActive) exitFocus();
      if (layout.leftCollapsed) layout.toggleLeftCollapsed();
      return true;
    };
    return () => {
      sidebarCommands.revealSidebar = undefined;
    };
  }, [layout, forced.forceLeftCollapsed, focusActive, exitFocus]);

  // Import a `.base` saved-views file (Saved Views #6, MYND-276, task 6): pick a
  // single `.base` file (no new capability - dialog:allow-open already granted),
  // run the shipped import entry point (read → parse → map → persist into
  // vault.prefs), and surface a concise SYNC-12 summary toast. The picked path's
  // parent directory is the root passed to the root-confined importer read seam.
  const importBaseView = useCallback(async () => {
    const picked = await openDialog({
      multiple: false,
      directory: false,
      filters: [
        {
          name: t("editor.chrome.baseImport.fileFilterName"),
          extensions: ["base"],
        },
      ],
    });
    if (picked === null) return; // cancelled - no toast
    try {
      // The root-confining directory split lives in importBase (sealed seam).
      const tally = await importBaseFilePath(picked);
      let message = t("editor.chrome.baseImport.imported", {
        count: tally.importedViews,
      });
      if (tally.skippedViews > 0) {
        message += t("editor.chrome.baseImport.skippedSuffix", {
          count: tally.skippedViews,
        });
      }
      if (tally.droppedUnsupportedFilters > 0) {
        message += t("editor.chrome.baseImport.droppedFiltersSuffix", {
          count: tally.droppedUnsupportedFilters,
        });
      }
      setToast({ message });
    } catch (e) {
      if (e instanceof BaseParseError) {
        setToast({ message: t("editor.chrome.baseImport.notValid"), variant: "error" });
      } else if (e instanceof BaseImportPersistError) {
        // Count-only (SYNC-12) - never surface the failed view's name in copy.
        setToast({
          message: t("editor.chrome.baseImport.stoppedAfter", {
            count: e.persistedCount,
          }),
        });
      } else {
        setToast({ message: t("editor.chrome.baseImport.failed"), variant: "error" });
      }
    }
  }, [setToast, t]);

  // MYND-170 (SYNC-9) exclusive active-state: selecting a note in the sidebar
  // (from ANY source - row click, keyboard nav, command palette, favorites,
  // jump-from-attachment) closes the Attachments view and returns the center
  // pane to that note's editor. Keying on `selectedId` makes the swap general:
  // opening Attachments does NOT change `selectedId`, so this never fires when
  // the user enters the library; it fires only when the selection genuinely
  // changes. The sidebar's Attachments entry and a note row are therefore
  // mutually exclusive in the active highlight - opening one deactivates the
  // other. Skips the initial mount so a fresh editor doesn't redundantly
  // re-assert "editor" (it already starts there).
  // Selecting a note used to have to swap the center view back to the editor,
  // because the attachment library replaced the whole pane tree. As a tab it
  // does not: `ctx.open` puts the note in the focused pane, which IS the way
  // back (myne-md/myne#773).

  // MYND-173: the generic file-card's "Reveal in library" action fires a window
  // event (the card lives in a CM6 widget, outside React). Open the attachments
  // library in response. Select-by-id within the library is deferred (PRD open
  // question) - this opens the library unfocused, which is the sanctioned
  // first-cut fallback.
  useEffect(() => {
    const onReveal = () => ws.openAttachments();
    window.addEventListener(REVEAL_ATTACHMENT_EVENT, onReveal);
    return () => window.removeEventListener(REVEAL_ATTACHMENT_EVENT, onReveal);
  }, [ws]);

  // MYND-424: the background sync loop emits `sync://changed` after writing
  // pulled notes to disk. Reload the sidebar + the open note so incoming edits
  // from another device appear without a manual refresh. Subscribe ONCE (the
  // ref keeps the handler on the latest selection context); no-op outside Tauri.
  const syncCtxRef = useRef(ctx);
  syncCtxRef.current = ctx;
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const handle = await listen("sync://changed", () => {
          if (cancelled) return;
          void noteList()
            .then((ids) => syncCtxRef.current.refreshAll(ids))
            .then(() => syncCtxRef.current.reloadOpenNote())
            .catch(() => {
              /* the next sync tick / manual refresh catches up */
            });
        });
        if (cancelled) handle();
        else unlisten = handle;
      } catch {
        // Not inside Tauri (browser dev shim) → no sync events.
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten !== undefined) unlisten();
    };
  }, []);

  // #258: the `myne` CLI writes into the SAME vault this editor has open, and
  // nothing told the editor. An open pane holds the note's body and base hash
  // from the moment it loaded, so `myne daily --append` landed on disk and the
  // pane's next autosave wrote its stale body straight over it. With sync OFF
  // there is no base-hash guard to catch it, and the snapshot window hides the
  // loss - the overwriting save coalesces with the pane's earlier ones, so the
  // CLI's line never gets a revision of its own to restore from.
  //
  // Same listener shape and same handler as the sync pull above, deliberately:
  // "someone else wrote to this vault" is one condition, and the CLI is just
  // another writer. The pane applies its own dirty guard on reload, so this
  // never clobbers in-flight typing.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const handle = await listen(CLI_NOTES_CHANGED_EVENT, () => {
          if (cancelled) return;
          void noteList()
            .then((ids) => syncCtxRef.current.refreshAll(ids))
            .then(() => syncCtxRef.current.reloadOpenNote())
            .catch(() => {
              /* a manual refresh catches up */
            });
        });
        if (cancelled) handle();
        else unlisten = handle;
      } catch {
        // Not inside Tauri (browser dev shim) → there is no CLI either.
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten !== undefined) unlisten();
    };
  }, []);

  // MYND-478: the sync loop merges remote `vault.prefs` changes onto disk and
  // emits `PREFS_SYNC_APPLIED_EVENT` (never for the user's own IPC writes -
  // their own resolve is the signal). Bridge it into the two local refresh
  // signals so an incoming vault rename / shared-pref change shows live: the
  // switcher's window event (chip + rows) and the prefs nonce (usePrefs
  // consumers). Subscribe ONCE; no-op outside Tauri.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const handle = await listen(PREFS_SYNC_APPLIED_EVENT, () => {
          if (cancelled) return;
          notifyVaultPrefsChanged();
          bumpPrefsNonce();
        });
        if (cancelled) handle();
        else unlisten = handle;
      } catch {
        // Not inside Tauri (browser dev shim) → no sync events.
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten !== undefined) unlisten();
    };
  }, []);

  // MYND-166 selection bridges - two one-way syncs that never loop
  // (A only fires for a note open in NO pane; B only mirrors):
  //  A) a selection arriving via a non-pane path (a freshly-created note,
  //     the command palette, a backlink / template / today-note open, the
  //     post-delete adjacent pick) is opened into the focused pane.
  //  B) the focused pane's active note is mirrored back into `selectedId`
  //     so the sidebar highlight / rename / F2 + the right-sidebar backlinks
  //     keep tracking the focused pane.
  const { openInFocused } = ws;
  const selectedId = ctx.selectedId;
  // myne#655: never OPEN a note that no longer exists. Bridge B below stops
  // mirroring a dead id; this stops resurrecting one that reached `selectedId`
  // by any other route. Either check alone would break the loop, and both are
  // here because each is the correct rule for its own direction: a bridge that
  // opens deleted notes is wrong whether or not anything is feeding it one.
  //
  // Liveness is a DEP, not a fire-time read, and that distinction is the whole
  // fix. Reading `ctx.cache` inside the effect with `cache` left out of the
  // deps makes the guard latch: at boot the workspace blob (one small read)
  // can restore a tab before `refreshAll` has decrypted the note list, so the
  // guard rejects once against an empty cache and, since nothing in the dep
  // array changed, never runs again. `selectedId` then stays wrong for the
  // whole session. A boolean keyed on this one id costs none of the per-render
  // re-runs that reading the whole `Map` would.
  const selectedIsLive = selectedId !== null && ctx.cache.has(selectedId);
  useEffect(() => {
    const where =
      selectedId === null
        ? null
        : findItemPane(
            { root: ws.root, focusedPaneId: ws.focusedPaneId },
            { kind: "note", id: selectedId },
          );
    if (!shouldOpenIntoFocusedPane(selectedId, selectedIsLive, where !== null)) return;
    openInFocused(selectedId!);
    // `ws.root` is read at fire time; the effect triggers only on a real
    // selection change or a liveness flip, never per-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, selectedIsLive, openInFocused]);

  const focusedActive = ws.focusedLeaf.activeTab;
  // reading-source-modes (MYND-299): the focused note tab's effective view mode
  // for the BottomBar switcher - the tab's own mode, else the default pref, else
  // live; null when no note tab is active (hides the switcher).
  const focusedTabViewMode: ViewMode | null =
    focusedActive !== null && focusedActive.kind === "note"
      ? focusedActive.viewMode ?? asViewMode(barPrefs.editor_default_view_mode)
      : null;
  // The sidebar highlight / backlinks track the focused pane's active NOTE; a
  // view-kind active tab (MYND-274) clears the note selection.
  const focusedActiveNoteId =
    focusedActive?.kind === "note" ? focusedActive.id : null;
  // Per-note "not yet on the server" (phase3-web-client task 23). The sidebar
  // row carries the same marker; this repeats it in the bottom bar so the state
  // is still visible with the sidebar collapsed - which is the layout a user
  // writing at length is most likely to be in.
  const { unsyncedIds: unsyncedNoteIds, credentialPending } = useUnsyncedEdits();
  const focusedNoteUnsynced =
    focusedActiveNoteId !== null && unsyncedNoteIds.has(focusedActiveNoteId);
  const select = ctx.select;
  // Same shape as bridge A's `selectedIsLive`, and required for the same
  // reason: a fire-time cache read with the cache out of the deps latches on
  // the boot race and never re-evaluates.
  const focusedIsLive =
    focusedActiveNoteId === null || ctx.cache.has(focusedActiveNoteId);
  useEffect(() => {
    // myne-md/myne#655: mirror only a note that still EXISTS.
    //
    // The two bridges are documented above as one-way and non-looping, and they
    // are: for a note that is alive. A note being deleted breaks the premise
    // for a moment: the cache row is dropped optimistically, and the tab is
    // removed from every pane by a separate `setState`. In between, the focused
    // pane's active tab can still be the dead note. This bridge then mirrors the
    // dead id into `selectedId`, bridge A finds it open in no pane (its tabs are
    // going away) and re-opens it into the focused pane, which makes it the
    // active tab again, and the two hand it back and forth, remounting the pane
    // each time. That is the flashing, unstoppable swap that was reported.
    //
    // The cache is the liveness roster the sidebar already renders from, so
    // checking it here costs nothing and closes the loop at its source: a
    // deleted note stops being mirrored, so it stops being re-opened.
    if (!shouldMirrorSelection(focusedActiveNoteId, focusedIsLive)) return;
    select(focusedActiveNoteId);
  }, [focusedActiveNoteId, focusedIsLive, select]);

  // MYND-121 - report window-level activity to the backend auto-lock idle
  // timer. The Editor is mounted iff the vault is Unlocked, so the heartbeat
  // runs exactly while a lockable session is live.
  useActivityHeartbeat();

  // MYND-351 - automatic local-backup scheduler (Model A: runs only while the
  // app is open and a vault is unlocked, i.e. exactly while this Editor is
  // mounted). A backup must never fail silently: a fresh failure (debounced so
  // a persistent failure toasts once) surfaces the quiet alert; success is a
  // silent status line the StoragePanel reads. The schedule never auto-disables.
  useBackupScheduler(vaultId, (scheduleTick) => {
    if (scheduleTick.freshFailure) {
      setToast({ message: BACKUP_SCHEDULE_FAILED_TOAST, variant: "error" });
    }
  });

  // Close / lock / idle-lock flush EVERY pane's pending save via the
  // workspace flush registry (each PaneView registers its `flushIfDirty`).
  // Per-pane PaneViews own content load, autosave, the surgical sidebar
  // refresh-after-save (title/H1 → row label), and the `contentReloadNonce`
  // re-sync (rename / snapshot restore) - so the chrome only orchestrates
  // the cross-pane flush.
  const flushAll = ws.flushAll;
  const markDetached = ws.markDetached;
  const unmarkDetached = ws.unmarkDetached;

  // One removal handler for both the backend event (a local soft/hard delete)
  // and the frontend `NOTE_REMOVED_EVENT` (a note that left the live tree via a
  // sync pull, myne-md/myne#839, cross-device). A detached window shows the
  // terminal "removed elsewhere" state after a forced-base flush preserves any
  // unsaved edit as a conflict copy; the main window closes every pane showing
  // the note, the same close a local removal drives (myne-md/myne#819).
  const handleNoteRemoved = useCallback(
    (id: string) => {
      if (detachedNoteId != null) {
        if (id !== detachedNoteId) return;
        // `forceBaseGuard`: the removal IS a cross-window write, so the flush
        // must declare its expected base even on a no-sync install, or a
        // hashless last-write-wins flush writes the stale pre-removal buffer
        // back over the just-set `trashed:`/`archived:`/`deleted:` field and
        // resurrects the note (myne-md/myne#839).
        void flushAll({ forceBaseGuard: true }).finally(() => setDeletedElsewhere(true));
      } else {
        // A dirty pane's unmount flush is hashless last-write-wins, so guard it
        // first (myne-md/myne#839): a cross-device trash must not be overwritten
        // by the stale buffer before the pane closes.
        void ws
          .flushNote(id, { forceBaseGuard: true })
          .finally(() => ws.closeNoteEverywhere(id));
      }
    },
    [detachedNoteId, flushAll, ws.flushNote, ws.closeNoteEverywhere],
  );

  // myne#681 task 2 (SYNC-11): a detached (pop-out) window reacts to its note
  // leaving the live tree from ANOTHER surface. Change and rename already reload
  // through the `sync://changed` listener below (a rename keeps the note id); a
  // delete (or a soft-trash / archive, which myne-md/myne#839 routes through the
  // same event) instead shows the terminal "removed elsewhere" state, after
  // flushing so an unsaved edit survives as a conflict copy rather than being
  // yanked away mid-sentence. Main-window instances never subscribe
  // (`detachedNoteId` is null there), so a sidebar removal of a non-popped-out
  // note follows its normal path. The event is the backend `NOTES_DELETED_EVENT`,
  // emitted from `note_update_from_host` for the soft paths and from
  // `note_delete_from_host` (via `DesktopHooks`) for the hard one.
  useEffect(() => {
    if (detachedNoteId == null) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<string>("notes://deleted", (e) => {
      handleNoteRemoved(e.payload);
    }).then((h) => {
      if (cancelled) h();
      else unlisten = h;
    });
    return () => {
      cancelled = true;
      if (unlisten !== undefined) unlisten();
    };
  }, [detachedNoteId, handleNoteRemoved]);

  // myne-md/myne#839 (cross-device): the sync pull never emits `notes://deleted`
  // (the orchestrator writes the pulled blob straight to disk and holds no host),
  // so a note that left the live tree on ANOTHER device is detected on the pane's
  // reload and reported through this window event. Subscribed in every window:
  // the main window closes the pane, the detached one terminalises.
  useEffect(() => {
    const onRemoved = (e: Event): void => {
      const detail = (e as CustomEvent<NoteRemovedDetail>).detail;
      if (detail?.noteId != null) handleNoteRemoved(detail.noteId);
    };
    window.addEventListener(NOTE_REMOVED_EVENT, onRemoved);
    return () => window.removeEventListener(NOTE_REMOVED_EVENT, onRemoved);
  }, [handleNoteRemoved]);

  // myne#681 (SYNC-6, cross-window): EVERY window keeps the workspace's
  // detached-note set in step, so the reveal-guard holds no matter which window
  // performed the detach. The host broadcasts `detached://opened` when a pop-out
  // is shown or revealed and `detached://closed` when one is destroyed (user
  // close, lock teardown, or a failed show); both carry the note id only. The
  // window that detached also marks/reveals locally (immediate); these listeners
  // are what keep the OTHER windows consistent, closing the cross-window clobber
  // where a detach done in one pop-out was invisible to the main window and it
  // then opened the same note as a second live tab.
  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    void (async () => {
      const handles = await Promise.all([
        listen<string>("detached://opened", (e) => markDetached(e.payload)),
        listen<string>("detached://closed", (e) => unmarkDetached(e.payload)),
      ]);
      if (cancelled) handles.forEach((h) => h());
      else unlisteners.push(...handles);
    })();
    return () => {
      cancelled = true;
      unlisteners.forEach((h) => h());
    };
  }, [markDetached, unmarkDetached]);

  // myne#681 (data): a detached (pop-out) window flushes its buffer when it loses
  // OS focus. Every non-idle vault lock (manual lock, vault switch, change-
  // password force-relock, vault delete) is triggered from the MAIN window, which
  // blurs the pop-out first, so this persists the pop-out's unsaved edits before
  // the lock teardown destroys it (`teardown_on_lock` uses `destroy()`, which by
  // design bypasses the close-intercept flush, SYNC-8). The idle path is already
  // covered by the `vault-lock-imminent` grace below. Now that a popped-out note
  // is its SOLE surface (SYNC-6 move), there is no main-window tab to catch the
  // edit, so this blur flush is what the earlier per-tab flush used to provide.
  // Best-effort + detached-only; a clean buffer flushes to a no-op.
  useEffect(() => {
    if (detachedNoteId == null) return;
    const onBlur = () => {
      void flushAll().catch(() => {});
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [detachedNoteId, flushAll]);

  // MYND-166 / MYND-308 - restore the persisted workspace CONTAINER ONCE on
  // mount (unlock). A missing / unreadable / malformed descriptor leaves the
  // default single empty pane (spec § 9.7.4). Runs after the slot guard, so the
  // backend read is Slot::Unlocked-gated. The descriptor is the MYW1 0x02
  // `{slots, activeId}` container (a legacy single descriptor is migrated to a
  // Default slot by `deserializeWorkspaces`); the active slot to restore comes
  // from the MYP1 `active_workspace` pref via `resolveActiveSlot` (the
  // consistency fallback to the first slot when the pointer is stale/missing).
  const restoreContainer = ws.restoreContainer;
  const restoredRef = useRef(false);
  // MYND-462 - set when the "Default file to open" preference is "empty" or
  // "specific", i.e. we deliberately did NOT restore the saved workspace this
  // session. The staging effect reads this to suppress its workspace-blob writes
  // until the user actively changes the layout, so opening with a non-default
  // startup and then quitting never clobbers the saved "Last opened" layout on
  // disk (toggling back to "Last opened" must restore it intact).
  const nonDefaultStartupRef = useRef(false);
  // Gates the staging effect: until the restore IO settles, staging would
  // push the DEFAULT empty layout, so an immediate post-unlock quit could
  // clobber the saved layout. Holding off means such a quit is a no-op that
  // preserves whatever is on disk.
  const [restoreSettled, setRestoreSettled] = useState(false);
  useEffect(() => {
    if (restoredRef.current) return; // StrictMode double-invoke guard
    restoredRef.current = true;
    void (async () => {
      try {
        // myne#678 render (epic #173): a detached (pop-out) window opens ONE
        // note in a fresh single-slot workspace and never restores the saved
        // layout, so a pop-out is that note's own focused surface. This reuses
        // the exact single-note seed the "specific" startup mode below uses.
        // SYNC-6 (one note, one surface) is what makes this the FIRST branch:
        // with both sidebars force-collapsed (see `leftCollapsed`/`rightCollapsed`)
        // the detached window cannot open another note, so the note it was
        // popped out for is the only one it ever holds.
        if (detachedNoteId) {
          nonDefaultStartupRef.current = true;
          const single = openInFocusedTab(emptyWorkspace(crypto.randomUUID()), {
            kind: "note",
            id: detachedNoteId,
          });
          restoreContainer(
            wrapAsSingleSlot(single, crypto.randomUUID(), defaultSlotName()),
          );
          return;
        }
        // MYND-462 - read the "Default file to open" preference first; it decides
        // whether we restore the saved workspace at all. `prefsRead` also carries
        // the MYP1 `active_workspace` pointer used by the "last" branch below.
        let startupMode = "last";
        let startupNote: string | null = null;
        let activePref: SlotId | null = null;
        try {
          const prefs = await prefsRead();
          startupMode = normalizeStartupOpen(prefs.startup_open);
          startupNote = prefs.startup_open_note;
          activePref = prefs.active_workspace;
        } catch {
          // Pref read failure → fall back to "last" (restore as before).
        }

        if (startupMode === "empty") {
          // Ignore the saved workspace; keep the component's default single empty
          // pane. The blob is NOT cleared - the staging guard below stops a quit
          // from overwriting it, so toggling back to "Last opened" restores it.
          nonDefaultStartupRef.current = true;
          return;
        }

        if (startupMode === "specific" && startupNote) {
          // Open just the chosen note in a fresh single-slot workspace (the same
          // shape the example-vault seed opens its index note through,
          // `openInFocusedTab`). A deleted / unreadable note simply
          // surfaces the pane's own missing-note state; we never auto-clear the
          // pref. The saved workspace blob is preserved (staging guard).
          nonDefaultStartupRef.current = true;
          const single = openInFocusedTab(emptyWorkspace(crypto.randomUUID()), {
            kind: "note",
            id: startupNote,
          });
          restoreContainer(
            wrapAsSingleSlot(single, crypto.randomUUID(), defaultSlotName()),
          );
          return;
        }

        // "last" (or "specific" with no note set) → restore the saved workspace.
        const descriptor = await workspaceRead();
        if (descriptor === null) return;
        const container = deserializeWorkspaces(descriptor);
        if (container === null) return; // malformed → keep the default container
        // Apply the persisted active-slot pointer (MYP1) against the loaded
        // slots; `resolveActiveSlot` self-heals a stale/missing pointer to the
        // first slot.
        const resolvedId = resolveActiveSlot(container.slots, activePref);
        restoreContainer(switchToSlot(container, resolvedId));

        // myne#678 task 6 (SYNC-10): the MAIN window re-spawns the detached
        // (pop-out) windows this container remembers, each clamped onto a
        // currently-connected display (`planDetachedRestore`) so an entry saved
        // on an unplugged monitor comes back on the primary rather than
        // off-screen. Desktop-only (`detachedWindows`) + best-effort. A detached
        // WINDOW never reaches here (its own branch returned at the top of this
        // effect), so pop-outs never recursively restore pop-outs.
        // Seed the last-known-good snapshot from the restored list, so a
        // snapshot-IPC failure before the first successful snapshot preserves
        // what was restored rather than erasing it.
        if (container.detached) lastDetachedRef.current = [...container.detached];
        if (container.detached && container.detached.length > 0 && has("detachedWindows")) {
          try {
            const { displays, primary } = await readDisplays();
            const plan = planDetachedRestore(container.detached, displays, primary);
            for (const spawn of plan) {
              try {
                await openDetachedWindow(spawn.noteId, spawn.geometry);
              } catch {
                // One bad entry (a note that no longer exists, a rejected
                // spawn) skips itself and the loop continues with its
                // siblings: a single deterministic failure must not veto
                // every later pop-out.
                continue;
              }
              // SYNC-6: a restored pop-out owns its note, so record it in the
              // detached set. Without this a relaunch's pop-outs are unknown to
              // the main window and opening one of their notes would spawn a
              // duplicate main-window tab (the concurrent-writer clobber again).
              markDetached(spawn.noteId);
            }
          } catch {
            // A failed monitor read or spawn leaves the pop-outs unrestored
            // rather than failing the main workspace restore.
          }
        }
      } catch {
        // Read failure → keep the default workspace (best-effort restore).
      } finally {
        setRestoreSettled(true);
      }
    })();
  }, [restoreContainer, detachedNoteId, markDetached]);

  // Latest serialized container descriptor, refreshed every render so the
  // graceful-exit hooks (which capture a stale closure) always persist the
  // CURRENT layout. Serialization is cheap (a small JSON tree). This is the
  // MYW1 0x02 `{slots, activeId}` payload (MYND-308); the active slot's
  // descriptor mirrors the live `ws.root` / `ws.focusedPaneId` (they ARE the
  // active slot's state via `activeSlotState`), so re-reading the snapshot on
  // each render keeps the staged blob current as the user edits.
  const descriptorRef = useRef("");
  const activeWorkspaceIdRef = useRef<SlotId>(ws.activeWorkspaceId);
  descriptorRef.current = serializeWorkspaces(ws.workspacesSnapshot());
  activeWorkspaceIdRef.current = ws.activeWorkspaceId;
  // MYND-308 - set by the staging effect on any container change; the coalesced
  // flush timer (and a graceful-exit save) clears it after a successful write.
  const workspaceDirtyRef = useRef(false);
  // Timestamp (ms) of the last actual blob flush - the coalescing reference.
  // `null` ≡ never flushed → flush as soon as dirty.
  const lastFlushAtMsRef = useRef<number | null>(null);
  // Persist the workspace container + the MYP1 active pointer (graceful-exit /
  // coalesced - never on every switch, so the blob mtime stays a low-resolution
  // signal). Writes the descriptor first, then the active-slot pointer.
  // The last successful detached-window snapshot, so a transient snapshot IPC
  // failure during a persist falls back to it instead of erasing the restore
  // list. Seeded from the restored MYW1 `detached` list at mount, so a failure
  // before the first successful snapshot still preserves what was restored.
  const lastDetachedRef = useRef<Awaited<ReturnType<typeof detachedWindowsSnapshot>>>([]);
  const persistWorkspace = useCallback(async () => {
    try {
      // myne#678 task 6 (SYNC-10): splice the current detached (pop-out) windows'
      // geometry into the descriptor at write time (a pop-out move is not a
      // main-window event, so the snapshot is taken here). Desktop-only + best
      // effort; on web the empty list removes the key.
      // A transient snapshot IPC failure returns null (distinct from "no
      // pop-outs" = []). Fall back to the last-known-good snapshot rather than
      // persisting an empty list (which `withDetached` treats as "delete the
      // key", erasing the restore list while pop-outs are open) or skipping the
      // whole write (which would also drop the descriptor + active-slot pointer).
      // The rest of the persist proceeds normally. (SYNC-10; device-local only.)
      const snap = has("detachedWindows")
        ? await detachedWindowsSnapshot().catch(() => null)
        : [];
      if (snap !== null) lastDetachedRef.current = snap;
      const detached = snap ?? lastDetachedRef.current;
      await workspaceWrite(withDetached(descriptorRef.current, detached));
      await setActiveWorkspace(activeWorkspaceIdRef.current);
      // Graceful-exit save counts as a flush - reset the coalescing window so
      // the timer doesn't redundantly re-write moments later.
      lastFlushAtMsRef.current = Date.now();
      workspaceDirtyRef.current = false;
    } catch {
      // Best-effort - a failed convenience write never blocks lock/close.
    }
  }, []);
  // MYND-271 Task 8 - persist the VaultIndices to the encrypted vault.indices
  // (MYI1) blob on graceful exit (same cadence as the workspace descriptor:
  // lock / idle-lock grace / quit, never per-edit). Best-effort + must run
  // while still unlocked (before vault_lock zeroizes the keys); the next
  // unlock rebuilds the missing delta if this is skipped.
  const persistVaultIndices = useCallback(async () => {
    try {
      await vaultIndicesPersist();
    } catch {
      // Best-effort - a failed index persist never blocks lock/close.
    }
  }, []);

  // The four writers `runFlushChain` runs, in one object rather than one per
  // call site. Four identical literals is four places for the fifth writer to
  // be added to three of them, and `runFlushChain` cannot see the omission: its
  // parameter is a complete object either way. What varies between the callers
  // is the REASON, which is the second argument and stays at the call site.
  const flushSteps = useMemo(
    () => ({
      flushAll,
      persistWorkspace,
      persistVaultIndices,
      flushGraphLayout: flushGraphLayoutNow,
    }),
    [flushAll, persistWorkspace, persistVaultIndices],
  );

  // MYND-166 / MYND-308 - mirror the current container into the backend's
  // in-RAM staging slot on every change (incl. the restored/default state on
  // mount). The backend flushes it to vault.workspace on `ExitRequested`, so an
  // app QUIT (Cmd+Q / app-menu Quit) persists the layout even though it never
  // fires the window's `onCloseRequested`. Staging is RAM-only - it never writes
  // the blob, so its mtime stays a low-resolution lock/quit signal. The whole
  // `{slots, activeId}` container is staged (so a slot save / switch survives a
  // quit), and the staged change marks the coalesced-flush path dirty.
  useEffect(() => {
    if (!restoreSettled) return; // don't stage the pre-restore default layout
    // MYND-462 - for a non-default startup ("empty" / "specific") the layout we
    // mounted is NOT the saved workspace, so skip the FIRST staging pass (which
    // would overwrite the saved blob on quit), then clear the guard so genuine
    // user layout edits this session still stage + persist as usual.
    if (nonDefaultStartupRef.current) {
      nonDefaultStartupRef.current = false;
      return;
    }
    workspaceDirtyRef.current = true;
    // myne#678 task 6: stage the detached (pop-out) snapshot alongside the pane
    // tree, so a Cmd+Q (which flushes the STAGED container) restores the pop-outs
    // too. Desktop-only + best-effort; the snapshot is async, hence the wrapper.
    void (async () => {
      const base = serializeWorkspaces(ws.workspacesSnapshot());
      // null = snapshot IPC failed (distinct from [] = no pop-outs). Fall back to
      // the last-known-good list rather than staging withDetached([]) (which
      // deletes the key) so a transient failure never erases the restore list.
      const snap = has("detachedWindows")
        ? await detachedWindowsSnapshot().catch(() => null)
        : [];
      if (snap !== null) lastDetachedRef.current = snap;
      const detached = snap ?? lastDetachedRef.current;
      await workspaceStage(withDetached(base, detached));
    })().catch(() => {
      // Best-effort; outside Tauri (browser dev shim) the invoke rejects.
    });
    // `slots` identity changes on save-as/switch/rename/delete; `root` /
    // `focusedPaneId` change on every layout edit of the active slot.
    // `expandedFolders` (MYND-455) is its OWN dep: the container ops spread
    // `{...c}`, which preserves `slots`/`activeId` identity, so a sidebar
    // folder toggle would otherwise never mark the blob dirty - and a Cmd+Q
    // would flush the stale staged container and lose the expand set.
    // `graphSettings` (graph-connection-ux-polish task 5) is the same shape of
    // dep for the same reason: a graph-panel toggle only changes that one
    // field on the spread container.
    // `taskDisplay` (chip colour / icon-only) and the container `taskView`
    // (the Tasks tab's persisted filters) are the same shape again: both are
    // set through a container spread, so a chip-colour toggle would otherwise
    // never re-fire staging and a quit flush would lose the setting
    // (myne-md/myne#656 review). Device-local state only; the lock path is
    // unaffected.
  }, [
    restoreSettled,
    ws.slots,
    ws.activeWorkspaceId,
    ws.root,
    ws.focusedPaneId,
    ws.expandedFolders,
    ws.graphSettings,
    ws.taskDisplay,
    ws.taskView,
  ]);

  // MYND-308 (SYNC-6, mtime-defense) - coalesced background flush. The
  // graceful-exit save (lock / close / quit / switch-vault) is the always-flush
  // path; this adds a periodic flush so a CRASH loses ≤ ~5 min of layout work.
  // A ~30 s interval polls the pure `shouldFlushWorkspace` decision against the
  // dirty flag + the last-flush timestamp (≤ once per `WORKSPACE_FLUSH_INTERVAL_MS`
  // = 5 min). NEVER a per-switch file write - switches only set `dirty`, the
  // timer decides when to actually touch the blob. `persistWorkspace` writes BOTH
  // the container (MYW1) and the active pointer (MYP1).
  useEffect(() => {
    if (!restoreSettled) return;
    const id = setInterval(() => {
      if (
        !shouldFlushWorkspace({
          lastFlushAtMs: lastFlushAtMsRef.current,
          nowMs: Date.now(),
          dirty: workspaceDirtyRef.current,
        })
      ) {
        return;
      }
      lastFlushAtMsRef.current = Date.now();
      workspaceDirtyRef.current = false;
      void persistWorkspace();
    }, COALESCED_FLUSH_POLL_MS);
    return () => clearInterval(id);
  }, [restoreSettled, persistWorkspace]);

  // T28 - Tauri close-intercept. Block window close until pending saves
  // flush (every pane), then persist the workspace descriptor. Safe to
  // no-op when running outside Tauri (browser dev fallback).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const w = getCurrentWebviewWindow();
        const fn = await w.onCloseRequested(async (event) => {
          if (cancelled) return;
          // Stop the default close; we terminate manually after the flush.
          event.preventDefault();
          // The chain, not a bare await sequence, and for the same reason the
          // lock CTA below uses it (task 93): one writer's rejection must not
          // take the rest of the chain with it, and here it must not take
          // `w.destroy()` either. `flushAll` rejects when a pane fails to settle
          // (myne-md/myne#520), and the default close is ALREADY cancelled at
          // this point, so a bare await would wedge the window unclosable
          // exactly when a save is failing. On Windows the title-bar X is the
          // only quit affordance, so that is the whole quit path.
          await runFlushChain(flushSteps, "closing");
          // `destroy()`, NOT `close()`: the capability ACL grants
          // `core:window:allow-destroy` but deliberately NOT `allow-close`
          // (TB6 surface - see lib/app-window.ts). `close()` rejects under the
          // permission system, so the window would never close. On Windows the
          // title-bar X is the only quit affordance (no macOS Cmd+Q →
          // RunEvent::ExitRequested path), so that left the app unclosable while
          // unlocked. `destroy()` is non-cancellable and won't re-fire this
          // handler; destroying the last window still raises ExitRequested, so
          // the Rust-side search-index persist on exit still runs.
          await w.destroy();
        });
        // `onCloseRequested` registers asynchronously: the component can
        // unmount (e.g. lock → Unlock screen) while this await is still in
        // flight. Without re-checking `cancelled` here the listener attaches
        // AFTER cleanup ran and is never removed - a leak that follows onto
        // later screens. Its mere presence makes Tauri `prevent_close()` the
        // native title-bar X (manager/window.rs `has_js_listener`), so on
        // Windows - where the X is the only quit affordance - the app can wedge
        // unclosable. Mirror the vault-lock-imminent effect below +
        // CreateVault's registration guard.
        if (cancelled) fn();
        else unlisten = fn;
      } catch {
        // Not running inside Tauri (e.g., `pnpm dev` browser shim) →
        // close-intercept is a no-op. Tests + vite dev mode hit this
        // path; no error surfaced.
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten !== undefined) unlisten();
    };
  }, [flushSteps]);

  // Web graceful exit (MYND-574 task 93). The Tauri close-intercept above is a
  // no-op in a browser - its own catch says so - which meant every tab close
  // silently dropped the newest edit, the workspace descriptor, the vault
  // indices and the graph layout. On the one client where an unsynced edit is
  // all that stands between the user and real loss.
  //
  // Additive rather than a rewrite of the effect above: that path has E2E
  // coverage this task must not disturb, and on desktop this seam is a no-op, so
  // the two cannot both fire.
  //
  // The `kind` split is load-bearing. `pagehide` is a real exit - flush
  // everything. `hidden` is a tab switch that MAY become a discard, so content
  // is flushed (integrity) and `vault.workspace` deliberately is not: writing it
  // per visibility flip would turn its mtime into an editor-activity log, which
  // is exactly what `protocol.md` §9.7.4's graceful-exit-only rule forecloses
  // and what task 65 kept the web client to.
  useEffect(() => {
    return onExitIntent(async (kind) => {
      setUnsavedGuard("flushing", true);
      try {
        // Same chain, same ordering, one call - `kind` carries the ONE
        // difference (a hidden tab must not write `vault.workspace`, whose mtime
        // is a lock/quit signal), so the divergence is a named parameter rather
        // than two sequences that happen to differ by a line.
        await runFlushChain(flushSteps, kind);
      } finally {
        setUnsavedGuard("flushing", false);
      }
    });
  }, [flushSteps]);

  // Task 88 - the second, much longer-lived holder of the same guard.
  //
  // A password change is reported as complete only once the server acknowledges
  // the new `vault.meta`. Until then this browser expects the new password and
  // every other device still expects the old one, and clearing this browser's
  // copy loses the change: on web there is no recovery phrase, so the only other
  // remedy is a native client with the old password - which the user has just
  // been told is no longer their password.
  //
  // So closing the tab while it is pending is the one exit worth interrupting.
  // The signal is `credentialPending`, which is recomputed from disk on every
  // poll rather than remembered, so it is still armed after a reload.
  //
  // No-op on desktop: the seam is a no-op there, and desktop's own path does not
  // need it.
  useEffect(() => {
    setUnsavedGuard("credential-push-pending", credentialPending);
    return () => setUnsavedGuard("credential-push-pending", false);
  }, [credentialPending]);

  // MYND-121 - flush every pane on idle-lock imminent. The backend idle
  // timer emits `vault-lock-imminent` before its grace window; flush any
  // unsaved edit so the autosave deltas persist before the keys zeroize.
  // Best-effort - the backend proceeds when the grace elapses regardless.
  // Mirrors the close-intercept's listen / unlisten + cancelled-guard
  // shape; no-op outside Tauri (browser dev shim).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const handle = await listen("vault-lock-imminent", () => {
          if (cancelled) return;
          void (async () => {
            // Content flush first (data integrity), workspace descriptor
            // second (convenience, droppable if the grace window expires). The
            // chain isolates each step, so a `flushAll` rejection from a pane
            // that did not settle (myne-md/myne#520) neither skips the two
            // persists behind it nor raises an unhandled rejection inside the
            // auto-lock grace window, where nothing would report it.
            await runFlushChain(flushSteps, "lock");
          })();
        });
        if (cancelled) {
          handle();
        } else {
          unlisten = handle;
        }
      } catch {
        // Not inside Tauri (browser dev shim) → no-op.
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten !== undefined) unlisten();
    };
  }, [flushSteps]);

  // Lock button flush-then-lock - `decisions.md` 2026-05-07 canonical
  // flush-on-lock, now across all panes; persist the workspace before lock.
  const handleLockFlushed = useCallback(async () => {
    // The chain is best-effort and CANNOT skip the lock (task 93). It used to be
    // a bare `await` sequence ending in `lockVault()`, so a rejection from any
    // writer skipped every step after it - including the lock. A transient write
    // failure did not merely lose a cache: it cancelled the auto-lock, leaving
    // the keys live in the Worker and the plaintext mounted, past the idle
    // deadline, with nothing said.
    await runFlushChain(flushSteps, "lock");
    await lockVault().catch(() => {
      /* lock is best-effort, parent callback still fires */
    });
    // Drop the agent run's frontend half on the SAME leg the host drops its own.
    // The host's `teardown_on_lock` clears the run table and the transcript; this
    // store holds the proposal, which is the anchors and replacements copied out
    // of notes. Unconditional and after the lock attempt, for the same reason the
    // flush chain cannot skip the lock: a failure earlier in the chain must not
    // be what leaves plaintext resident.
    //
    // The FOR-LOCK variant: it additionally drops the undo offer, because the
    // host cleared its own record on the same event and the note ids in it name
    // a vault that is no longer open. Closing the review screen uses the plain
    // one, since closing a screen un-applies nothing.
    clearAgentForLock();
    onLock?.();
  }, [flushSteps, onLock]);

  // Idle auto-lock where the platform has no OS-level idle detection - the web
  // client (phase3-web-client task 43). Desktop keeps `src-tauri/src/auto_lock.rs`
  // and this is inert there, so the two never race to lock the same vault.
  //
  // It reuses the Lock button's own handler rather than calling `lockVault`
  // directly: locking has to flush first, and a second lock path that skipped
  // the flush would lose the last edits of exactly the session the user walked
  // away from.
  useIdleAutoLock({
    // Through the SHARED envelope, not `?? 0` (myne-md/myne#479). This hook is
    // the timer that fires on the web client, where `?? 0` meant a `null`
    // `auto_lock_seconds` DISABLED the idle lock: `useIdleAutoLock` activates on
    // `timeoutSecs > 0`, and `protocol.md` §9.5.5 collapses an absent, tampered
    // or replayed `vault.prefs` to exactly that null. `threat-model.md` §7 puts
    // this timeout in the code-enforced class and says a replayed prefs blob
    // "can only make auto-lock stricter, never disable it or exceed the
    // ceiling", so the raw pref was the one input that could.
    //
    // The Rust-side clamp does not reach here: it feeds
    // `VaultRuntimeState::auto_lock_timeout_secs`, whose only reader is the
    // desktop Rust timer. Desktop is unaffected either way, since this hook is
    // inactive wherever `osIdleAutoLock` is present.
    timeoutSecs: effectiveAutoLockSecs(barPrefs.auto_lock_seconds ?? null),
    onIdle: () => void handleLockFlushed(),
  });

  // named-workspaces (MYND-308) - palette command handlers. The BottomBar
  // dropdown is the primary discoverable surface for switch + save-as; the
  // palette commands are the in-focus-mode escape (the bar fades). Save-as and
  // rename ask for a name via the in-WebView text prompt (`window.prompt` is a
  // no-op in the Tauri WebView); switch cycles to the next slot when invoked
  // text-free from the palette; delete removes the active slot.
  const saveWorkspaceAs = ws.saveWorkspaceAs;
  const switchWorkspace = ws.switchWorkspace;
  const renameWorkspace = ws.renameWorkspace;
  const deleteWorkspace = ws.deleteWorkspace;
  const handleSaveWorkspaceAs = useCallback(() => {
    void (async () => {
      const name = await promptForText({
        title: t("editor.chrome.workspacePrompt.saveAsTitle"),
        confirmLabel: t("editor.chrome.workspacePrompt.saveConfirm"),
        placeholder: t("editor.chrome.workspacePrompt.namePlaceholder"),
        testIdPrefix: "workspace-prompt",
      });
      if (name !== null) saveWorkspaceAs(name);
    })();
  }, [saveWorkspaceAs, t]);
  const handleRenameWorkspace = useCallback(() => {
    const snapshot = ws.workspacesSnapshot();
    const active = snapshot.slots.find((s) => s.id === snapshot.activeId);
    if (active === undefined) return;
    void (async () => {
      const name = await promptForText({
        title: t("editor.chrome.workspacePrompt.renameTitle"),
        initialValue: active.name,
        confirmLabel: t("editor.chrome.workspacePrompt.renameConfirm"),
        testIdPrefix: "workspace-prompt",
      });
      if (name !== null) renameWorkspace(active.id, name);
    })();
  }, [ws, renameWorkspace, t]);
  // Rename a SPECIFIC slot (the per-row pencil in the bottom-bar switcher) - vs
  // handleRenameWorkspace which renames the active slot (the palette command).
  const handleRenameWorkspaceById = useCallback(
    (id: SlotId) => {
      const slot = ws.workspacesSnapshot().slots.find((s) => s.id === id);
      if (slot === undefined) return;
      void (async () => {
        const name = await promptForText({
          title: t("editor.chrome.workspacePrompt.renameTitle"),
          initialValue: slot.name,
          confirmLabel: t("editor.chrome.workspacePrompt.renameConfirm"),
          testIdPrefix: "workspace-prompt",
        });
        if (name !== null) renameWorkspace(id, name);
      })();
    },
    [ws, renameWorkspace, t],
  );
  const handleSwitchWorkspaceCycle = useCallback(() => {
    // Palette switch (no inline picker): cycle to the next slot in order.
    const snapshot = ws.workspacesSnapshot();
    const ids = snapshot.slots.map((s) => s.id);
    if (ids.length < 2) return;
    const i = ids.indexOf(snapshot.activeId);
    switchWorkspace(ids[(i + 1) % ids.length]!);
  }, [ws, switchWorkspace]);
  const handleDeleteWorkspace = useCallback(() => {
    const snapshot = ws.workspacesSnapshot();
    deleteWorkspace(snapshot.activeId);
  }, [ws, deleteWorkspace]);


  // myne#681 task 2 (SYNC-11): terminal "deleted elsewhere" state for a detached
  // window whose note was deleted from another surface. Every hook above has run,
  // so this conditional return does not reorder hooks. The dirty buffer was
  // already flushed (keep-both) by the notes://deleted listener; closing the
  // window closes the note entirely (task 4). Only tokens + primitives here, so
  // `check-token-adoption` sees no new hardcoded value.
  if (deletedElsewhere) {
    return (
      <CenteredCard>
        {/* role="alert" so a screen reader announces the terminal state, and a
            real heading + body via the shared card styles so this takeover matches
            every other CenteredCard takeover (e.g. DeviceRevoked), rather than
            two default-weight divs. display:contents keeps CenteredCard's own
            layout of its children. */}
        <div
          role="alert"
          aria-live="assertive"
          data-testid="detached.deleted-elsewhere"
          style={{ display: "contents" }}
        >
          <h1 style={CARD_TITLE_STYLE}>{t("editor.detachedDeleted.title")}</h1>
          <p style={CARD_BODY_STYLE}>{t("editor.detachedDeleted.body")}</p>
        </div>
        <Button
          data-testid="detached.deleted-elsewhere.close"
          onClick={() => {
            // `destroy()` (non-cancellable) rather than `close()`: it is on both
            // the desktop and web window seams, and this path is desktop-only
            // anyway (detachedNoteId is null on web). Closing the pop-out closes
            // the note entirely (task 4): its registry entry is dropped by the
            // Rust Destroyed handler.
            void getCurrentWindow().destroy();
          }}
        >
          {t("editor.detachedDeleted.close")}
        </Button>
      </CenteredCard>
    );
  }

  return (
    <div
      data-focus-active={focusActive ? "true" : undefined}
      // focus-mode (MYND-348): dim / typewriter gates = focus active && the pref
      // (default on → `!== false`). Pure-CSS dim (tokens.css) + the typewriter
      // ViewPlugin (focus-mode.ts) read these off the DOM, so no state threading.
      data-focus-dim={
        focusActive && barPrefs.editor_focus_dim_inactive !== false ? "true" : undefined
      }
      data-focus-typewriter={
        focusActive && barPrefs.editor_focus_typewriter !== false ? "true" : undefined
      }
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--bg-1)",
        flex: 1,
        minHeight: 0,
      }}
    >
      {/* Transient "saving…" overlay during a multi-vault switch (MYND-205).
          Shows while `switchVault`'s param-less `vault_lock()` flushes the
          prior vault + tears it down, before the Stage routes to the target's
          unlock screen. The styled account-chip dropdown (task 5) owns the
          full switch UI; this overlay just makes the lock+flush window
          visible until then. No confirm-discard dialog - the flush is
          automatic. */}
      {switching && <SwitchingOverlay />}
      {/* Sync banners (MYND-426 reconcile / MYND-427 integrity), above the
          three-pane row. Non-blocking + dismissable; renders nothing while sync
          is off (the common case). */}
      <SyncBanners />
      {/* Desktop self-update. A calm, dismissable strip beside the sync
          banners; renders nothing while no update is offered or the client
          cannot self-update (web). */}
      <UpdateBanner />
      {/* MYND-336: keep the editor toolbar plugin's layout in sync with the
          user's vault.prefs customization (no render). */}
      <ToolbarLayoutSync />
      {/* No separate top bar (MYND-166): the editor content fills from the top
          and each top pane's tab strip rises into the OS title-bar row,
          Obsidian-style. The sidebar toggles float in the top corners below
          (clear of the traffic lights); whatever top surface sits beneath each
          reserves clearance for it (the left sidebar header when open, or the
          corner pane's strip inset when not). */}
      <div
        ref={rowRef}
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "row",
          flex: 1,
          minHeight: 0,
        }}
      >
        {/* Left ribbon (myne-md/myne#699): a far-left icon column independent of
            the notes sidebar, so collapsing the tree does not hide it. Hidden in
            focus mode and under the width-forced collapse. */}
        <LeftRibbon
          hidden={focusActive || detached || forced.forceLeftCollapsed}
          // Derived from the FOCUSED TAB, never from rail-local state
          // (myne-md/myne#773). The rail had no active state at all before
          // this, which is why pressing Attachments and pressing Graph left it
          // looking identical — on the one column that is always visible.
          currentCommandId={
            ws.focusedLeaf.activeTab === null
              ? undefined
              : openCommandForKind(ws.focusedLeaf.activeTab.kind)
          }
        />
        <SidebarBootstrap />
        {/* Always mounted (even when collapsed) so the width collapse/expand
            animates instead of popping - SidebarPane drives the width 0↔open
            transition and marks the pane `inert` while collapsed. */}
        <SidebarPane
          side="left"
          width={layout.leftWidth}
          collapsed={leftCollapsed}
          min={LEFT_BOUNDS.min}
          max={LEFT_BOUNDS.max}
          containerRef={rowRef}
          onResize={layout.setLeftWidth}
          onToggleCollapse={layout.toggleLeftCollapsed}
          resizeLabel={t("editor.chrome.resizeNotesSidebar")}
        >
            <div style={SIDEBAR_COLUMN_STYLE}>
              {/* Traffic-light + left-toggle clearance row. The floated toggle
                  and macOS traffic lights sit over this; the vault switcher
                  and Notes list start below it. Draggable (title-bar row). */}
              <div
                {...dragRegionProps()}
                style={{
                  height: STRIP_HEIGHT,
                  flexShrink: 0,
                  // Ground painted by SidebarPane - see its comment.
                  borderInlineEnd: "1px solid var(--line-1)",
                  // Bottom rule at the traffic-light strip's edge, so the title
                  // band joins the ribbon's rule and the tab strip's own bottom
                  // border. Only while the ribbon is shown: with the ribbon off
                  // there is no left column to continue, and the line would be a
                  // stray segment at the window edge (myne-md/myne#699).
                  borderBottom: ribbonShown ? "1px solid var(--line-1)" : undefined,
                }}
              />
              <SidebarVaultSwitcher
                onSwitchVault={onSwitchVault}
                onCreateAnother={onCreateAnother}
                onJoinDevice={onJoinDevice}
                switching={switching}
              />
              <NotesSidebarList
                exportHooks={exportHooks}
              />
            </div>
        </SidebarPane>
        {/* Region root for the centre column (myne#728). It wraps the ternary
            rather than either branch, because the editor region is "whatever
            the centre shows": swapping to the attachments view must not make
            the region disappear from the F6 cycle. Same flex contract as both
            branches already carry, so the geometry is unchanged. */}
        <div
          {...{ [REGION_ATTR]: "editor" }}
          // The route's ONE `main` (myne#728, task 9). It was `role="region"`
          // when task 2 introduced the region model, with a note that the
          // specific landmarks would replace it; this is that replacement.
          // `AttachmentsLibrary` was demoted from `<main>` to `<section>` in
          // the same change, because it renders inside this element and a
          // nested second `main` makes "jump to main" ambiguous.
          role="main"
          aria-label={t("editor.chrome.region.editor")}
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
        <PaneTree
          node={ws.root}
          focusedPaneId={ws.focusedPaneId}
          onReadout={onReadout}
          leftInset={leftCollapsed ? leftClearance : 0}
          // The clearance is reserved for the two controls that FLOAT in the
          // top-right corner, so it is only owed when they are there. On a
          // non-note tab (the graph, the task list, a saved view) neither is
          // rendered, there is no note for either to act on, and reserving
          // their room anyway left the tab strip's caret sitting a control's
          // width off the right edge with empty space beside it
          // (myne-md/myne#727). The strip's padding already transitions on the
          // sidebar's own curve, so the caret slides rather than jumping when
          // the focused tab changes kind.
          rightInset={rightCollapsed && topRightFloatsShown ? RIGHT_CLEARANCE : 0}
        />
        </div>
        {/* A non-note tab has no note for the backlinks/outline sidebar to
            describe, so it is not shown - and the sidebar can never be left
            open with its toggle gone (myne-md/myne#656 review). The attachment
            library used to need a second clause here; as a tab its kind is
            simply not "note" (myne-md/myne#773). */}
        {ws.focusedLeaf.activeTab?.kind === "note" && (
          <SidebarPane
            side="right"
            width={layout.rightWidth}
            collapsed={rightCollapsed}
            min={RIGHT_BOUNDS.min}
            max={RIGHT_BOUNDS.max}
            containerRef={rowRef}
            onResize={layout.setRightWidth}
            onToggleCollapse={layout.toggleRightCollapsed}
            resizeLabel={t("editor.chrome.resizeBacklinksSidebar")}
          >
            <RightSidebar
              onOpenSettings={(panel, anchor) =>
                openSettings(
                  (panel as PanelId | undefined) ?? null,
                  anchor ?? null,
                )
              }
              onShowToast={(message) => showToastMessage(message)}
            />
          </SidebarPane>
        )}
      </div>
      {/* Sidebar toggles, floated into the editor's top corners (the title-bar
          row), level with the macOS traffic lights. Faded in focus mode. */}
      <div
        data-editor-chrome
        style={{
          position: "absolute",
          top: TITLE_BAR_CONTROL_TOP,
          left: leftToggleX,
          zIndex: 30,
          display: "flex",
          alignItems: "center",
          gap: TITLE_BAR_CLUSTER_GAP,
        }}
      >
        <TitleBarToggle
          side="left"
          collapsed={leftCollapsed}
          onToggle={layout.toggleLeftCollapsed}
          disabled={forced.forceLeftCollapsed}
        />
        <TitleBarNavButton
          direction="back"
          onClick={ws.goBack}
          disabled={!ws.canGoBack}
        />
        <TitleBarNavButton
          direction="forward"
          onClick={ws.goForward}
          disabled={!ws.canGoForward}
        />
      </div>
      {/* The right panel (backlinks / outline / …) is about the OPEN note, so its
          toggle only shows while a note is actually open. One constant, shared
          with the tab strip's clearance and the "…" menu, see
          `topRightFloatsShown`. */}
      {topRightFloatsShown && (
        <div
          style={{
            position: "absolute",
            top: TITLE_BAR_CONTROL_TOP,
            right: RIGHT_TOGGLE_X,
            zIndex: 30,
          }}
        >
          <TitleBarToggle
            side="right"
            collapsed={rightCollapsed}
            onToggle={layout.toggleRightCollapsed}
            disabled={forced.forceRightCollapsed}
          />
        </div>
      )}
      <BottomBar
        onOpenSettings={() => openSettings()}
        onShowTags={() => {
          setTagsSeed(null);
          setTagsOpen(true);
        }}
        onShowViews={revealViews}
        onLockFlushed={handleLockFlushed}
        saveStatus={readout.status}
        onRetry={readout.retry}
        hideSaveStatus={ws.focusedLeaf.activeTab === null}
        saveStatusUnsynced={focusedNoteUnsynced}
        stats={readout.stats}
        selectionStats={readout.selectionStats}
        viewMode={focusedTabViewMode}
        onCycleViewMode={
          focusedTabViewMode === null
            ? undefined
            : () => ws.setFocusedTabViewMode(NEXT_VIEW_MODE[focusedTabViewMode])
        }
        showPreview={focusedTabViewMode === "source"}
        previewActive={ws.isCompanionOpen(ws.focusedPaneId)}
        onTogglePreview={() => ws.toggleCompanion(ws.focusedPaneId)}
        workspaceSlots={ws.slots}
        activeWorkspaceId={ws.activeWorkspaceId}
        onSwitchWorkspace={ws.switchWorkspace}
        onSaveWorkspaceAs={handleSaveWorkspaceAs}
        onRenameWorkspace={handleRenameWorkspaceById}
        hiddenItems={hiddenBarItems}
        barItemsOrder={barPrefs.bar_items_order}
        onReorder={(o) => void setBarItemsOrder(o)}
        onItemContextMenu={(e, itemId, visibleIds) =>
          setBarMenu({ x: e.clientX, y: e.clientY, itemId, visibleIds })
        }
        onContextMenu={(e) => {
          e.preventDefault();
          setBarMenu({ x: e.clientX, y: e.clientY });
        }}
      />
      {barMenu &&
        (barMenu.itemId !== undefined ? (
          // Per-item menu (right-clicked a specific bar item): move left / move
          // right (a11y fallback for drag) + hide. A boundary move is OMITTED
          // (the flat ContextMenu has no disabled state).
          <ContextMenu
            x={barMenu.x}
            y={barMenu.y}
            onClose={() => setBarMenu(null)}
            items={((): ContextMenuItem[] => {
              const itemId = barMenu.itemId!;
              const visibleIds = barMenu.visibleIds ?? [];
              const resolved = resolveBarOrder(
                barPrefs.bar_items_order,
                RIGHT_CLUSTER_DEFAULT_ORDER,
              );
              const items: ContextMenuItem[] = [];
              if (canMoveBarItem(visibleIds, itemId, -1)) {
                items.push({
                  id: "move-left",
                  label: t("editor.chrome.barItems.moveLeft"),
                  group: "reorder",
                  onSelect: () =>
                    void setBarItemsOrder(
                      moveBarItem(resolved, visibleIds, itemId, -1),
                    ),
                });
              }
              if (canMoveBarItem(visibleIds, itemId, 1)) {
                items.push({
                  id: "move-right",
                  label: t("editor.chrome.barItems.moveRight"),
                  group: "reorder",
                  onSelect: () =>
                    void setBarItemsOrder(
                      moveBarItem(resolved, visibleIds, itemId, 1),
                    ),
                });
              }
              items.push({
                id: "hide",
                label: t("editor.chrome.barItems.hide"),
                group: "hide",
                onSelect: () =>
                  void setHiddenBarItems(
                    hiddenBarItems.includes(itemId)
                      ? hiddenBarItems
                      : [...hiddenBarItems, itemId],
                  ),
              });
              return items;
            })()}
          />
        ) : (
          // Bar-wide menu (right-clicked empty bar space): the visibility
          // checklist - the only path to restore a hidden item.
          <ContextMenu
            x={barMenu.x}
            y={barMenu.y}
            onClose={() => setBarMenu(null)}
            items={BAR_ITEMS.map(
              (it): ContextMenuItem => ({
                id: it.id,
                label: t(it.labelKey),
                checked: !hiddenBarItems.includes(it.id),
                closeOnSelect: false,
                onSelect: () =>
                  void setHiddenBarItems(
                    hiddenBarItems.includes(it.id)
                      ? hiddenBarItems.filter((x) => x !== it.id)
                      : [...hiddenBarItems, it.id],
                  ),
              }),
            )}
          />
        ))}
      <SettingsModal
        vaultId={vaultId}
        open={settingsOpen}
        initialPanel={settingsPanel ?? undefined}
        initialAnchor={settingsAnchor ?? undefined}
        onClose={() => setSettingsOpen(false)}
        onShowToast={showToastMessage}
        onForceRelock={onForceRelock}
        onDeleteVaultSuccess={onDeleteVaultSuccess}
        onImportObsidian={() => {
          // Keep Settings open BEHIND the importer (both are z-1000 modals and
          // the importer renders later in the DOM, so it layers on top). Closing
          // the importer returns to Settings rather than dumping to the editor
          // (#206 - "actions like import notes close off the settings pane").
          setImporterOpen(true);
        }}
        onOpenGraph={() => {
          setSettingsOpen(false);
          ws.openGraph();
        }}
        onBackupVault={() => {
          setSettingsOpen(false);
          setBackupExportOpen(true);
        }}
        onRestoreBackup={() => {
          setSettingsOpen(false);
          onRestoreBackup();
        }}
        onExportVault={() => {
          setSettingsOpen(false);
          setVaultExportOpen(true);
        }}
      />
      <BackupExportModal
        open={backupExportOpen}
        onClose={() => setBackupExportOpen(false)}
        onOpenDrill={() => {
          setBackupExportOpen(false);
          openSettings("privacy", "privacy.recovery-drill");
        }}
        vaultId={vaultId}
      />
      <VaultExportModal
        open={vaultExportOpen}
        onClose={() => setVaultExportOpen(false)}
        folders={vaultExportFolders}
      />
      {/* Meeting AI: the opt-in pass, self-driving from the offer store, so it
          needs no state from Editor and renders nothing until an offer exists. */}
      <MeetingAiDialog
        onOpenAiSettings={() => openSettings("ai")}
        settle={{
          reloadOpenNote: () => ctx.reloadOpenNote(),
          refreshOne: (id) => ctx.refreshOne(id),
        }}
      />
      {/* MYND-567: the `myne://theme/install` confirmation gate. Self-driving -
          it drains the deep-link latch on mount and listens for warm arrivals,
          so it needs no state from Editor. Mounted HERE (and only here) because
          Editor is the post-unlock stage: that is what holds a link arriving on
          a locked vault until the vault is open.

          `deferred` yields to the first-run importer offer. Both are focus-
          trapping modals at the same z-index, so showing them together would
          have the two traps fight over focus; the offer is the onboarding gate
          and wins. Deferring only delays - the request stays latched and the
          dialog opens as soon as the offer is dismissed. */}
      <ThemeInstallDialog deferred={offerOpen} />
      {/* TemplatesManager is NOT mounted here. On this branch it is a TAB TYPE
          rendered by `PaneView` (`isTemplates`), so the modal carve-out moved
          with it; mounting it here too would render two managers over one
          "Manage templates…" action. Develop's editor-mounted copy is dropped,
          and its #824 fix (refresh a just-created template into the cache
          BEFORE opening it) is ported into PaneView's mount instead. */}
      <SnapshotsPanel
        open={snapshotsOpen}
        onClose={() => setSnapshotsOpen(false)}
        noteId={ctx.selectedId}
        noteTitle={
          ctx.selectedId === null
            ? null
            : ctx.cache.get(ctx.selectedId)?.title ?? null
        }
        onRestored={() => ctx.reloadOpenNote()}
      />
      <SnapshotFailedIndicator />
      <AiHydrationProbe />
      {/* First-run AI onboarding (myne-md/myne#805): offered once per device,
          after the first successful unlock. Gated on `localAi` as a whole: a
          host with no AI at all (web, per `decisions/ai/0628`) renders nothing,
          rather than an opt-in and a Chat card whose provider setup that host
          cannot open. Desktop offers the download cards; mobile mounts its own
          copy with `downloads={false}` (opt-in + Chat only). */}
      {has("localAi") ? (
        <AiOnboardingSurface
          open={aiOnboardingOpen}
          onClose={closeAiOnboarding}
          downloads={true}
          onOpenProviderSetup={() => {
            closeAiOnboarding();
            setSettingsPanel("ai");
            setSettingsOpen(true);
          }}
        />
      ) : null}
      <NewNoteFromTemplateModal
        open={newFromTemplateOpen}
        onClose={() => setNewFromTemplateOpen(false)}
        onManageTemplates={() => {
          setNewFromTemplateOpen(false);
          ws.openTemplates();
        }}
        onBlankNote={() => {
          // Zero-templates degrade → the existing instant-blank path, unchanged.
          void ctx.createAndStartRename().catch(() => {});
        }}
        onCreateFromTemplate={(templateId, name) => {
          // Location-agnostic: lands at the root, where the header new-note
          // button's blank note would land (folder = null).
          // `singleDay(now)`: a note made by hand belongs to the day it was
          // made on, so both period tokens render as today. Said explicitly
          // because the parameter is required now, which is what stops a
          // future weekly path from silently inheriting this meaning.
          void createNoteFromTemplate(templateId, name, null, new Date(), singleDay(new Date()))
            .then((id) => ctx.open(id as NoteId))
            .catch(() => {
              /* creation failure surfaces via sidebar UX */
            });
        }}
      />
      <Suspense fallback={null}>
        <TagBrowser
          open={tagsOpen}
          onClose={() => setTagsOpen(false)}
          seedTagKey={tagsSeed}
        />
      </Suspense>
      <ObsidianImportModal
        open={importerOpen}
        onClose={() => setImporterOpen(false)}
        onImported={handleImported}
      />
      <ImporterOnboardingOffer
        open={offerOpen}
        onChoose={() => {
          dismissImporterOffer();
          setImporterOpen(true);
        }}
        onDismiss={dismissImporterOffer}
      />
      <CommandPaletteHost
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onReopen={() => setPaletteOpen(true)}
        setToast={setToast}
        onImportObsidian={() => {
          setPaletteOpen(false);
          setImporterOpen(true);
        }}
        onImportBaseView={() => {
          setPaletteOpen(false);
          void importBaseView();
        }}
        onBackupVault={() => {
          setPaletteOpen(false);
          setBackupExportOpen(true);
        }}
        onRestoreBackup={() => {
          setPaletteOpen(false);
          onRestoreBackup();
        }}
        onExportVaultMarkdown={() => {
          setPaletteOpen(false);
          setVaultExportOpen(true);
        }}
        onOpenAttachments={() => {
          setPaletteOpen(false);
          ws.openAttachments();
        }}
        onOpenSettings={() => {
          setPaletteOpen(false);
          openSettings();
        }}
        onManageTemplates={() => {
          setPaletteOpen(false);
          ws.openTemplates();
        }}
        onNewNoteFromTemplate={() => {
          setPaletteOpen(false);
          setNewFromTemplateOpen(true);
        }}
        onOpenSnapshots={() => {
          setPaletteOpen(false);
          setSnapshotsOpen(true);
        }}
        onExportNoteMarkdown={() => {
          // Same shared flow as the sidebar context-menu item (MYND-116) -
          // zero divergence. The action is hidden when no note is selected
          // (registry visibility), so the null check is defensive only.
          setPaletteOpen(false);
          const id = ctx.selectedId;
          if (id === null) return;
          void runNoteExportFlow(
            noteExportOptions(id, ctx.cache.get(id)?.title ?? null, exportHooks),
          );
        }}
        onExportNotePdf={() => {
          // PDF sibling (MYND-255) - same shared-flow discipline as the
          // markdown action above.
          setPaletteOpen(false);
          const id = ctx.selectedId;
          if (id === null) return;
          void runNotePdfExportFlow(
            noteExportOptions(id, ctx.cache.get(id)?.title ?? null, exportHooks),
          );
        }}
        onExportNoteHtml={() => {
          // HTML sibling (MYND-340) - same shared-flow discipline.
          setPaletteOpen(false);
          const id = ctx.selectedId;
          if (id === null) return;
          void runNoteHtmlExportFlow(
            noteExportOptions(id, ctx.cache.get(id)?.title ?? null, exportHooks),
          );
        }}
        onExportNoteTxt={() => {
          // Plain-text sibling (MYND-340) - same shared-flow discipline.
          setPaletteOpen(false);
          const id = ctx.selectedId;
          if (id === null) return;
          void runNoteTxtExportFlow(
            noteExportOptions(id, ctx.cache.get(id)?.title ?? null, exportHooks),
          );
        }}
        topRightFloatsShown={topRightFloatsShown}
        onShowGraph={() => {
          setPaletteOpen(false);
          ws.openGraph();
        }}
        onShowIsolatedGraph={() => {
          // The pane's filter is LOCAL state, so the request has to travel out
          // of band: `openGraph` opens the tab and this hands it the view it
          // should open ON (task 14). Order does not matter, the request
          // waits for the pane if the pane is not up yet.
          setPaletteOpen(false);
          ws.openGraph();
          requestGraphViewFilter({ kind: "orphans" });
        }}
        onShowTasks={() => {
          setPaletteOpen(false);
          ws.openTasks();
        }}
        onShowTags={() => {
          setPaletteOpen(false);
          setTagsSeed(null);
          setTagsOpen(true);
        }}
        onShowViews={() => {
          setPaletteOpen(false);
          revealViews();
        }}
        onLockFlushed={async () => {
          setPaletteOpen(false);
          await handleLockFlushed();
        }}
        onToggleLeftSidebar={() => {
          setPaletteOpen(false);
          // MYND-192 - a width-forced collapse can't be toggled away (and
          // must not persist a manual flip the narrow window imposed).
          if (!forced.forceLeftCollapsed) layout.toggleLeftCollapsed();
        }}
        onToggleRightSidebar={() => {
          setPaletteOpen(false);
          if (!forced.forceRightCollapsed) layout.toggleRightCollapsed();
        }}
        onToggleStackedTabs={() => {
          setPaletteOpen(false);
          ws.toggleStackedFocused();
        }}
        onToggleReading={() => {
          setPaletteOpen(false);
          const tab = ws.focusedLeaf.activeTab;
          if (tab !== null && tab.kind === "note") {
            ws.setFocusedTabViewMode(tab.viewMode === "reading" ? "live" : "reading");
          }
        }}
        onToggleSource={() => {
          setPaletteOpen(false);
          const tab = ws.focusedLeaf.activeTab;
          if (tab !== null && tab.kind === "note") {
            ws.setFocusedTabViewMode(tab.viewMode === "source" ? "live" : "source");
          }
        }}
        onToggleFocus={() => {
          setPaletteOpen(false);
          toggleFocus();
        }}
        onSaveWorkspaceAs={() => {
          setPaletteOpen(false);
          handleSaveWorkspaceAs();
        }}
        onSwitchWorkspace={() => {
          setPaletteOpen(false);
          handleSwitchWorkspaceCycle();
        }}
        onRenameWorkspace={() => {
          setPaletteOpen(false);
          handleRenameWorkspace();
        }}
        onDeleteWorkspace={() => {
          setPaletteOpen(false);
          handleDeleteWorkspace();
        }}
      />
      {/* Browser-extension clip dispatch listener (desktop-ingest, MYND-442,
          TB10). Mounted here - inside the workspace providers - so the success
          notice's "view" affordance opens the newly-clipped note via the
          workspace note-open. */}
      <ClipDispatchListener
        onViewNote={(id) => {
          void ctx.open(id as NoteId).catch(() => {
            /* note-open failure surfaces via sidebar UX */
          });
        }}
        onNoteCreated={() => {
          // A clip sealed a new note - reload the sidebar so it appears live
          // (same note_list → refreshAll path the boot + "+ New Note" use).
          void noteList()
            .then((ids) => ctx.refreshAll(ids))
            .catch(() => {
              /* sidebar stays as-is until the next refresh - non-fatal */
            });
        }}
      />
      <WorkspaceHotkeys
        focusActive={focusActive}
        activeModal={settingsOpen ? "settings" : paletteOpen ? "palette" : null}
        onToggleFocus={toggleFocus}
        onExitFocus={exitFocus}
        onTogglePalette={() => setPaletteOpen((v) => !v)}
        onToggleSettings={() => setSettingsOpen((s) => !s)}
      />
      <NoteExportModal
        open={exportPreflight !== null}
        attachmentCount={exportPreflight?.count ?? 0}
        onCancel={() => {
          exportPreflight?.resolve(null);
          setExportPreflight(null);
        }}
        onConfirm={(includeAttachments) => {
          exportPreflight?.resolve({ includeAttachments });
          setExportPreflight(null);
        }}
        onCopy={() => {
          // MYND-643: resolve the pre-flight as CANCELLED so the export flow
          // stops cleanly (it must not also write a file), then copy the note
          // the modal is ABOUT. It is captured from the pre-flight - NOT
          // `ctx.selectedId`, which is null/wrong when the flow was raised from
          // the sidebar context-menu on a note that is not open (the ne4 defect).
          // Resolving with a choice would run the save-dialog path we replace.
          const targetId = exportPreflight?.noteId ?? null;
          exportPreflight?.resolve(null);
          setExportPreflight(null);
          if (targetId !== null) void copyNoteMarkdownById(targetId);
        }}
      />
      <NotePdfExportNotice
        open={pdfPreflight !== null}
        excludedAttachments={pdfPreflight?.excluded ?? []}
        onCancel={() => {
          pdfPreflight?.resolve(false);
          setPdfPreflight(null);
        }}
        onConfirm={() => {
          pdfPreflight?.resolve(true);
          setPdfPreflight(null);
        }}
      />
      <ExportEgressNotice
        open={egressPreflight !== null}
        sentence={egressPreflight?.sentence ?? ""}
        onCancel={() => {
          egressPreflight?.resolve(false);
          setEgressPreflight(null);
        }}
        onConfirm={() => {
          egressPreflight?.resolve(true);
          setEgressPreflight(null);
        }}
      />
      <Toast
        message={toast?.message ?? null}
        action={toast?.action}
        variant={toast?.variant}
        // Action-bearing toasts (export success "Show in folder") get the
        // soft-trash Undo precedent's 6 s window (NoteList.tsx) - 2.5 s is
        // not enough to read the message AND click the inline action.
        durationMs={toast?.action !== undefined ? 6000 : 2500}
        onDone={() => setToast(null)}
      />
      {/* The `<Toaster />` used to mount HERE, and that placement was the defect
          myne-md/myne#390 found underneath its own findings. This screen renders
          only after unlock, so vault creation, unlock and the fail-closed
          takeovers were all outside it, a `toast(...)` from any of them drew
          nothing at all, silently, which is why those surfaces had grown label
          swaps and silences instead. It now mounts once in `App.tsx`, above the
          stage switch, so every stage can reach it. */}
      {/* ASM-6→B / #422: the calm "updated from another device" hint. Headless -
          it pushes an info toast into the <Toaster> above when the sync cycle
          reports an NC05 note was reconciled by an automatic CRDT merge (#419). */}
      <RemoteMergeHint />
    </div>
  );
}

/** Column wrapper inside a `SidebarPane`: header band stacked above the
 *  sidebar body, filling the pane width. */
const SIDEBAR_COLUMN_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minWidth: 0,
  minHeight: 0,
};

/** Fixed width of a `TitleBarToggle` button. */
const TITLE_BAR_TOGGLE_WIDTH = 30;
/** Fixed width of a back / forward `TitleBarNavButton` (MYND-260). */
const TITLE_BAR_NAV_WIDTH = 26;
/** Gap between the left toggle and each nav button in the top-left cluster. */
const TITLE_BAR_CLUSTER_GAP = 2;
/** Shared chrome-button styling for the floated title-bar controls (sidebar
 *  toggle + back/forward nav). Each button adds its own `width` and the
 *  disabled-dependent `cursor`/`opacity`. */
const TITLE_BAR_BUTTON_BASE: CSSProperties = {
  display: "flex",
  alignSelf: "center",
  alignItems: "center",
  justifyContent: "center",
  height: TITLE_BAR_CONTROL_HEIGHT,
  flexShrink: 0,
  border: 0,
  borderRadius: "var(--radius-1)",
  background: "transparent",
  color: "var(--fg-3)",
  transition: HOVER_TRANSITION,
};

// Sidebar toggles float in the editor's top corners (the OS title-bar row),
// Obsidian-style - there is no separate top bar; each top pane's tab strip
// rises into that row. These constants place the toggles clear of the macOS
// traffic lights and size the clearance the underlying top surface (sidebar
// header or a corner pane's strip) must reserve so nothing collides.
// The left toggle x-offset + left clearance are computed PER-RENDER inside
// EditorChrome (`leftToggleX` / `leftClearance`) because they depend on the live
// fullscreen state (the traffic-light gap collapses in fullscreen).
/** Right toggle's x offset from the right edge — shared with the tab strip's
 *  trailing inset, so the two end the row on one line. */
const RIGHT_TOGGLE_X = TITLE_BAR_RIGHT_EDGE;
/** Full width of the top-left control cluster: the sidebar toggle plus the
 *  back + forward nav buttons (MYND-260), each preceded by a cluster gap. */
const LEFT_CONTROLS_WIDTH =
  TITLE_BAR_TOGGLE_WIDTH + 2 * (TITLE_BAR_CLUSTER_GAP + TITLE_BAR_NAV_WIDTH);
/** Right clearance: the top-right surface must keep its content before this.
 *  Reserves room for BOTH floated controls - the note-actions "…" menu plus the
 *  right-sidebar toggle beside it - so a collapsed-right pane's tab strip never
 *  slides under either. */
const RIGHT_CLEARANCE =
  RIGHT_TOGGLE_X + 2 * TITLE_BAR_TOGGLE_WIDTH + TITLE_BAR_CLUSTER_GAP + 8;

/**
 * The Notion-style workspace switcher row at the top of the left sidebar,
 * above the Notes list (MYND-166). Full-width chip - mark + vault name +
 * chevron - with a downward dropdown. Carries the sidebar's right + bottom
 * hairlines so the edge is continuous and it separates from the Notes list.
 * Hidden when there's no vault info to show (the switcher self-suppresses).
 */
function SidebarVaultSwitcher({
  onSwitchVault,
  onCreateAnother,
  onJoinDevice,
  switching,
}: {
  onSwitchVault?: (targetVaultId: VaultId) => void;
  onCreateAnother?: () => void;
  onJoinDevice?: () => void;
  switching: boolean;
}) {
  // `onJoinDevice` is deliberately absent from this gate: it is capability-
  // gated (myne#221), and a client that cannot hold a second vault must lose
  // that one footer row, not the whole switcher.
  if (onSwitchVault === undefined || onCreateAnother === undefined) return null;
  return (
    <div
      style={{
        flexShrink: 0,
        // Sits below the traffic-light clearance row, so normal padding - no
        // bottom divider (it reads as a header above the Notes list directly).
        padding: "8px 8px 6px",
        // Ground painted by SidebarPane - see its comment.
        borderInlineEnd: "1px solid var(--line-1)",
      }}
    >
      <VaultSwitcher
        onSwitchVault={onSwitchVault}
        onCreateAnother={onCreateAnother}
        onJoinDevice={onJoinDevice}
        switching={switching}
      />
    </div>
  );
}

function TitleBarToggle({
  side,
  collapsed,
  onToggle,
  disabled = false,
}: {
  side: "left" | "right";
  collapsed: boolean;
  onToggle: () => void;
  /** MYND-192 - true when the sidebar is collapsed by a too-narrow window;
   *  the toggle is inert (can't expand into space that isn't there, and
   *  must not persist a manual flip the responsive override imposed). */
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const label =
    side === "left"
      ? collapsed
        ? t("editor.chrome.sidebarToggle.showNotes")
        : t("editor.chrome.sidebarToggle.hideNotes")
      : collapsed
        ? t("editor.chrome.sidebarToggle.showBacklinks")
        : t("editor.chrome.sidebarToggle.hideBacklinks");
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-label={label}
      title={label}
      data-testid="editor.sidebar-toggle"
      data-side={side}
      data-collapsed={collapsed ? "true" : "false"}
      {...hoverSurface({ disabled })}
      style={{
        ...TITLE_BAR_BUTTON_BASE,
        width: TITLE_BAR_TOGGLE_WIDTH,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <PanelToggleGlyph side={side} collapsed={collapsed} />
    </button>
  );
}

/**
 * Back / forward note-navigation button (MYND-260), sitting in the top-left
 * cluster immediately right of the left sidebar toggle. Browser-style: steps
 * the focused pane through the sequence of notes it has shown. Disabled
 * (greyed) when there is no history in that direction - matching the
 * `TitleBarToggle` disabled treatment.
 */
function TitleBarNavButton({
  direction,
  onClick,
  disabled,
}: {
  direction: "back" | "forward";
  onClick: () => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const label =
    direction === "back"
      ? t("editor.chrome.nav.goBack")
      : t("editor.chrome.nav.goForward");
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      data-testid={`editor.nav-${direction}`}
      data-disabled={disabled ? "true" : "false"}
      {...hoverSurface({ disabled })}
      style={{
        ...TITLE_BAR_BUTTON_BASE,
        width: TITLE_BAR_NAV_WIDTH,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Icon name={direction === "back" ? "arrow-left" : "arrow-right"} size={16} />
    </button>
  );
}

/**
 * Builds the `CommandContext` from `useSelectedNote` + parent callbacks
 * and renders the `<CommandPalette>`. Lives inside `<SidebarStateProvider>`
 * so the note title cache is reachable for the "Switch to note…"
 * sub-palette.
 */
type CommandPaletteHostProps = {
  open: boolean;
  onClose: () => void;
  /** Re-open the palette - used to pop back from a QuickPicker sub-flow on
   *  cancel (Esc/backdrop), so the picker reads as stacked on top of the palette. */
  onReopen: () => void;
  onOpenSettings: () => void;
  onOpenAttachments: () => void;
  onManageTemplates: () => void;
  onNewNoteFromTemplate: () => void;
  onOpenSnapshots: () => void;
  onExportNoteMarkdown: () => void;
  onExportNotePdf: () => void;
  onExportNoteHtml: () => void;
  onExportNoteTxt: () => void;
  /** Whether the note-actions "…" menu is shown, the SAME fact the tab strip's
   *  right clearance and the right-sidebar toggle use. Handed down rather than
   *  recomputed so the three cannot drift. */
  topRightFloatsShown: boolean;
  onShowGraph: () => void;
  onShowIsolatedGraph: () => void;
  onShowTags: () => void;
  onShowViews: () => void;
  onImportObsidian: () => void;
  onShowTasks: () => void;
  onImportBaseView: () => void;
  onBackupVault: () => void;
  onRestoreBackup: () => void;
  onExportVaultMarkdown: () => void;
  onLockFlushed: () => Promise<void>;
  onToggleLeftSidebar: () => void;
  onToggleRightSidebar: () => void;
  onToggleStackedTabs: () => void;
  onToggleReading: () => void;
  onToggleSource: () => void;
  onToggleFocus: () => void;
  onSaveWorkspaceAs: () => void;
  onSwitchWorkspace: () => void;
  onRenameWorkspace: () => void;
  onDeleteWorkspace: () => void;
  /** Show a toast (with an optional undo action) - the note-actions "…" menu's
   *  convert-to-template / convert-to-note items announce themselves through it. */
  setToast: Dispatch<SetStateAction<EditorToast | null>>;
};

// One period-note failure string per period. Spelled out as literals rather
// than built from the period name, because a template-built key is invisible to
// `check-i18n.mjs` and would go missing from the catalog silently.
const PERIOD_OPEN_FAILED_KEY: Record<Period, string> = {
  daily: "editor.periodicNotes.openFailed.daily",
  weekly: "editor.periodicNotes.openFailed.weekly",
  monthly: "editor.periodicNotes.openFailed.monthly",
};

function CommandPaletteHost({
  open,
  onClose,
  onReopen,
  setToast,
  onOpenSettings,
  onRestoreBackup,
  onOpenAttachments,
  onManageTemplates,
  onNewNoteFromTemplate,
  onOpenSnapshots,
  onExportNoteMarkdown,
  onExportNotePdf,
  onExportNoteHtml,
  onExportNoteTxt,
  topRightFloatsShown,
  onShowGraph,
  onShowIsolatedGraph,
  onShowTags,
  onShowViews,
  onImportObsidian,
  onShowTasks,
  onImportBaseView,
  onBackupVault,
  onExportVaultMarkdown,
  onLockFlushed,
  onToggleLeftSidebar,
  onToggleRightSidebar,
  onToggleStackedTabs,
  onToggleReading,
  onToggleSource,
  onToggleFocus,
  onSaveWorkspaceAs,
  onSwitchWorkspace,
  onRenameWorkspace,
  onDeleteWorkspace,
}: CommandPaletteHostProps) {
  const { t } = useTranslation();
  const ctx = useSelectedNote();
  // Deferred picker sub-flows (palette-gap #31 Apply custom theme, #32 Move note
  // to folder): the action populates this config → the QuickPicker opens. Null
  // when no picker is active. Rendered as a sibling of the palette; independent
  // of `open`, so it survives the palette closing on action-run.
  const [picker, setPicker] = useState<{
    title: string;
    placeholder: string;
    emptyText: string;
    items: QuickPickItem[];
    onPick: (id: string) => void;
  } | null>(null);
  // The QuickPicker's cancel pops back to the command palette (the picker reads
  // as stacked on top of it). That is right for a palette-initiated picker, but
  // the note-actions "…" menu opens the SAME move-to-folder picker while the
  // palette is closed - so its cancel must NOT summon a palette the user never
  // opened. Set for that one invocation path; consumed on the next picker close.
  const suppressPaletteReopenRef = useRef(false);
  // Deferred empty-trash confirm (the palette `trash.empty` action): the
  // trashed count at request time, null when closed. A permanent purge never
  // fires straight from the palette - this renders the same count-aware
  // DeleteConfirmModal the TrashPanel footer uses, and only confirm purges.
  // Rendered as a sibling like `picker`, so it survives the palette closing.
  const [emptyTrashConfirm, setEmptyTrashConfirm] = useState<
    { count: number; viaKey: boolean } | null
  >(null);
  // The note cover's picker (myne-md/myne#410). Editor-local boolean, per the
  // desktop modal carve-out that governs every other modal here. Deliberately
  // its OWN mount, separate from the cards-view picker inside `PaneView`: this
  // change does not touch the saved-views subsystem, and sharing that state
  // machine would mean touching it.
  // `| null` rather than an `open` flag, matching `picker` and
  // `emptyTrashConfirm` beside it: two booleans would encode four states for a
  // two-state thing, and every close would have to remember to reset both.
  // `noteId` is the note the picker was opened FOR, not necessarily the focused
  // one (myne-md/myne#520). `null` means the entry point did not name one, and
  // `applyNoteCover` falls back to `activeNoteId` for those: the command palette
  // and the title-row control both genuinely mean "the focused note".
  const [coverPicker, setCoverPicker] = useState<
    { hasCover: boolean; noteId: string | null } | null
  >(null);
  // AI surface (local-ai epic, ai-ux-surface MYND-408, SYNC-9): the `ai_enabled`
  // gate + the AI Chat reveal, threaded into CommandContext so AI capability
  // actions (siblings 4/6/7) gate on `stageName === "editor" && aiEnabled` and
  // open the shared right-panel AI Chat tab.
  const { prefs: aiPrefs, setRightPanelActiveTab: revealRightPanelTab } = usePrefs();
  // Wave 2: layout/pane/tab/nav palette actions dispatch straight to the
  // workspace controller (CommandPaletteHost is inside WorkspaceProvider).
  const paletteWs = useWorkspace();
  // The focused pane's active note. Local to this host (the chrome's
  // `focusedActiveNoteId` is a sibling scope): cover handlers must pin THIS,
  // not `ctx.selectedId`, because bridge B mirrors focus → selection in a
  // passive effect and a palette open right after a split can still read the
  // previous pane (nco3).
  const focusedActiveNoteId =
    paletteWs.focusedLeaf.activeTab?.kind === "note"
      ? paletteWs.focusedLeaf.activeTab.id
      : null;
  // (The palette's real-time-sync toggle was dropped in the develop merge - the
  // sync engine now manages SSE as an always-on baseline with an info-only
  // Privacy row, so there is no user-toggleable pref to bind, `useSyncPrefs`
  // mock removed on develop.)
  // Drop the ephemeral AI render stores when the editor session tears down
  // (lock / vault-switch unmounts this host) - the AS1 artifacts (summary text +
  // the chat transcript) never outlive the open vault (SYNC-8;
  // conversational-ai-chat task 12: the chat transcript is RAM-only, wiped on
  // lock. Unlike the summary it is vault-scoped, so it is NOT cleared on a mere
  // note switch below - only here, on the vault teardown). Tag suggestions are
  // not among them: the band's state is per-pane React state (MYND-651), torn
  // down with the pane rather than through a module store.
  useEffect(
    () => () => {
      clearAiOutput();
      clearChat();
    },
    [],
  );
  // Also drop the AI render stores when the SELECTED NOTE changes (the host
  // stays mounted across a note switch, so the unmount cleanup above does not
  // fire). Without this, note A's summary lingers - and could be inserted into
  // note B - after switching. Bumping the run epoch (inside the clear) also
  // drops any of A's in-flight runs so they never resolve onto B.
  useEffect(() => {
    clearAiOutput();
  }, [ctx.selectedId]);
  // Open this period's note (MYND-191 daily, myne#177 weekly + monthly): one
  // entry point for all three, error handling included. Idempotent
  // open-or-create over the FULL note set (authoritative note_list +
  // loadNoteBatch, not the partial sidebar cache). Found → open; not found →
  // create, from that period's template if it has one and otherwise a blank
  // note titled with the period, in that period's folder, then open. Past
  // periods are reached through the ordinary sidebar folder, no calendar.
  //
  // Daily is not special here: `periodSettings` is where the prefs asymmetry
  // lives (daily reads three flat fields, the others read the map), and a
  // second wrapper for it would put that knowledge in a second place.
  const onOpenPeriodNote = useCallback(
    async (period: Period) => {
      try {
        const prefs = await prefsRead();
        const ids = await noteList();
        const notes = await loadNoteBatch(ids);
        const settings = periodSettings(prefs, period);
        // ONE instant, read once, in the DISPLAY timezone (myne#177). It
        // anchors the period AND renders the template's `{{date}}`/`{{time}}`:
        // the date the app shows, the date it files under and the date the body
        // carries all have to be the same date, and with a `timezone` override
        // set none of the three agreed.
        const now = zonedNow(new Date(), prefs.timezone);
        const res = resolvePeriodNote(now, period, settings, notes);
        let id: NoteId;
        if (res.kind === "open") {
          id = res.id;
        } else if (settings.template) {
          // Template set → instantiate from it (the period title as eager
          // title, the period's own bounds behind
          // {{period_start}}/{{period_end}}).
          id = (await createNoteFromTemplate(
            settings.template,
            res.dateTitle,
            res.folder,
            now,
            { start: res.range.start, end: res.range.end },
          )) as NoteId;
        } else {
          // No template → a blank note titled with the period.
          id = (await createBlankNamedNote(res.dateTitle, res.folder)) as NoteId;
        }
        // A note created HERE is not yet in the sidebar cache, and bridge A only
        // opens a selection that is live (`ctx.cache.has(selectedId)`), so
        // `ctx.open` alone leaves the pane on the empty note-switcher: the note
        // is on disk and `note_list` sees it, but no tab ever opens. Register it
        // first (the same step `createAndStartRename` performs via its optimistic
        // create); `refreshOne` is a no-op cost for the already-cached `open`
        // branch above.
        await ctx.refreshOne(id);
        await ctx.open(id);
      } catch (err) {
        // The user is TOLD. A DEV-only console.warn is an empty catch in a
        // production build, which makes the palette command a silent no-op:
        // seven awaits run behind this, any of which can fail, and the mobile
        // twin of this function has always surfaced it.
        setToast({ message: t(PERIOD_OPEN_FAILED_KEY[period]), variant: "error" });
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn(`[Editor] open the ${period} note failed:`, err);
        }
      }
    },
    [ctx, setToast, t],
  );
  // "Open random note" (MYND-323): serendipitous review. Picks uniformly from the
  // live, non-template notes (mirrors sidebar visibility - trashed/templates are
  // excluded). With ≥2 eligible notes the current one is dropped so the pick
  // always moves; the empty case shows a toast, never a modal.
  const onOpenRandomNote = useCallback(async () => {
    try {
      const ids = await noteList();
      const records = await loadNoteBatch(ids);
      let candidates = records
        .filter((r) => r.trashed === null && r.template !== true)
        .map((r) => r.noteUuid);
      if (candidates.length === 0) {
        showAttachmentToast(t("editor.chrome.noNotesToOpen"));
        return;
      }
      if (candidates.length > 1 && ctx.selectedId !== null) {
        const without = candidates.filter((id) => id !== ctx.selectedId);
        if (without.length > 0) candidates = without;
      }
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      await ctx.open(pick as NoteId);
    } catch (err) {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn("[Editor] open random note failed:", err);
      }
    }
  }, [ctx, t]);
  const commandCtx: CommandContext = useMemo(
    () => ({
      stageName: "editor",
      selectedNoteId: ctx.selectedId,
      aiEnabled: aiPrefs.ai_enabled,
      // The live prefs view for the toggle/cycle/set palette actions (Wave 1+).
      prefs: aiPrefs,
      // Wave 2 - layout / panes / tabs / navigation, dispatched to the workspace.
      onSplitRight: () => paletteWs.splitFocused("row"),
      onSplitDown: () => paletteWs.splitFocused("column"),
      onClosePane: () => paletteWs.closePane(paletteWs.focusedPaneId),
      onCloseTab: () => {
        const a = paletteWs.focusedLeaf.activeTab;
        if (a !== null && a.kind === "note")
          paletteWs.closeTabInPane(paletteWs.focusedPaneId, a.id);
      },
      onNextTab: () => {
        const tabs = paletteWs.focusedLeaf.tabs;
        if (tabs.length === 0) return;
        const cur = paletteWs.focusedLeaf.activeTab;
        const i =
          cur !== null && cur.kind === "note"
            ? tabs.findIndex((t) => t.kind === "note" && t.id === cur.id)
            : -1;
        const next = tabs[(i + 1) % tabs.length]!;
        if (next.kind === "note") paletteWs.activateInPane(paletteWs.focusedPaneId, next.id);
      },
      onPrevTab: () => {
        const tabs = paletteWs.focusedLeaf.tabs;
        if (tabs.length === 0) return;
        const cur = paletteWs.focusedLeaf.activeTab;
        const i =
          cur !== null && cur.kind === "note"
            ? tabs.findIndex((t) => t.kind === "note" && t.id === cur.id)
            : -1;
        const next = tabs[(i - 1 + tabs.length) % tabs.length]!;
        if (next.kind === "note") paletteWs.activateInPane(paletteWs.focusedPaneId, next.id);
      },
      onFocusNextPane: () => {
        const ids = paletteWs.leaves.map((l) => l.id);
        if (ids.length < 2) return;
        const i = ids.indexOf(paletteWs.focusedPaneId);
        paletteWs.focusPane(ids[(i + 1) % ids.length]!);
      },
      onFocusPrevPane: () => {
        const ids = paletteWs.leaves.map((l) => l.id);
        if (ids.length < 2) return;
        const i = ids.indexOf(paletteWs.focusedPaneId);
        paletteWs.focusPane(ids[(i - 1 + ids.length) % ids.length]!);
      },
      onGoBack: () => paletteWs.goBack(),
      onGoForward: () => paletteWs.goForward(),
      onTogglePreview: () => paletteWs.toggleCompanion(paletteWs.focusedPaneId),
      // Wave 3 - note ops (via the sidebar-state ctx) + right-panel tabs.
      onNewNote: () => void ctx.createAndStartRename().catch(() => {}),
      onDuplicateNote: () => {
        if (ctx.selectedId !== null) void ctx.duplicateAndOpen(ctx.selectedId).catch(() => {});
      },
      onOpenInNewWindow: () => {
        // Desktop-only; the palette/menu already gate on has("detachedWindows"),
        // and on any non-desktop reach the host dispatcher answers the typed
        // unsupported refusal. SYNC-6 (one note, one surface): route rather than
        // always spawn. Suppress a detached window re-popping its OWN note; reveal
        // an already popped-out note; otherwise MOVE it (detachNote spawns the
        // pop-out and closes the source tab) so a note is never a live main-window
        // tab AND a live pop-out autosaving the same blob at once.
        const id = ctx.selectedId;
        if (id === null) return;
        const route = decidePopOutRoute({
          noteId: id,
          isDetached: paletteWs.isDetached,
          requestingDetachedNoteId: currentDetachedNoteId(),
        });
        if (route === "suppress") return;
        if (route === "reveal") {
          void openDetachedWindow(id).catch(() => {});
          return;
        }
        paletteWs.detachNote(id);
      },
      onArchiveNote: () => {
        const id = ctx.selectedId;
        if (id !== null) {
          // Surfaced (not swallowed): `archiveNote` now flushes dirty panes
          // first and REJECTS when one does not settle (myne-md/myne#819), so
          // the palette action can now fail where it previously could not.
          void ctx
            .archiveWithRollback(id)
            .then(() => {
              // Archiving takes the note out of the live tree: close its tabs
              // in every pane, or the pane keeps a resident, editable buffer
              // whose next autosave drops `archived:` back off (myne-md/myne#819).
              // The palette + the editor "..." menu are the two surfaces that
              // reach this handler; both previously left the tab open.
              paletteWs.closeNoteEverywhere(id);
            })
            .catch(() => {
              showAttachmentToast(t("notes.list.archiveSingleError"));
            });
        }
      },
      onRenameNote: () => {
        if (ctx.selectedId !== null) ctx.startRename(ctx.selectedId);
      },
      onTrashNote: () => {
        const id = ctx.selectedId;
        if (id !== null) {
          // Same as `onArchiveNote`: `trashNote`'s flush rejection must reach
          // the user rather than being swallowed.
          void ctx
            .trashWithRollback(id)
            .then(() => {
              // Trashing also removes the note from the live tree, so close its
              // tabs - a stale buffer autosaved back would resurrect it
              // (myne-md/myne#819).
              paletteWs.closeNoteEverywhere(id);
            })
            .catch(() => {
              showAttachmentToast(t("notes.list.trashSingleError"));
            });
        }
      },
      onEmptyTrash: (viaKey: boolean) => {
        // Permanent purge - request the count-aware confirm instead of firing
        // directly (the TrashPanel footer's flow); the purge runs on confirm.
        const count = trashedRecords(ctx.cache).length;
        if (count > 0) setEmptyTrashConfirm({ count, viaKey });
      },
      onToggleFavorite: () => {
        if (ctx.selectedId === null) return;
        const id = ctx.selectedId;
        // #252: re-read disk truth, then toggle. `favorites` is a whole-sequence
        // write, so deriving `next` from THIS component's `usePrefs` snapshot
        // dropped every favourite starred from the sidebar since it last read -
        // and `favorites` is `SharedDiscipline::SequenceLww`, so the truncation
        // won on every other device. Reading first makes the write depend on
        // what is stored rather than on which surface rendered more recently.
        //
        // The read-modify-write lives in `toggleFavoriteOnDisk` so every
        // snapshot-holding surface gets the same treatment rather than each
        // re-deriving the sequence from whatever it last rendered.
        void toggleFavoriteOnDisk(id).catch(() => {
          // A failed read must not fall back to the stale snapshot - that is
          // the write this fix exists to prevent.
        });
      },
      onShowBacklinks: () => void revealRightPanelTab("backlinks"),
      onShowOutline: () => void revealRightPanelTab("outline"),
      onShowUnlinked: () => void revealRightPanelTab("unlinked"),
      onRestoreBackup,
      // Palette-gap #32 - move the selected note to a folder via the QuickPicker.
      // Targets are the vault's folders (from the sidebar cache) plus any empty
      // "deliberate" folders, sorted, with "Vault root" (empty id → null) first.
      onMoveNote: () => {
        if (ctx.selectedId === null) return;
        const noteId = ctx.selectedId;
        const folders = new Set<string>();
        for (const rec of ctx.cache.values()) {
          // Live, non-template notes only - a folder that survives solely on
          // trashed/archived/template notes isn't a sidebar destination.
          if (rec.trashed !== null || rec.archived !== null || rec.template) continue;
          if (rec.folder) folders.add(rec.folder);
        }
        for (const f of aiPrefs.deliberate_folders) folders.add(f);
        const items: QuickPickItem[] = [
          { id: "", label: t("commands.picker.vaultRoot") },
          ...[...folders].sort().map((f) => ({ id: f, label: f })),
        ];
        setPicker({
          title: t("commands.picker.moveNoteTitle"),
          placeholder: t("commands.picker.moveNotePlaceholder"),
          emptyText: t("commands.picker.noFolders"),
          items,
          onPick: (id) => {
            void ctx.bulkMoveWithSync([noteId], id === "" ? null : id).catch(() => {});
          },
        });
      },
      // Palette-gap #31 - apply a saved custom theme via the QuickPicker. Lists
      // the vault's custom themes (MYND-486: names from the vault.themes store -
      // every stored theme is valid); picking one reads its palette, persists it
      // as the active choice, and applies it live (the CustomThemesSection apply
      // path).
      onApplyCustomTheme: () => {
        void (async () => {
          // Each entry already carries its palette - MYND-486 makes the single
          // `vault.themes` blob decrypt every palette to answer a list at all,
          // so hold them by name and apply the picked one directly instead of
          // buying it back with a second full decrypt via `readCustomTheme`.
          const entries = await listCustomThemes();
          const palettes = new Map(entries.map((e) => [e.name, e.palette]));
          const items: QuickPickItem[] = entries.map(({ name }) => ({
            id: name,
            label: name,
          }));
          setPicker({
            title: t("commands.picker.applyThemeTitle"),
            placeholder: t("commands.picker.applyThemePlaceholder"),
            emptyText: t("commands.picker.noCustomThemes"),
            items,
            onPick: (name) => {
              void (async () => {
                const palette = palettes.get(name);
                if (palette === undefined) return;
                await setCustomTheme(name);
                applyCustomTheme(palette);
              })().catch(() => {});
            },
          });
        })().catch(() => {});
      },
      onOpenAiChat: () => void revealRightPanelTab("ai-chat"),
      // The agent hub, on its vault-general view (myne-md/myne#771). Opening
      // the tab is the workspace controller's job; the palette only asks.
      onOpenAgentVault: () => paletteWs.openAgent(),
      // The agent hub on the open note's Focus view. The note is read from the
      // workspace (the focused pane's active tab), so it follows a split.
      onOpenAgentNote: () => paletteWs.openAgentOnNote(paletteWs.focusedNoteId ?? undefined),
      // Summarize the focused note into the AI Chat tab (note-summarization
      // tasks 3-4): reveal the render target, grab the focused pane's live view
      // via the `getActiveEditorView` registry (the palette pattern), then drive
      // the tested `runSummarizeToStore` pipeline (resolve → truncate → blocking
      // `infer` → ephemeral render). Returns stub output until Candle.
      onSummarizeNote: () => {
        revealRightPanelTab("ai-chat");
        const view = getActiveEditorView();
        if (view === null) return;
        // SYNC-14 fail-closed: never summarize a note in an excluded folder, and
        // never run when the note's folder is unknown (no selection / not cached)
        // - an unknown folder must not default to root and slip past the gate.
        if (ctx.selectedId === null) return;
        const cached = ctx.cache.get(ctx.selectedId);
        if (cached === undefined) return;
        // A cached entry with `folder === null` is a genuine root note ("").
        if (isNoteAiExcluded(cached.folder ?? "", aiPrefs.ai_excluded_folders)) return;
        void runSummarizeToChat({
          state: view.state,
          budget: SUMMARIZE_BUDGET_CHARS,
          infer: aiInfer,
        });
      },
      // Re-run the meeting AI pass on the open note (meeting-ai). The pass is
      // offered once after a meeting stops; this is the way back to it, for a
      // note the user dismissed the offer on or wants to regenerate. The
      // transcript is recovered from the note's own body and the same dialog
      // opens, so the write path and the gates are unchanged.
      onSummarizeMeeting: () => {
        const view = getActiveEditorView();
        if (view === null || ctx.selectedId === null) return;
        const cached = ctx.cache.get(ctx.selectedId);
        if (cached === undefined) return;
        // SYNC-14 fail-closed, same as onSummarizeNote.
        if (isNoteAiExcluded(cached.folder ?? "", aiPrefs.ai_excluded_folders)) return;
        const transcript = extractMeetingTranscript(view.state.doc.toString());
        if (transcript.length === 0) return;
        offerMeetingAi(ctx.selectedId, transcript);
      },
      // Rewrite the current selection (writing-assistant `/yeniden-yaz` as a
      // palette action): resolve the selection span via the tested `computeRewrite`
      // core, then replace it in place as plain markdown (`ai.rewrite`, one undo
      // step). A no-op on an empty selection.
      onRewriteSelection: () => {
        // **Every exit from here ANSWERS.** These four returns were silent, and
        // they reproduced exactly the failure the comment below records as
        // fixed: no toast, no error and no document change, indistinguishable
        // from the action never having fired. Moving the orchestration into
        // `rewriteSelectionToEditor` closed the engine-rejection path and left
        // these four open, one layer up, which is the shape this repo keeps
        // finding.
        //
        // The first three are internal inconsistencies rather than user
        // mistakes: the action's own `visibility` already requires the editor
        // stage and a selected note, so reaching them means the palette offered
        // something the app then could not do. The user cannot act on the cause,
        // but they can act on knowing it did not happen.
        const view = getActiveEditorView();
        if (view === null || ctx.selectedId === null) {
          setToast({ message: t("editor.flow.aiRewriteUnavailable"), variant: "error" });
          return;
        }
        const cached = ctx.cache.get(ctx.selectedId);
        if (cached === undefined) {
          setToast({ message: t("editor.flow.aiRewriteUnavailable"), variant: "error" });
          return;
        }
        // SYNC-14 fail-closed: never rewrite a note in an excluded folder, and
        // never when the folder is unknown (see onSummarizeNote). **Said out
        // loud**, because this one is not an internal fault: the user
        // configured the exclusion, so naming it is the difference between
        // "Myne honoured my setting" and "this command is broken". It leaks
        // nothing they did not already choose.
        if (isNoteAiExcluded(cached.folder ?? "", aiPrefs.ai_excluded_folders)) {
          setToast({ message: t("editor.flow.aiRewriteExcluded"), variant: "error" });
          return;
        }
        // Snapshot the note + the immutable pre-inference state, so the
        // multi-second blocking infer cannot land a stale range onto a document
        // the user edited (or a different note they switched to) in the meantime.
        const noteAtStart = ctx.selectedId;
        // The orchestration lives in `rewriteToEditor` so its FAILURE path can
        // be tested (#191 task 6). It used to be an un-`catch`ed IIFE right
        // here, which meant an engine rejection produced no toast, no error and
        // no document change - indistinguishable, from the user's seat, from
        // the action never having fired.
        void rewriteSelectionToEditor({
          view,
          stateAtStart: view.state,
          activeView: getActiveEditorView,
          stillSameNote: () => ctx.selectedId === noteAtStart,
          infer: aiInfer,
          showToast: (message: string) => setToast({ message, variant: "error" }),
          t,
        });
      },
      onLock: onLockFlushed,
      // The palette's own entry point (myne-md/myne#773). Both values are
      // already props of this host — `onReopen` exists so a cancelled
      // QuickPicker sub-flow pops back to the palette, and re-opening it from
      // the rail is the same operation — so the action needed no new plumbing,
      // only a name in the context.
      onOpenPalette: onReopen,
      paletteOpen: open,
      onOpenSettings,
      onManageTemplates,
      onNewNoteFromTemplate,
      onOpenPeriodNote,
      onOpenRandomNote,
      onOpenAttachments,
      onOpenSnapshots,
      onExportNoteMarkdown,
      onExportNotePdf,
      onExportNoteHtml,
      onExportNoteTxt,
      // The cover picker's keyboard door (myne-md/myne#410). Built here rather
      // than threaded in as a prop because the picker's state lives in this
      // component, and it is the one entry point a keyboard-only user has: the
      // banner control and the title-row control are both hover-revealed.
      onSetNoteCover: () => {
        onClose();
        // Pin the FOCUSED pane's note, not `ctx.selectedId` via a null noteId.
        // Bridge B mirrors focus → selection in a passive effect, so a palette
        // open right after a split/focus click can still read the previous pane
        // and the cover lands there (nco3).
        setCoverPicker({ hasCover: false, noteId: focusedActiveNoteId });
      },
      onRemoveNoteCover: () => {
        onClose();
        applyNoteCover(null, focusedActiveNoteId);
      },
      onShowGraph,
      onShowIsolatedGraph,
      onShowTags,
      onShowViews,
      onImportObsidian,
      onShowTasks,
      onImportBaseView,
      onBackupVault,
      onExportVaultMarkdown,
      onToggleLeftSidebar,
      onToggleRightSidebar,
      onToggleStackedTabs,
      onToggleReading,
      onToggleSource,
      onToggleFocus,
      onSaveWorkspaceAs,
      onSwitchWorkspace,
      onRenameWorkspace,
      onDeleteWorkspace,
      onSelectNote: async (id) => {
        await ctx.open(id).catch(() => {
          /* selection failure surfaces via sidebar UX */
        });
      },
    }),
    [
      ctx.selectedId,
      ctx.open,
      ctx.cache,
      // Whole prefs object (not just ai_*): the Wave-1 toggle/cycle actions read
      // ctx.prefs, so commandCtx must re-memoize on ANY pref change.
      aiPrefs,
      paletteWs,
      // onMoveNote / onApplyCustomTheme resolve their QuickPicker strings via
      // `t` at run time - a language switch must rebuild them.
      t,
      onRestoreBackup,
      revealRightPanelTab,
      onLockFlushed,
      onReopen,
      open,
      onOpenSettings,
      onManageTemplates,
      onNewNoteFromTemplate,
      onOpenPeriodNote,
      onOpenRandomNote,
      onOpenAttachments,
      onOpenSnapshots,
      onExportNoteMarkdown,
      onExportNotePdf,
      onExportNoteHtml,
      onExportNoteTxt,
      // Cover handlers close over the focused pane's note (nco3): rebuild when
      // focus moves so they do not act on a stale id.
      focusedActiveNoteId,
      onShowGraph,
      onShowIsolatedGraph,
      onShowTags,
      onShowViews,
      onImportObsidian,
      onShowTasks,
      onImportBaseView,
      onBackupVault,
      onExportVaultMarkdown,
      onToggleLeftSidebar,
      onToggleRightSidebar,
      onToggleStackedTabs,
      onToggleReading,
      onToggleSource,
      onToggleFocus,
      onSaveWorkspaceAs,
      onSwitchWorkspace,
      onRenameWorkspace,
      onDeleteWorkspace,
    ],
  );
  // Left-ribbon bridge (myne-md/myne#699): the rail renders in the Editor's
  // layout row, a sibling subtree, so it reaches the live command context
  // through `ribbonCommands`. Same service-locator shape as `sidebarCommands`.
  useEffect(() => {
    ribbonCommands.run = (id) => {
      const action = COMMAND_ACTIONS.find((a) => a.id === id);
      if (action === undefined || action.visibility(commandCtx) !== "show") return;
      recordCommandRun(id);
      // A rail click that fails must say so: the button already acted pressed.
      // `run` may be sync or async; normalizing lets one catch cover both.
      void Promise.resolve(action.run(commandCtx)).catch(() => {
        setToast({ message: t("editor.ribbon.runFailed"), variant: "error" });
      });
    };
    ribbonCommands.visibility = (id) => {
      const action = COMMAND_ACTIONS.find((a) => a.id === id);
      return action?.visibility(commandCtx) ?? "hidden";
    };
    return () => {
      ribbonCommands.run = undefined;
      ribbonCommands.visibility = undefined;
    };
  }, [commandCtx, setToast, t]);
  // Stable note predicates (fresh identity only when the cache changes): they
  // sit in the palette's snippet-effect deps, and an inline arrow's per-render
  // identity would re-run that effect - re-issuing its `note_read` decrypts -
  // on every unrelated host render.
  const isTrashed = useCallback(
    (id: string) => ctx.cache.get(id)?.trashed != null,
    [ctx.cache],
  );
  const isTemplate = useCallback(
    (id: string) => ctx.cache.get(id)?.template === true,
    [ctx.cache],
  );
  // The editor-chrome "…" menu (Obsidian-style). It reuses the SAME
  // `commandCtx` note-action handlers the palette dispatches - a second surface
  // onto one IPC path, never a second path. It only exists while a note is open
  // in the focused pane, mirroring the right-sidebar toggle's own gate (which
  // lives in `EditorChrome`), so the two float side by side; `centerView` is
  // the one gate input `EditorChrome` owns, threaded in as a prop.
  const showNoteActions = topRightFloatsShown;
  // The note the "…" menu acts on (the focused-pane note the other items use).
  // Its template flag flips the convert item between promote and demote - the
  // dead `convertNoteToTemplate` wire (nothing called it) and the modal-only
  // `convertTemplateToNote`, surfaced where you author.
  const activeNoteId = ctx.selectedId;
  const activeIsTemplate = activeNoteId !== null && isTemplate(activeNoteId);
  // Settle an out-of-band frontmatter write: a canonical field written straight
  // to disk while the note is OPEN leaves the pane's buffer holding the
  // pre-write bytes, and the next autosave writes them back and silently
  // reverts the change. Re-read the open note so its buffer carries the new
  // frontmatter, then re-read the record so the tree settles. Skipped for a
  // dirty buffer, which the reload guards.
  //
  // Shared by every such write, and the recipe itself lives in
  // `src/notes/settleFrontmatterWrite.ts` rather than here, because a third
  // caller in another file hand-copied the two lines back when it was a closure
  // in this component. It belongs to the BUG CLASS, so if it ever gains a step,
  // one edit has to cover all of them.
  const settleFrontmatterWrite = (id: string) =>
    settleFrontmatterWriteFor(ctx, id as NoteId);
  // Convert with an undo toast: promoting a note to a template makes it LEAVE
  // the sidebar (templates are inverse-visibility, hidden like trash), so the
  // toast is what keeps it from reading as "my note vanished". Undo runs the
  // exact inverse. `refreshOne` re-reads the flipped record so the tree settles.
  const convertActive = (toTemplate: boolean) => {
    if (activeNoteId === null) return;
    const id = activeNoteId;
    // The convert and its UNDO answer the same two rejection classes with the
    // same two sentences, so the pair is resolved once here rather than spelled
    // twice twenty lines apart, which is what the helper it calls exists to stop.
    const reportConvertFailure = (err: unknown) => {
      setToast({
        message: panesNotSettledMessage(err, {
          unsettled: t("notes.unsettledSave"),
          failed: t("editor.noteActions.convertFailed"),
        }),
        variant: "error",
      });
    };
    const forward = toTemplate ? convertNoteToTemplate : convertTemplateToNote;
    const inverse = toTemplate ? convertTemplateToNote : convertNoteToTemplate;
    // The convert wrote the `template:` flag straight to disk, out of band of
    // the open pane's buffer - the frontmatter-vs-buffer staleness class that
    // `settleFrontmatterWrite` above exists for.
    const settle = () => settleFrontmatterWrite(id);
    void forward(id)
      .then(settle)
      .then(() => {
        setToast({
          message: toTemplate
            ? t("editor.noteActions.turnedIntoTemplate")
            : t("editor.noteActions.convertedToNote"),
          variant: "success",
          action: {
            label: t("notes.list.undo"),
            onAction: () => {
              setToast(null);
              // The UNDO inherits the same refusal the forward path does, and it
              // is the sixth surface rather than a special case: `inverse` is
              // the other convert, so it opens with the same flush. Undo also
              // dismisses this toast first, so a swallowed rejection leaves the
              // user with a note that did not revert and nothing on screen at
              // all.
              void inverse(id).then(settle).catch(reportConvertFailure);
            },
          },
        });
      })
      // It used to say nothing, on the reasoning that a failed mutation leaves
      // the note unchanged. That stopped being the whole story when the convert
      // gained `flushBeforeFrontmatterWrite`: a REFUSED convert also leaves the
      // note unchanged, and it is the app declining rather than a backend
      // failing, which is a fact the user's own unsaved text explains and which
      // clears itself once that save lands. Silence here is indistinguishable
      // from a converted note whose row simply moved out of the sidebar, which
      // is exactly what the undo toast above exists to prevent for the
      // successful case.
      .catch(reportConvertFailure);
  };
  // The note cover (myne-md/myne#410). `setNoteCover` writes `cover:` straight
  // to disk while the note is OPEN, so it is the same staleness class as the
  // template convert above and settles the same way. It also flushes any dirty
  // pane first, and so does the convert; both do it inside the writer rather
  // than here, so no caller can skip it (myne-md/myne#520,
  // `notes/flushBeforeFrontmatterWrite.ts`).
  //
  // `target` is the note the CONTROL named, and reading `activeNoteId`
  // unconditionally was the other half of #520: the banner's controls
  // `preventDefault` on `mousedown`, so a press in an unfocused pane never
  // focuses it and the passive effect that syncs the selection has not run
  // either, which cleared the OTHER pane's note. `null` keeps the old meaning,
  // "the focused note" — resolved as the focused pane's active note first,
  // then `selectedId` (bridge B's mirror), because selection can lag focus
  // across a split (nco3).
  const applyNoteCover = (choice: CoverChoice | null, target: string | null) => {
    const id = target ?? focusedActiveNoteId ?? activeNoteId;
    setCoverPicker(null);
    if (id === null) return;
    void setNoteCover(id, COVER_FIELD_KEY, choice)
      .then(() => settleFrontmatterWrite(id))
      .catch((err: unknown) => {
        // Say so. A swallowed failure here is indistinguishable from "the cover
        // I picked did not apply for some reason I cannot see": the note is
        // unchanged, the picker has already closed, and nothing on screen moved.
        //
        // Through the shared helper, like the saved-view card's cover write one
        // file over: this is the SAME branch on the same writer, and the two
        // surfaces were answering it differently. A refusal is the app declining
        // because of the user's own unsaved text and clears itself when that save
        // lands; "could not update" gives them nothing to act on.
        setToast({
          message: panesNotSettledMessage(err, {
            unsettled: t("notes.unsettledSave"),
            failed: t("editor.cover.writeFailed"),
          }),
          variant: "error",
        });
      });
  };
  // The note the open picker will write to, resolved ONCE here rather than at
  // each of the CoverPicker's three props below, which would be three copies of
  // one precedence rule to keep in step. `null` when no picker is open, or when
  // the entry point named nothing and nothing is selected either.
  const coverPickerTarget =
    coverPicker === null
      ? null
      : (coverPicker.noteId ?? focusedActiveNoteId ?? activeNoteId);
  // The banner's two hover controls reach this component through window signals,
  // the same shape the vim `:q` ex command uses: the banner is CodeMirror DOM in
  // the shared editor package, with no route into the React context that owns
  // both the modal mounts and the knowledge of which note is focused.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<OpenCoverPickerDetail>).detail;
      setCoverPicker({
        hasCover: detail?.hasCover === true,
        noteId: detail?.noteId ?? null,
      });
    };
    // `?? null` on a possibly-absent detail rather than a destructure: the event
    // is dispatched by whichever host build is loaded, and a bare
    // `new CustomEvent(REMOVE_COVER_EVENT)` still has to mean "the focused note"
    // rather than throw.
    const onRemove = (e: Event) => {
      const detail = (e as CustomEvent<RemoveCoverDetail>).detail;
      applyNoteCover(null, detail?.noteId ?? null);
    };
    window.addEventListener(OPEN_COVER_PICKER_EVENT, onOpen);
    window.addEventListener(REMOVE_COVER_EVENT, onRemove);
    return () => {
      window.removeEventListener(OPEN_COVER_PICKER_EVENT, onOpen);
      window.removeEventListener(REMOVE_COVER_EVENT, onRemove);
    };
    // Re-subscribes when the focused note changes, which is what the vim `:q`
    // listener below does too. The alternative (an empty dep list plus a ref
    // mutated during render to keep the handler fresh) is the React-19 shape
    // `src/AGENTS.md` warns about, and buys nothing here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNoteId]);

  // The palette's four export handlers, keyed by the shared format id, so the
  // "…" menu's submenu stays a projection of `noteExportFormats()` instead of a
  // third copy of the list. `?.()` rather than a bare reference because
  // `CommandContext` declares several of its callbacks optional, and a submenu
  // row owes a handler either way.
  const exportHandlerByFormat: Record<NoteExportFormat["id"], () => void> = {
    "export-markdown": () => commandCtx.onExportNoteMarkdown?.(),
    "export-pdf": () => commandCtx.onExportNotePdf?.(),
    "export-html": () => commandCtx.onExportNoteHtml?.(),
    "export-txt": () => commandCtx.onExportNoteTxt?.(),
  };

  const noteActionItems: NoteActionMenuItem[] = [
    {
      kind: "action",
      action: "rename",
      icon: "pencil",
      label: t("editor.noteActions.rename"),
      onSelect: commandCtx.onRenameNote,
    },
    {
      kind: "action",
      action: "cover",
      icon: "image",
      // Always "Add cover", never "Change cover": this menu cannot see whether
      // the open note has one (the note cache carries no cover state), and a
      // label that guesses would be wrong half the time. The picker itself is
      // the surface that shows what is already there.
      label: t("editor.cover.add"),
      onSelect: () =>
        setCoverPicker({ hasCover: false, noteId: focusedActiveNoteId }),
    },
    {
      kind: "action",
      action: "move",
      icon: "folder",
      label: t("editor.noteActions.move"),
      // Same handler the palette uses; flag the shared picker so its cancel
      // won't open a command palette this surface never launched.
      onSelect: () => {
        suppressPaletteReopenRef.current = true;
        commandCtx.onMoveNote();
      },
    },
    {
      kind: "action",
      action: "duplicate",
      icon: "copy",
      label: t("editor.noteActions.duplicate"),
      onSelect: commandCtx.onDuplicateNote,
    },
    // Desktop-only (myne#173): omitted where the pop-out capability is absent,
    // so web/mobile never show an item the host would refuse. `data-action`
    // ("open-in-new-window") is the E2E testid the menu surfaces.
    ...((has("detachedWindows")
      ? [
          {
            kind: "action",
            action: "open-in-new-window",
            icon: "maximize-2",
            label: t("editor.noteActions.openInNewWindow"),
            onSelect: commandCtx.onOpenInNewWindow,
          },
        ]
      : []) as NoteActionMenuItem[]),
    {
      kind: "action",
      action: "version-history",
      icon: "rotate-ccw",
      label: t("editor.noteActions.versionHistory"),
      onSelect: commandCtx.onOpenSnapshots,
    },
    { kind: "divider" },
    {
      kind: "action",
      action: activeIsTemplate ? "convert-to-note" : "convert-to-template",
      icon: activeIsTemplate ? "file-text" : "layout-grid",
      label: activeIsTemplate
        ? t("editor.noteActions.convertToNote")
        : t("editor.noteActions.convertToTemplate"),
      onSelect: () => convertActive(!activeIsTemplate),
    },
    { kind: "divider" },
    {
      kind: "action",
      action: "export",
      icon: "download",
      // ONE row with a submenu, where there used to be one row per format. Four
      // of them made up a third of this menu, and the sidebar row's menu
      // carried the same four again. The list itself now comes from
      // `noteExportFormats()`, shared with that menu, including the
      // `pdfExport` gate, which used to be on the sidebar side only, so this
      // menu was the one still offering PDF on a host that cannot make one.
      label: t("notes.export.submenuLabel"),
      // Never called: a row with `children` opens them instead of acting.
      onSelect: () => {},
      children: noteExportFormats().map((format) => ({
        action: format.id,
        label: t(format.labelKey),
        // Still the palette's own handlers, so this stays a second SURFACE onto
        // one IPC path rather than a second path, the rule this menu's header
        // states. They also close the palette, which the direct-flow runner in
        // `noteExportEntries` has no business doing, and that is the whole
        // reason the shared module stops at the format list here.
        onSelect: exportHandlerByFormat[format.id],
      })),
    },
    { kind: "divider" },
    {
      kind: "action",
      action: "trash",
      icon: "trash-2",
      label: t("editor.noteActions.trash"),
      destructive: true,
      onSelect: commandCtx.onTrashNote,
    },
  ];
  return (
    <>
      <CommandPalette
        open={open}
        onClose={onClose}
        ctx={commandCtx}
        isTrashed={isTrashed}
        isTemplate={isTemplate}
        isArchived={(id) => ctx.cache.get(id)?.archived != null}
      />
      {showNoteActions && (
        <div
          style={{
            position: "absolute",
            top: TITLE_BAR_CONTROL_TOP,
            // Sits just left of the right-sidebar toggle (at RIGHT_TOGGLE_X),
            // one cluster gap between them, so the two read as one group.
            right: RIGHT_TOGGLE_X + TITLE_BAR_TOGGLE_WIDTH + TITLE_BAR_CLUSTER_GAP,
            zIndex: 30,
          }}
        >
          <NoteActionsMenu
            label={t("editor.noteActions.buttonLabel")}
            items={noteActionItems}
          />
        </div>
      )}
      <QuickPicker
        open={picker !== null}
        title={picker?.title ?? ""}
        placeholder={picker?.placeholder ?? ""}
        emptyText={picker?.emptyText ?? ""}
        items={picker?.items ?? []}
        onPick={(id) => {
          picker?.onPick(id);
          setPicker(null);
          suppressPaletteReopenRef.current = false;
        }}
        // Cancel (Esc / backdrop) pops back to the command palette - the picker
        // is stacked on top of it (the palette closed when the action ran) -
        // UNLESS the "…" menu opened it with the palette closed (see the ref).
        onClose={() => {
          const suppress = suppressPaletteReopenRef.current;
          suppressPaletteReopenRef.current = false;
          setPicker(null);
          if (!suppress) onReopen();
        }}
      />
      <CoverPicker
        // `coverPickerTarget` is the note the entry point named, falling back to
        // the focused one, so a picker opened from a banner in an unfocused pane
        // writes to that pane's note (myne-md/myne#520).
        open={coverPickerTarget !== null}
        // Comes from whichever entry point opened it: the banner's Change
        // control passes true (a banner only renders for a note that has one),
        // the "Add cover" entries pass false.
        hasCover={coverPicker?.hasCover === true}
        onClose={() => setCoverPicker(null)}
        onPick={(choice) => applyNoteCover(choice, coverPickerTarget)}
        onRemove={() => applyNoteCover(null, coverPickerTarget)}
      />
      {emptyTrashConfirm !== null && (
        <DeleteConfirmModal
          title={t("notes.trash.emptyConfirmTitle")}
          body={t("notes.trash.emptyConfirmBody", { count: emptyTrashConfirm.count })}
          confirmLabel={t("notes.trash.emptyConfirmCta")}
          // The palette's own answer, threaded through `CommandContext`. It was
          // an unconditional `true` for one E2E run, on the reasoning that the
          // palette is a keyboard-first surface, and `et1` failed three times
          // over: a row selected with a click leaves no Enter to release, so the
          // dialog ate the user's first press.
          openedByKey={emptyTrashConfirm.viaKey}
          onCancel={() => setEmptyTrashConfirm(null)}
          onConfirm={() => {
            setEmptyTrashConfirm(null);
            // Re-derive the kill list from the CURRENT trashed set at confirm
            // time (the TrashPanel discipline): a note restored while the
            // confirm was up must NOT be purged.
            const ids = trashedRecords(ctx.cache).map((r) => r.noteUuid);
            if (ids.length === 0) return;
            void ctx
              .emptyTrashWithSync(ids)
              .then((result) => {
                // Close the tabs of the notes that WERE purged, so none stays
                // editable after its blob is gone (myne-md/myne#819; the palette
                // Empty-trash twin of TrashPanel's close-on-success). A failed
                // purge rolled back and the note still exists, so its tab stays.
                for (const id of result.purged) paletteWs.closeNoteEverywhere(id);
                // Best-effort bulk purge - report a remaining count on partial
                // failure (the palette has no status line, so toast it).
                if (result.failed.length > 0) {
                  showAttachmentToast(
                    t("notes.trash.emptyPartialFailure", {
                      count: result.failed.length,
                    }),
                  );
                }
              })
              .catch(() => {});
          }}
        />
      )}
    </>
  );
}

/**
 * Initial-boot sidebar refresh: `note_list` → chunked `loadNoteBatch`
 * → cache populate. Runs once on mount inside the provider tree.
 *
 * Also owns the global Cmd+N keymap (T25) - wired here so the
 * shortcut fires regardless of which pane is focused.
 *
 * Returns `null` - purely a side-effect mount. The actual sidebar
 * surface is `<NotesSidebarList>` rendered as a sibling.
 */
function SidebarBootstrap() {
  const ctx = useSelectedNote();
  const booted = useRef(false);
  // MYND-574 task 64 - the deep link resolves HERE, and only here, because this
  // is the one place that has the authoritative note list. A URL is untrusted
  // input and a bookmark outlives the note it points at, so the id is checked
  // against `note_list` before it is opened; an id that is not there is dropped
  // and the user lands in an empty editor, never on an error. `routeReady`
  // gates the URL binding below: nothing may rewrite the address bar until this
  // settles, or a reload (which always lands locked on web - the keys are RAM)
  // would throw away the note it was asked to restore.
  const [routeReady, setRouteReady] = useState(false);
  useEffect(() => {
    if (booted.current) return; // StrictMode double-invoke guard
    booted.current = true;
    void (async () => {
      try {
        const ids = await noteList();
        const records = await ctx.refreshAll(ids);
        // myne-md/myne#613: register the folders this vault's notes already
        // prove, once per unlocked session. A vault created before at-fill has
        // no registrations at all, so its oldest folders are exactly the ones
        // that still vanish when emptied.
        //
        // Here rather than inside `refreshAll` on purpose: this effect is
        // `booted`-latched, so it is the unlock, while `refreshAll`'s six other
        // callers include every sync pull. Backfilling on a pull would re-add a
        // folder a peer had deleted, from notes whose deletions have not
        // arrived yet. Fire-and-forget: it never blocks the sidebar and never
        // fails the boot.
        // `prefsRead()` rather than the `usePrefs` cache: at first render that
        // cache still holds the defaults while its own read is in flight, and
        // an empty `deliberate_folders` read as truth would make this send an
        // ADD for every folder on every unlock, forever.
        void prefsRead()
          .then((p) => backfillDeliberateFolders(records, p.deliberate_folders))
          .catch(() => {});
        const target = takeDeepLinkNoteId();
        if (target !== null && ids.includes(target)) ctx.select(target);
        // The plain-file Import action (myne-md/myne#788) creates its note
        // while this screen is unmounted (the plain surface renders INSTEAD of
        // the stage), so it leaves a one-shot request that lands here. Checked
        // against the live list for the same reason the deep link is: the note
        // may have been deleted before the surface closed.
        const imported = takeRequestedNoteOpen();
        if (imported !== null && ids.includes(imported)) ctx.select(imported);
      } catch (e) {
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn("[Editor] sidebar boot refresh failed:", e);
        }
      } finally {
        // Also on the failure path: a boot that could not read the list must
        // not leave the address bar frozen for the rest of the session.
        setRouteReady(true);
      }
    })();
  }, [ctx]);

  useNoteRoute({ active: routeReady, selectedId: ctx.selectedId, select: ctx.select });

  // Global Cmd/Ctrl+N → create new note. Folded into the rebindable
  // `note.new-tab` command as a second default chord (Mod-t, Mod-n) so it is
  // listed + rebindable (#184 C) - the WorkspaceHotkeys `note.new-tab` entry runs
  // the same `createAndStartRename`; no longer a hardcoded window listener here.

  return null;
}

/**
 * Tab/pane keyboard shortcuts (MYND-166). Window-level so they fire
 * regardless of which pane / sidebar has focus, and they act on the
 * FOCUSED pane. Skipped while typing in a non-editor input (e.g. the
 * sidebar rename field), but active inside the CM6 editor (`.cm-content`).
 *
 * Bindings (grill 2026-06-01, routed around the reserved `Cmd+K` palette):
 *   Cmd/Ctrl+T              new note (opens in the focused pane)
 *   Cmd/Ctrl+W              close the focused pane's active tab
 *   Ctrl+Tab / +Shift       next / prev tab in the focused pane
 *   Cmd/Ctrl+\ / +Shift     split the focused pane right / down
 *   Cmd/Ctrl+Alt+Arrows     move focus to the next / prev pane
 *   Cmd/Ctrl+[ / ]          navigate back / forward through note history
 */
// In-code DEFAULT chords for the keybind dispatcher (hotkeys epic, MYND-304).
// Sourced from the single bindable-command catalog (no second copy of the
// chord literals - the catalog is the one place defaults live). The dispatcher
// only fires the ids it has entries for, so passing the full catalog (including
// the commands handled elsewhere) is harmless; the user override
// (vault.prefs.keymap) shadows these per id. Ctrl+Tab is deliberately NOT a
// catalog-rebindable default - see the inline handler note below.
const KEYBIND_DEFAULTS: Readonly<Record<string, string[]>> = catalogDefaults();

function WorkspaceHotkeys({
  focusActive,
  activeModal,
  onToggleFocus,
  onExitFocus,
  onTogglePalette,
  onToggleSettings,
}: {
  focusActive: boolean;
  /** The modal currently owning the screen, or `null` (myne#336). */
  activeModal: string | null;
  onToggleFocus: () => void;
  onExitFocus: () => void;
  onTogglePalette: () => void;
  onToggleSettings: () => void;
}) {
  const ws = useWorkspace();
  const ctx = useSelectedNote();
  const { prefs } = usePrefs();

  // The Mod-based window shortcuts now flow through the central keybind engine
  // (MYND-304): each is a registered entry whose effective chord = the user
  // override (vault.prefs.keymap) else the in-code default. `run` closures carry
  // the EXACT prior behaviour; the dispatcher applies the scope gate (stands
  // down in plain inputs, like the old `isTypingInPlainInput` guard) and the
  // capture phase for `nav.back`/`nav.forward` (so Cmd-[/] still beats CM's
  // indent via stopPropagation).
  const entries = useMemo<KeybindEntry[]>(() => {
    const focusAdjacent = (forward: boolean) => {
      const ids = ws.leaves.map((l) => l.id);
      if (ids.length < 2) return;
      const i = ids.indexOf(ws.focusedPaneId);
      const next = ids[(i + (forward ? 1 : -1) + ids.length) % ids.length]!;
      ws.focusPane(next);
    };
    return [
      {
        id: "note.new-tab",
        scope: {},
        run: () => void ctx.createAndStartRename().catch(() => {}),
      },
      {
        id: "pane.close-tab",
        scope: {},
        run: () => {
          const a = ws.focusedLeaf.activeTab;
          if (a !== null && a.kind === "note") ws.closeTabInPane(ws.focusedPaneId, a.id);
        },
      },
      { id: "pane.split-row", scope: {}, run: () => ws.splitFocused("row") },
      { id: "pane.split-column", scope: {}, run: () => ws.splitFocused("column") },
      { id: "pane.focus-next", scope: {}, run: () => focusAdjacent(true) },
      { id: "pane.focus-prev", scope: {}, run: () => focusAdjacent(false) },
      // The three-region keyboard model (myne#728). `scope: {}` is the right
      // gate and deliberately not `allowInPlainInput`: F6 is how a keyboard
      // user LEAVES the note body, and `focusKindOf` classifies `.cm-content`
      // as `cm-editor` rather than a plain input, so the chord is live exactly
      // where it is needed and stands down in a rename field, where Escape is
      // the way out. Nothing here touches the workspace: a region is a DOM
      // marker, so the run closures are one call each.
      { id: "focus.cycle-region", scope: {}, run: () => enterRegion("next") },
      { id: "focus.sidebar", scope: {}, run: () => enterRegion("sidebar") },
      { id: "focus.editor", scope: {}, run: () => enterRegion("editor") },
      { id: "focus.right-panel", scope: {}, run: () => enterRegion("right-panel") },
      { id: "nav.back", scope: {}, phase: "capture", run: () => ws.goBack() },
      { id: "nav.forward", scope: {}, phase: "capture", run: () => ws.goForward() },
      // reading-source-modes (MYND-299): Edit⇄Reading on the focused note tab.
      // Default Mod-Shift-e (catalog), rebindable; inline-code keeps Mod-e.
      {
        id: "view.toggle-reading",
        scope: {},
        run: () => {
          const tab = ws.focusedLeaf.activeTab;
          if (tab !== null && tab.kind === "note") {
            ws.setFocusedTabViewMode(tab.viewMode === "reading" ? "live" : "reading");
          }
        },
      },
      // focus-mode (MYND-348): distraction-free toggle (default Mod-Shift-f).
      { id: "view.toggle-focus", scope: {}, run: () => onToggleFocus() },
      // command-palette (MYND-86 + MYND-40): default Mod-k / Mod-p, both toggle
      // the same unified palette. `scope: {}` reproduces the old hardcoded
      // listener's gate exactly - stands down in plain inputs (rename/search),
      // stays live inside the CM6 editor surface. The dispatcher's preventDefault
      // also suppresses the WebView's native Print dialog on Cmd+P.
      // Survives a modal on purpose (myne#336): this chord is how the user
      // CLOSES the palette, so gating it under "a modal is open" would trap
      // them in it.
      { id: "palette.toggle", scope: { allowInModal: true }, run: () => onTogglePalette() },
      // #184 track D - these three were hardcoded window listeners (settings,
      // graph) or palette-only with an INERT declared chord (tasks); routing them
      // through the engine is what makes the panel's "rebindable" mark honest and
      // their default chords actually fire.
      // Same reasoning as `palette.toggle` above - it is the close chord too.
      { id: "app.open-settings", scope: { allowInModal: true }, run: () => onToggleSettings() },
      { id: "graph.show", scope: {}, run: () => ws.openGraph() },
      { id: "tasks.show", scope: {}, run: () => ws.openTasks() },
      // In-note find (#184): open the docked find bar. App.tsx still owns the
      // app-wide native-Cmd+F suppression; this only opens the bar (editor stage,
      // stands down in plain inputs). find-session is lazy-loaded (kept out of
      // first-load); by now the editor chunk has already imported it.
      {
        id: "find.open",
        scope: {},
        run: () =>
          void import("../editor/find/find-session").then((m) => m.openInNoteFind()),
      },
    ];
  }, [ws, ctx, onToggleFocus, onTogglePalette, onToggleSettings]);

  useKeybindDispatcher({
    entries,
    defaults: KEYBIND_DEFAULTS,
    overrides: prefs.keymap,
    stageName: "editor",
    // myne#336 - both of these were hardcoded, so the two gates the engine
    // documents never engaged.
    //
    // `activeModal: null` meant "window shortcuts stand down under a modal"
    // was never true: under a modal the user believes is exclusive, window
    // chords silently acted on the workspace behind it - tabs closed, notes
    // were created into an unreachable inline rename, the center view changed,
    // pane history moved. Nothing is overwritten, but the user comes back to a
    // workspace that is not the one they left, with no record of what changed.
    //
    // `selectedNoteId: null` made `ctx.hasSelectedNote` permanently false, so
    // any entry declaring `scope.requiresNote` would silently never fire. Inert
    // today because no entry uses the flag - which is exactly how it would have
    // stayed until the first one did.
    selectedNoteId: ctx.selectedId,
    activeModal,
  });

  // vim `:q` / `:wq` / `:x` (MYND-313). The ex table lives in the editor package
  // and cannot reach this context, so it emits a window signal; closing the tab
  // reuses the exact same path as the `pane.close-tab` chord above.
  useEffect(() => {
    const onCloseTab = () => {
      const active = ws.focusedLeaf.activeTab;
      if (active !== null && active.kind === "note") {
        ws.closeTabInPane(ws.focusedPaneId, active.id);
      }
    };
    window.addEventListener(CLOSE_ACTIVE_TAB_EVENT, onCloseTab);
    return () => window.removeEventListener(CLOSE_ACTIVE_TAB_EVENT, onCloseTab);
  }, [ws]);

  // Ctrl+Tab / Ctrl+Shift+Tab - cycle tabs in the focused pane. Kept as a
  // literal-Ctrl inline handler OUTSIDE the rebindable keymap: Ctrl+Tab is a
  // cross-platform browser convention (literal Ctrl on every OS), but the
  // engine's `Mod` token maps `ctrlKey`→`Mod` on non-mac, so a literal Ctrl
  // can't be distinctly represented as a keymap chord. Treated as an
  // OS/browser-convention chord (same spirit as SYNC-9's CM-formatting
  // deferral); revisit if cross-platform literal-Ctrl bindings become rebindable.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Stand down while typing in a plain input (sidebar rename / search) -
      // the CM6 surface is not "plain-input", so tab-cycle stays live there.
      if (focusKindOf(e.target) === "plain-input") return;
      if (!(e.ctrlKey && e.key === "Tab")) return;
      const tabs = ws.focusedLeaf.tabs;
      if (tabs.length === 0) return;
      e.preventDefault();
      const cur = ws.focusedLeaf.activeTab;
      const i = cur === null ? -1 : tabs.findIndex((t) => sameItem(t, cur));
      const len = tabs.length;
      const next = e.shiftKey ? tabs[(i - 1 + len) % len]! : tabs[(i + 1) % len]!;
      if (next.kind === "note") ws.activateInPane(ws.focusedPaneId, next.id);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [ws]);

  // focus-mode (MYND-348): Esc exits focus as a LOW-precedence fallback. CM6 and
  // the editor's own handlers (autocomplete dismiss, multi-cursor clear) process
  // Escape on the content first and call preventDefault when they consume it; this
  // bubble-phase listener only acts when Escape was NOT already consumed, so it
  // never preempts those. Inactive (no listener) unless focus mode is on.
  useEffect(() => {
    if (!focusActive) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      onExitFocus();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [focusActive, onExitFocus]);

  return null;
}

/**
 * The open note's backlinks pane (knowledge-graph-ux #1 / MYND-195). Wires the
 * placeholder RightSidebar to the live `backlinks()` query: which notes link
 * here, as count-only clickable source cards (no body snippet - grill Q1),
 * alphabetical, self-link hidden, `ctx.open` navigation. No bespoke locked
 * state - the Editor unmounts on lock and its mount-time fail-closed guard
 * covers the race. Stays live via the vault-wide index-changed nonce (SYNC-5):
 * any note's save/rename/move re-queries; the reference-equal bail guards renders.
 */
/**
 * The right panel - a multi-tab surface (right-panel tabs) modeled on the bottom
 * bar: multiple NON-closable tabs (Backlinks / Unlinked mentions / Outline) that
 * drag-reorder and right-click hide/restore, with ONE active tab at a time. The
 * WHOLE-panel show/hide stays the existing `rightCollapsed` toggle (title-bar
 * button + palette command) - unchanged. Each tab body is its own component
 * (`BacklinksTab`, `UnlinkedMentionsSection` in `asTab` mode, `OutlineTab`); this
 * container owns only the strip, the active-tab/order/hidden prefs, and the two
 * right-click menus (the per-tab move/hide + the strip-wide restore checklist).
 */
/** Stable empty list for `agentFolders` while the AI tab is closed, so a
 *  memo miss does not hand the composer a fresh array identity per render. */
const EMPTY_FOLDERS: readonly string[] = [];

function RightSidebar({
  onOpenSettings,
  onShowToast,
}: {
  // Optionally on a panel and scrolled to a setting: the AI status chip names
  // a fault and lands ON the control that clears it rather than at the top of
  // a panel (myne-md/myne#771).
  onOpenSettings?: (panel?: string, anchor?: string) => void;
  onShowToast?: (message: string) => void;
}) {
  const { t } = useTranslation();
  const ctx = useSelectedNote();
  const ws = useWorkspace();
  const notes = useResolverNotes();
  const {
    prefs,
    setRightPanelActiveTab,
    setRightPanelHiddenTabs,
    setRightPanelTabOrder,
  } = usePrefs();

  const selectedId = ctx.selectedId;
  const openTitle = useMemo(
    () =>
      selectedId === null
        ? null
        : (notes.find((n) => n.noteUuid === selectedId)?.title ?? null),
    [selectedId, notes],
  );
  // Insert `[[openTitle]]` into the mentioning note. The target is always a
  // DIFFERENT note (self is excluded from the candidates), so the SYNC-15 guard
  // resolves to a plain disk write - `openNoteDirty: false` is correct in the
  // single-pane v1.1 editor (no live buffer for a non-open note to clobber).
  const handleLinkMention = useCallback(
    async (mention: UnlinkedMention): Promise<boolean> => {
      if (selectedId === null || openTitle === null) return false;
      return linkMention(mention.noteId, openTitle, {
        openNoteId: selectedId,
        openNoteDirty: false,
      });
    },
    [selectedId, openTitle],
  );

  // **One handler for both agent-apply call sites** (myne-md/myne#848): the
  // panel's auto-apply and the review takeover's approved apply write the same
  // two halves, and they were two inline arrows with the second copy already
  // behind once, the sidebar re-index reached the panel's handler first.
  //
  // The two halves, and why each is owed: the open pane re-reads its body,
  // because an apply writes through the backend out of band of any pane's own
  // autosave loop, so without it the editor keeps the pre-apply text AND the
  // pane's next autosave writes that stale buffer back over the edit the user
  // just approved. The sidebar re-reads each written note's own slice, because
  // its tree is derived from its own title/folder cache, which nothing here
  // touched, so an agent that moved notes left them appearing under their OLD
  // folders until something else re-read them.
  const notesWritten = useCallback(
    (ids: readonly string[]) => {
      ctx.reloadOpenNote();
      for (const id of ids) void ctx.refreshOne(id as NoteId);
    },
    [ctx],
  );

  const tabOrder = prefs.right_panel_tab_order;
  const hidden = prefs.right_panel_hidden_tabs;
  const order = useMemo(
    () => resolveBarOrder(tabOrder, RIGHT_PANEL_DEFAULT_ORDER),
    [tabOrder],
  );
  // The AI Chat tab is only offered when AI is actually on (#225): with it off
  // the tab was a dead affordance whose body just pointed the user to Settings.
  // Gated on `ai_enabled` (the feature state), NOT `developer_mode` - turning
  // Developer mode off must never disable a running feature (#181 cli6/vm4), and
  // on web `ai_enabled` is always false (no localAi capability), so the tab is
  // absent there too. Folded into `hidden` so BOTH the strip AND the active-tab
  // resolution treat it as absent (else the active pointer could still land on a
  // now-hidden ai-chat and show its body with no tab).
  const effectiveHidden = useMemo(
    () => (prefs.ai_enabled ? hidden : [...new Set([...hidden, "ai-chat"])]),
    [hidden, prefs.ai_enabled],
  );
  const visible = useMemo(
    () => order.filter((id) => !effectiveHidden.includes(id)),
    [order, effectiveHidden],
  );
  // Healed-on-read: a stored pointer to a now-hidden/unknown tab is reinterpreted
  // (first visible), never rewritten to disk.
  const active = resolveActiveTab(prefs.right_panel_active_tab, order, effectiveHidden);

  // The right-panel strip is one Tab stop (myne#728): arrows move between the
  // icon tabs and activate them, so a panel with several tabs does not cost one
  // stop per tab.
  const rightPanelRoving = useRovingFocus({
    count: visible.length,
    activeIndex: active === null ? -1 : visible.indexOf(active),
    orientation: "horizontal",
    itemSelector: '[role="tab"][data-panel-tab-id]',
    // MANUAL activation (myne#728, review): each activation here WRITES A
    // PREF, so automatic activation performed one IPC write per tab passed
    // over, arrowing from the first tab to the eighth costing seven.
    //
    // Nothing further is needed to activate: these tabs are native
    // `<button>`s, so Enter and Space already fire their `onClick`. An
    // explicit key handler beside that would double-write on Enter and
    // suppress the native click on Space. And no `onActiveIndexChange`: the
    // hook never calls it under manual activation, so a closure here would
    // read as the per-arrow pref write this flag exists to remove.
    manualActivation: true,
  });

  // Folders the composer can attach as a scope. Derived from the notes the
  // resolver already holds, so it needs no second load; the authoritative
  // resolution and the excluded-folder clamp are host-side either way.
  //
  // Gated on the AI tab being open. `notes` changes identity on every note save,
  // so without the gate this sort ran for every user on every save, including
  // everyone who never opens the tab it feeds.
  const agentFolders = useMemo(
    () =>
      active === "ai-chat"
        ? [...new Set(notes.map((n) => n.folder ?? "").filter((f) => f !== ""))].sort()
        : EMPTY_FOLDERS,
    [notes, active],
  );


  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; edge: "before" | "after" } | null>(
    null,
  );
  // Right-click menu anchor: `{x,y}` opens the strip-wide restore checklist;
  // `{x,y,itemId}` opens the per-tab move/hide menu for that tab.
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; itemId?: string } | null>(null);

  return (
    <div
      style={{
        // Fills the layout-seam wrapper, which owns the resizable width.
        // `flex: 1` fills the height below the ribbon header (MYND-166).
        width: "100%",
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        // Ground painted by SidebarPane - see its comment.
        borderInlineStart: "1px solid var(--line-1)",
      }}
    >
      {/* Tab strip - drag-reorder + right-click hide/restore (bottom-bar
          pattern), single active tab. Right-clicking empty strip space opens the
          restore checklist even when every tab is hidden (the only restore path). */}
      <div
        data-testid="editor.right-panel-tabs"
        role="tablist"
        // A tablist with no name is a list of unlabelled icons to a screen
        // reader (myne#728): the tabs themselves carry names, but nothing said
        // what the group IS. The note strip is named the same way.
        aria-label={t("editor.chrome.rightPanel.tabStripLabel")}
        ref={rightPanelRoving.containerRef as RefObject<HTMLDivElement>}
        onKeyDown={rightPanelRoving.onKeyDown}
        onContextMenu={(e) => {
          e.preventDefault();
          setTabMenu({ x: e.clientX, y: e.clientY });
        }}
        style={{
          display: "flex",
          alignItems: "stretch",
          gap: 2,
          padding: "0 8px",
          // Match every other top-chrome strip (note pane tab strip, sidebar
          // clearance rows) so the bottom hairline lines up across the window.
          height: STRIP_HEIGHT,
          flexShrink: 0,
          borderBottom: "1px solid var(--line-1)",
        }}
      >
        {visible.map((id, i) => {
          const tab = RIGHT_PANEL_TABS.find((tt) => tt.id === id);
          if (tab === undefined) return null;
          const isActive = id === active;
          const label = t(tab.labelKey);
          return (
            // Icon-only tabs (the dar-sağ-panel convention - Obsidian/Logseq):
            // the label rides the tooltip + aria-label so three tabs always fit a
            // 280px panel and the strip keeps a right-click-able empty area.
            <button
              key={id}
              type="button"
              role="tab"
              id={`right-panel-tab-${id}`}
              tabIndex={rightPanelRoving.tabIndexFor(i)}
              draggable
              aria-selected={isActive}
              aria-label={label}
              title={label}
              data-testid="editor.right-panel-tab"
              data-panel-tab-id={id}
              data-active={isActive ? "true" : undefined}
              data-dragging={draggedId === id ? "true" : undefined}
              {...hoverSurface()}
              onClick={() => void setRightPanelActiveTab(id)}
              onDragStart={(e) => {
                setDraggedId(id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                if (draggedId === null || draggedId === id) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                const edge = dragEdgeX(e);
                setDropTarget((prev) =>
                  prev?.id === id && prev.edge === edge ? prev : { id, edge },
                );
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (draggedId !== null && draggedId !== id) {
                  void setRightPanelTabOrder(reorderByDrop(order, draggedId, id, dragEdgeX(e)));
                }
                setDraggedId(null);
                setDropTarget(null);
              }}
              onDragEnd={() => {
                setDraggedId(null);
                setDropTarget(null);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setTabMenu({ x: e.clientX, y: e.clientY, itemId: id });
              }}
              style={{
                position: "relative",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flex: "0 0 auto",
                width: 32,
                background: "transparent",
                border: "none",
                borderBottom: isActive ? "2px solid var(--accent)" : "2px solid transparent",
                marginBottom: -1,
                color: isActive ? "var(--fg-1)" : "var(--fg-3)",
                cursor: draggedId === id ? "grabbing" : "pointer",
                opacity: draggedId === id ? 0.4 : 1,
                transition: HOVER_TRANSITION,
              }}
            >
              {dropTarget?.id === id && <div style={insertionLineStyleX(dropTarget.edge)} />}
              <Icon name={tab.icon} size={16} />
            </button>
          );
        })}
        {/* Trailing flex spacer - keeps tabs left-aligned and gives the
            strip-wide restore checklist a reliable empty right-click target (it
            has no onContextMenu of its own, so the event bubbles to the strip). */}
        <div data-testid="editor.right-panel-tabs-rest" style={{ flex: 1, alignSelf: "stretch" }} />
      </div>

      {/* Active tab body */}
      <div
        role="tabpanel"
        aria-labelledby={active === null ? undefined : `right-panel-tab-${active}`}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "16px 18px",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-2)",
        }}
      >
        {active === null ? (
          <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)", marginTop: "var(--space-1)" }}>
            {t("editor.chrome.rightPanel.allHidden")}
          </div>
        ) : active === "backlinks" ? (
          <BacklinksTab />
        ) : active === "unlinked" ? (
          <UnlinkedMentionsSection
            asTab
            openNoteId={selectedId}
            openTitle={openTitle}
            notes={notes}
            onNavigate={(noteId) => void ctx.open(noteId)}
            onLinkMention={handleLinkMention}
          />
        ) : active === "outline" ? (
          <OutlineTab />
        ) : active === "tasks" ? (
          <NoteTasksPanel />
        ) : active === "ai-chat" ? (
          <AiChatTab
            onOpenSettings={onOpenSettings}
            onShowToast={onShowToast}
            // The automatic-apply path writes out of band of any pane's own
            // autosave loop, exactly as the manual one does, so it owes the
            // same reload (myne-md/myne#551). The handler above states both
            // halves, including the sidebar re-index the user reported missing
            // (“it moved them but the sidebar did not re-index live”,
            // myne-md/myne#848).
            onNotesWritten={notesWritten}
            onInsert={(text) => {
              // "Insert into note" (note-summarization task 5, SYNC-17): append a
              // `## Summary` block to the focused note and let the normal autosave
              // path (note_save/MY01) persist it - byte-identical to a hand-typed
              // block, only on this explicit click.
              const view = getActiveEditorView();
              if (view === null) return;
              const newBody = appendSummaryBlock(view.state.doc.toString(), text);
              view.dispatch({
                changes: { from: 0, to: view.state.doc.length, insert: newBody },
                userEvent: "ai.insert",
              });
            }}
            openNoteId={selectedId}
            folders={agentFolders}
            // The panel-to-deep-surface exit (myne-md/myne#771): reveal the
            // agent tab on the open note's Focus view. The workspace controller
            // owns the reveal; without a note it lands on the Hub.
            onFocusAgent={() => ws.openAgentOnNote(selectedId ?? undefined)}
            // An undo rewrites notes out-of-band of any pane's autosave, the
            // same shape a sync pull has, so it reuses the same blanket bump.
            // Each pane applies its own dirty guard, so this never clobbers
            // in-flight typing. Without it the editor keeps rendering the
            // applied text of a note that has just been reverted underneath it.
            onRunUndone={() => ctx.reloadOpenNote()}
          />
        ) : active === "who-is-here" ? (
          <WhoIsHereTab />
        ) : null}
      </div>

      {/* myne#529: the agent review takeover. Full screen rather than a panel:
          approving is meant to be a deliberate act, and a surface at the edge of
          the editor makes it a thing beside the work. Rendered unconditionally
          and self-gating: whether it is on screen is DERIVED from the run rather
          than held as a second Editor boolean somebody has to set. Its own file
          states why. */}
      <AgentReviewTakeover
        titleOf={(noteId) =>
          notes.find((n) => n.noteUuid === noteId)?.title ?? null
        }
        // The folder a move row shows as its starting point. Resolved from the
        // same list `titleOf` reads, so the two can never describe different
        // notes, and `null` when the list does not know the note (a move row then
        // shows the destination alone rather than inventing a source).
        folderOf={(noteId) =>
          notes.find((n) => n.noteUuid === noteId)?.folder ?? null
        }
        // An apply writes through the backend, out of band of any pane's own
        // autosave loop, so without this the editor keeps showing the pre-apply
        // text AND the pane's next autosave writes that stale buffer back over
        // the edit the user just approved. Same two halves as the panel's
        // handler above, and now literally the same handler.
        onNotesWritten={notesWritten}
      />

      {/* Right-click menus (clone of the bottom-bar two-menu pattern). */}
      {tabMenu &&
        (tabMenu.itemId !== undefined ? (
          // Per-tab menu: move left / move right (a11y fallback for drag,
          // boundary moves omitted) + hide.
          <ContextMenu
            x={tabMenu.x}
            y={tabMenu.y}
            onClose={() => setTabMenu(null)}
            items={((): ContextMenuItem[] => {
              const itemId = tabMenu.itemId!;
              const items: ContextMenuItem[] = [];
              if (canMoveBarItem(visible, itemId, -1)) {
                items.push({
                  id: "move-left",
                  label: t("editor.chrome.barItems.moveLeft"),
                  onSelect: () =>
                    void setRightPanelTabOrder(moveBarItem(order, visible, itemId, -1)),
                });
              }
              if (canMoveBarItem(visible, itemId, 1)) {
                items.push({
                  id: "move-right",
                  label: t("editor.chrome.barItems.moveRight"),
                  onSelect: () =>
                    void setRightPanelTabOrder(moveBarItem(order, visible, itemId, 1)),
                });
              }
              items.push({
                id: "hide",
                label: t("editor.chrome.barItems.hide"),
                onSelect: () =>
                  void setRightPanelHiddenTabs(
                    hidden.includes(itemId) ? hidden : [...hidden, itemId],
                  ),
              });
              return items;
            })()}
          />
        ) : (
          // Strip-wide checklist: the only path to restore a hidden tab.
          <ContextMenu
            x={tabMenu.x}
            y={tabMenu.y}
            onClose={() => setTabMenu(null)}
            items={RIGHT_PANEL_TABS.map(
              (tab): ContextMenuItem => ({
                id: tab.id,
                label: t(tab.labelKey),
                checked: !hidden.includes(tab.id),
                closeOnSelect: false,
                onSelect: () =>
                  void setRightPanelHiddenTabs(
                    hidden.includes(tab.id)
                      ? hidden.filter((x) => x !== tab.id)
                      : [...hidden, tab.id],
                  ),
              }),
            )}
          />
        ))}
    </div>
  );
}

/**
 * One resizable/collapsible sidebar slot (MYND-137). When collapsed it
 * renders NOTHING - the pane is fully hidden (MYND-166 removed the thin
 * re-expand rail; toggling is the top-bar buttons + command palette).
 * Otherwise a width-driven `position: relative` wrapper holding the sidebar
 * `children` plus the inner-edge {@link ResizeHandle} (the handle is
 * absolutely positioned, so child order is irrelevant). Both the left
 * (notes) and right (backlinks) panes are this same component, mirrored by
 * `side`.
 */
function SidebarPane({
  side,
  width,
  collapsed,
  min,
  max,
  containerRef,
  onResize,
  onToggleCollapse,
  resizeLabel,
  children,
}: {
  side: "left" | "right";
  width: number;
  collapsed: boolean;
  min: number;
  max: number;
  containerRef: RefObject<HTMLDivElement | null>;
  onResize: (rawWidth: number, containerWidth: number) => void;
  onToggleCollapse: () => void;
  resizeLabel: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  // Collapse/expand is animated by transitioning the pane width between 0 and
  // its open width. The transition stays ARMED at all times EXCEPT during an
  // active resize: a drag changes `width` every pointermove, and an active
  // width transition there would make the pane lag behind the cursor. Arming
  // it permanently (rather than only just-after a collapse flip) is what makes
  // the toggle animate reliably - the transition is already on the element
  // when the width change commits, instead of racing an effect that turns it
  // on after the browser has already painted the new width.
  // Reduced-motion is honoured globally (tokens.css zeroes transition-duration).
  const [resizing, setResizing] = useState(false);
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A resize fires onResize rapidly; keep `resizing` true until a short idle
  // gap signals the drag/keyboard-repeat has stopped, then re-arm the
  // transition. Toggling collapse never calls onResize, so it always animates.
  const markResizing = () => {
    setResizing(true);
    if (resizeTimer.current !== null) clearTimeout(resizeTimer.current);
    resizeTimer.current = setTimeout(() => setResizing(false), 140);
  };
  useEffect(
    () => () => {
      if (resizeTimer.current !== null) clearTimeout(resizeTimer.current);
    },
    [],
  );

  return (
    <div
      // The pane's own box, and the element a layout scenario measures. It is
      // rendered in BOTH states - a collapsed pane is this same div at width 0,
      // not an absent one - so a width read distinguishes collapsed from open
      // without a scenario having to tell "collapsed" from "not mounted yet".
      // That distinction is the whole of what `e2e/window-resize-collapse.e2e.ts`
      // and `e2e/rtl-mirror-sweep.e2e.ts` assert, and both were written against
      // this testid before it existed: `paneWidths` found nothing and reported
      // "no pane" at a window width where both panes were open and visible.
      // A literal per side, never an expression carrying content.
      data-testid={side === "left" ? "editor.sidebar-left" : "editor.sidebar-right"}
      // Region root for the three-region keyboard model (myne#728). The
      // attribute IS the declaration: `src/lib/regions.ts` finds a region by
      // querying for it, so a pane that is not rendered is simply not a region,
      // with nothing to keep in step. A COLLAPSED pane is still rendered (at
      // width 0, with its content `inert`), and the region helper skips it by
      // reading that `inert` rather than by being told.
      //
      // `role="region"` with a name is what makes the same three areas
      // navigable by a screen reader's landmark list. Task 9 of the
      // accessibility pass replaces these with the specific landmark roles
      // (navigation / main / complementary); the names stay.
      {...{ [REGION_ATTR]: side === "left" ? "sidebar" : "right-panel" }}
      // The specific landmarks (myne#728, task 9), replacing the generic
      // `role="region"` task 2 marked these with. The notes sidebar is how the
      // user moves between notes, which is `navigation`; the right panel
      // describes the note that is open, which is `complementary`. Both are
      // named, so a screen reader's landmark list reads as three places rather
      // than three unlabelled regions.
      role={side === "left" ? "navigation" : "complementary"}
      aria-label={
        side === "left"
          ? t("editor.chrome.region.sidebar")
          : t("editor.chrome.region.rightPanel")
      }
      // A sidebar pane is a SURFACE for ornament purposes (myne#394): the theme
      // decides what a panel ground wears. Declared on the outer pane rather
      // than the inner wrapper so the ornament spans the pane's full height
      // even while the collapse animation is running.
      {...ornamentRole("surface")}
      style={{
        position: "relative",
        width: collapsed ? 0 : width,
        flexShrink: 0,
        // THE PANEL GROUND IS PAINTED HERE, not by the blocks inside.
        //
        // The role has always been on this element - but every child painted an
        // opaque `--paper-2` of its own, and the ornament layer is `z-index: -1`
        // inside the host's own stacking context: above the HOST's background,
        // below everything the host contains. So a theme's surface texture,
        // ruled ground or frame was drawn and then covered, on every sidebar,
        // always. Measured by rendering the captured interface: all three
        // surface primitives came back byte-identical to no ornament at all.
        //
        // Moving the fill up here is visually identical (same token, same area)
        // and is what gives the layer a ground to sit on.
        background: "var(--paper-2)",
        display: "flex",
        // Pin the inner content to the inner edge so collapsing clips it
        // toward the screen edge (left sidebar clips right→, right sidebar
        // clips ←left), matching the side the sidebar lives on.
        justifyContent: side === "right" ? "flex-end" : "flex-start",
        overflow: "hidden",
        minHeight: 0,
        // One line on purpose: the motion guard reads an unquoted value to the
        // END OF ITS LINE, so a wrapped ternary made this `width` transition
        // invisible to it (myne-md/myne#868). The exemption that covers it is
        // in `scripts/check-motion-canon.mjs`, beside the mobile twin's.
        transition: resizing ? "none" : "width var(--duration-base) var(--ease-standard)",
      }}
    >
      {/* Fixed-width inner wrapper: keeps the children at their open width so
          they don't reflow/squish while the outer pane animates to 0. */}
      <div
        inert={collapsed ? true : undefined}
        style={{ width, flexShrink: 0, display: "flex", minHeight: 0 }}
      >
        {children}
      </div>
      {!collapsed && (
        <ResizeHandle
          side={side}
          width={width}
          min={min}
          max={max}
          containerRef={containerRef}
          onResize={(raw, cw) => {
            markResizing();
            onResize(raw, cw);
          }}
          onToggleCollapse={onToggleCollapse}
          label={resizeLabel}
        />
      )}
    </div>
  );
}

/**
 * Transient full-pane overlay shown while a multi-vault switch's
 * `vault_lock()` IPC is in flight (MYND-205). The lock is microseconds-to-
 * low-ms (it includes the graceful `flushIfDirty`), so this is a brief
 * scrim with a spinner + "saving…" copy - it makes the lock+flush window
 * visible and blocks stray interaction until the Stage routes to the
 * target's unlock screen. Design-token-only styling; the styled switcher
 * dropdown (task 5) may relocate the "saving…" affordance into the dropdown
 * itself, but the semantics (saving during lock) stay the same.
 */
function SwitchingOverlay() {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="editor.switching-overlay"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        background: "color-mix(in srgb, var(--bg-1) 70%, transparent)",
        backdropFilter: "blur(1px)",
        color: "var(--fg-2)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-sm)",
        fontWeight: "var(--weight-medium)",
      }}
    >
      <Spinner size={16} style={{ borderWidth: 2 }} />
      <span>{t("editor.chrome.switchingOverlay.saving")}</span>
    </div>
  );
}

interface BottomBarProps {
  /** Lock callback that awaits the autosave flush before firing
   *  `lockVault()` and the parent's onLock - wired by `EditorChrome`. */
  onLockFlushed: () => Promise<void>;
  onOpenSettings?: () => void;
  /** Open the whole-vault graph (the persistent wedge-first-class affordance,
   *  SYNC-7) - parallel to the settings gear. */
  /** Open the tag browser (persistent affordance, SYNC-7 refinement, MYND-46). */
  onShowTags?: () => void;
  /** Reveal the Saved Views surface (persistent affordance, SYNC-7, MYND-274). */
  onShowViews?: () => void;
  saveStatus: SaveStatusValue;
  onRetry: () => void;
  /** Hide the save-status badge entirely when no note is selected
   *  (the indicator would otherwise read "Saved" / a stale relative-
   *  time from the previous note and confuse the user). */
  hideSaveStatus?: boolean;
  /** Whether the focused note's latest bytes are not yet on the server
   *  (phase3-web-client task 23) - trails the save readout. */
  saveStatusUnsynced?: boolean;
  /** Whole-note statistics of the active note (frontmatter + markdown syntax
   *  excluded). `null` hides the readout entirely - same rationale as
   *  `hideSaveStatus`: with no note selected the values would be meaningless. */
  stats?: DocStats | null;
  /** Statistics of the current non-empty selection; when non-null the readout
   *  shows these instead of whole-note `stats`. */
  selectionStats?: DocStats | null;
  /** reading-source-modes (MYND-299): the focused note tab's effective view mode
   *  (live/reading/source), or `null` when no note tab is active (hides the
   *  switcher). */
  viewMode?: ViewMode | null;
  /** Cycle the focused note tab's view mode (live → reading → source → live). */
  onCycleViewMode?: () => void;
  /** reading-source-modes (MYND-299): show the side-by-side preview toggle (only
   *  in source mode), its pressed state, and the toggle handler. */
  showPreview?: boolean;
  previewActive?: boolean;
  onTogglePreview?: () => void;
  /** named-workspaces (MYND-308): the slot list driving the bottom-bar switcher
   *  dropdown (active name + switch targets). */
  workspaceSlots?: WorkspaceSlot[];
  /** The active workspace slot id (the dropdown's current selection). */
  activeWorkspaceId?: SlotId;
  /** Switch the active workspace to a slot id (dropdown row click). */
  onSwitchWorkspace?: (id: SlotId) => void;
  /** Open the "Save current as…" name prompt (dropdown footer). */
  onSaveWorkspaceAs?: () => void;
  /** Rename a specific workspace slot (the per-row pencil in the dropdown). */
  onRenameWorkspace?: (id: SlotId) => void;
  /** Bottom-bar customization: the set of element ids the user has hidden via
   *  the bar's right-click menu. Each element renders only when its id is NOT
   *  in this set (AND its pre-existing condition holds). */
  hiddenItems: string[];
  /** Right-click handler that opens the visibility menu (wired by
   *  `EditorChrome`). Set on the bar root so even a fully-hidden bar stays
   *  right-clickable - the only restore path. */
  onContextMenu?: (e: ReactMouseEvent) => void;
  /** Bottom-bar reorder: the user's stored right-cluster display order
   *  (`prefs.bar_items_order`). Resolved against the canonical default at
   *  render so a partial/empty order still renders every visible item. */
  barItemsOrder: string[];
  /** Persist a new right-cluster order after a drag-drop reorder. */
  onReorder: (order: string[]) => void;
  /** Right-click handler for a SPECIFIC bar item - opens the per-item menu
   *  (move left / move right / hide). `visibleIds` is the currently-rendered
   *  ordered id list, used for the move-availability checks. */
  onItemContextMenu: (
    e: ReactMouseEvent,
    itemId: string,
    visibleIds: string[],
  ) => void;
}

function BottomBar({
  onLockFlushed,
  onOpenSettings,
  onShowTags,
  onShowViews,
  saveStatus,
  onRetry,
  hideSaveStatus = false,
  saveStatusUnsynced = false,
  stats = null,
  selectionStats = null,
  viewMode = null,
  onCycleViewMode,
  showPreview = false,
  previewActive = false,
  onTogglePreview,
  workspaceSlots = [],
  activeWorkspaceId,
  onSwitchWorkspace,
  onSaveWorkspaceAs,
  onRenameWorkspace,
  hiddenItems,
  onContextMenu,
  barItemsOrder,
  onReorder,
  onItemContextMenu,
}: BottomBarProps) {
  const { t } = useTranslation();
  // vim-keyboard-mode (MYND-313): the active mode arrives as a bubbled DOM event
  // from the focused editor (`editor/src/vim.ts`), so the bar needs no prop
  // threading through the pane tree. `null` ≡ vim off → the item renders nothing.
  const vimMode = useVimMode();
  // Drag-to-reorder state (right cluster only). `draggedId` is the item being
  // dragged; `dropTarget` is the hovered insertion point (an item id + which
  // side the caret sits on). Both reset on drop / dragend.
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    id: string;
    edge: "before" | "after";
  } | null>(null);
  const handleLockClick = () => {
    void onLockFlushed().catch(() => {
      /* lock flush failures already routed through saveStatus */
    });
  };
  const isHidden = (id: string) => hiddenItems.includes(id);

  // One renderer per right-cluster bar-item id. Each returns the item's node,
  // or `null` when its pre-existing data condition is unmet (e.g. `view-mode`
  // with no active note tab). The `isHidden` check + the canonical ordering are
  // applied in the loop below, so a renderer only encodes data availability.
  const renderers: Record<string, () => ReactNode> = {
    "save-status": () =>
      hideSaveStatus ? null : (
        <SaveStatusBadge
          status={saveStatus}
          onRetry={onRetry}
          unsynced={saveStatusUnsynced}
        />
      ),
    workspace: () =>
      onSwitchWorkspace !== undefined && activeWorkspaceId !== undefined ? (
        <WorkspaceSwitcherControl
          slots={workspaceSlots}
          activeId={activeWorkspaceId}
          onSwitch={onSwitchWorkspace}
          onSaveAs={onSaveWorkspaceAs}
          onRename={onRenameWorkspace}
        />
      ) : null,
    "view-mode": () =>
      viewMode !== null && onCycleViewMode ? (
        <button
          type="button"
          onClick={onCycleViewMode}
          aria-label={t("editor.chrome.bottomBar.cycleViewMode")}
          data-testid="editor.view-mode-cta"
          data-view-mode={viewMode}
          title={t("editor.chrome.bottomBar.viewModeTitle", {
            mode: t(VIEW_MODE_LABEL_KEY[viewMode]),
          })}
          {...hoverSurface()}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "2px 8px",
            background: "transparent",
            border: 0,
            borderRadius: "var(--radius-1)",
            color: "var(--fg-3)",
            cursor: "pointer",
            fontFamily: "var(--font-sans)",
            fontSize: 12,
            fontWeight: "var(--weight-medium)",
            transition: HOVER_TRANSITION,
          }}
        >
          {t(VIEW_MODE_LABEL_KEY[viewMode])}
        </button>
      ) : null,
    tags: () =>
      onShowTags ? (
        <Tooltip label={t("editor.chrome.bottomBar.tagsTitle")}>
          <button
            type="button"
            onClick={onShowTags}
            aria-label={t("editor.chrome.bottomBar.browseTags")}
            data-testid="editor.tags-cta"
            {...hoverSurface()}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "4px 8px",
              background: "transparent",
              border: 0,
              borderRadius: "var(--radius-1)",
              color: "var(--fg-3)",
              cursor: "pointer",
              transition: HOVER_TRANSITION,
            }}
          >
            <Icon name="hash" size={14} />
          </button>
        </Tooltip>
      ) : null,
    views: () =>
      onShowViews ? (
        <Tooltip label={t("editor.chrome.bottomBar.viewsTitle")}>
          <button
            type="button"
            onClick={onShowViews}
            aria-label={t("editor.chrome.bottomBar.browseViews")}
            data-testid="editor.views-cta"
            {...hoverSurface()}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "4px 8px",
              background: "transparent",
              border: 0,
              borderRadius: "var(--radius-1)",
              color: "var(--fg-3)",
              cursor: "pointer",
              transition: HOVER_TRANSITION,
            }}
          >
            <Icon name="layout-grid" size={14} />
          </button>
        </Tooltip>
      ) : null,
    // There is no `graph` renderer: the graph affordance left the bottom bar
    // when the left ribbon shipped (myne-md/myne#727, superseding #396). The
    // command keeps its shortcut, its palette entry and its ribbon metadata.
    settings: () => (
      <Tooltip label={t("editor.chrome.bottomBar.settingsTitle")}>
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label={t("editor.chrome.bottomBar.openSettings")}
          data-testid="editor.settings-cta"
          {...hoverSurface()}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "4px 8px",
            background: "transparent",
            border: 0,
            borderRadius: "var(--radius-1)",
            color: "var(--fg-3)",
            cursor: "pointer",
            transition: HOVER_TRANSITION,
          }}
        >
          <Icon name="settings" size={12} />
        </button>
      </Tooltip>
    ),
    lock: () => (
      <button
        type="button"
        onClick={handleLockClick}
        aria-label={t("editor.chrome.bottomBar.lockVault")}
        data-testid="editor.lock-cta"
        {...hoverSurface()}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-1)",
          padding: "4px 8px",
          background: "transparent",
          border: 0,
          borderRadius: "var(--radius-1)",
          color: "var(--fg-3)",
          fontFamily: "var(--font-sans)",
          fontSize: 12,
          fontWeight: "var(--weight-medium)",
          cursor: "pointer",
          transition: HOVER_TRANSITION,
        }}
      >
        <Icon name="lock" size={12} />
        <span>{t("editor.chrome.bottomBar.lock")}</span>
      </button>
    ),
    "vim-mode": () => {
      // Renders only while vim is on (mode is null otherwise), so a user who
      // never enables it sees a bottom bar identical to today's. `aria-live`
      // makes the transition audible - modal state must not be a purely visual
      // signal (story 12).
      if (vimMode === null) return null;
      return (
        <span
          data-testid="editor.vim-mode"
          data-vim-mode={vimMode}
          aria-live="polite"
          title={t("editor.chrome.bottomBar.vimMode.title")}
          style={{
            ...STATUS_TEXT_STYLE,
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
          }}
        >
          {t(`editor.chrome.bottomBar.vimMode.${vimMode}`, {
            defaultValue: vimMode,
          })}
        </span>
      );
    },
    "word-count": () => {
      // Combined statistics readout (MYND-339), reusing the `word-count`
      // bar-item id (one toggle). Shows the selection figures when a non-empty
      // selection exists, else the whole-note figures; the full four-stat
      // breakdown is in the hover title.
      const shown = selectionStats ?? stats;
      if (shown === null) return null;
      const isSel = selectionStats !== null;
      return (
        <span
          data-testid="editor.doc-stats"
          data-scope={isSel ? "selection" : "document"}
          title={
            t("editor.chrome.bottomBar.docStats.title", {
              characters: shown.characters,
              words: shown.words,
              spaces: shown.spaces,
              count: shown.paragraphs,
            }) +
            (isSel
              ? t("editor.chrome.bottomBar.docStats.titleSelectionSuffix")
              : "")
          }
          style={{
            ...STATUS_TEXT_STYLE,
            fontFamily: "var(--font-mono)",
          }}
        >
          {t("editor.chrome.bottomBar.docStats.summary", {
            characters: shown.characters,
            count: shown.words,
          })}
          {isSel
            ? t("editor.chrome.bottomBar.docStats.summarySelectionSuffix")
            : ""}
        </span>
      );
    },
  };

  // Resolve the user's stored order against the canonical default, drop hidden +
  // data-unavailable items, and keep the rendered (id, node) pairs. `visibleIds`
  // (the ids that actually rendered) drives the per-item move-availability.
  const order = resolveBarOrder(barItemsOrder, RIGHT_CLUSTER_DEFAULT_ORDER);
  const rendered: { id: string; node: ReactNode }[] = [];
  for (const id of order) {
    if (isHidden(id)) continue;
    const node = renderers[id]?.() ?? null;
    if (node === null) continue;
    rendered.push({ id, node });
  }
  const visibleIds = rendered.map((r) => r.id);

  // The preview-companion toggle is pinned OUTSIDE the `BAR_ITEMS` vocabulary
  // (see `barItemsOrder.ts`): it is contextual rather than configurable, and the
  // bar is the only place it lives. So it counts toward the bar being occupied —
  // dropping the bar while it is live would strand an affordance with nowhere
  // else to go.
  const companionPinned = showPreview && onTogglePreview !== undefined;

  // NOTHING to show: no bar at all, rather than an empty 28px strip with a
  // hairline under the editor (myne-md/myne#773). Two things about this are
  // deliberate.
  //
  // It keys off what actually RENDERED, not off `hidden_bar_items.length === 9`.
  // Several renderers already return `null` on a data condition — `vim-mode`
  // when vim is off, `save-status` under `hideSaveStatus`, `view-mode` with no
  // active note tab — so "the user hid everything" and "nothing here applies
  // right now" arrive at the same place and should look the same.
  //
  // And the items are restorable from Settings -> Appearance, not only from this
  // bar's own right-click menu. That is a precondition of this early return
  // rather than a nicety: before it existed, the menu that un-hides an item WAS
  // the bar, so hiding the ninth item would have deleted the only route back and
  // made the setting unrecoverable from the UI that set it.
  if (rendered.length === 0 && !companionPinned) return null;

  return (
    <div
      data-testid="editor.bottom-bar"
      data-editor-chrome
      // Chrome, for ornament purposes (myne#394) - same role as the tab strip.
      {...ornamentRole("chrome")}
      onContextMenu={onContextMenu}
      style={{
        height: 28,
        width: "100%",
        background: "var(--paper-2)",
        borderTop: "1px solid var(--line-1)",
        display: "flex",
        alignItems: "center",
        padding: "0 12px",
      }}
    >
      {/* The flexible spacer. It carries a testid because it is the only
          reliably EMPTY region of the bar: a right-click here is the list menu,
          whereas a right-click anywhere else may land on an affordance and open
          that item's own menu instead. `alignSelf: stretch` is not decoration:
          the bar centres its children, so an empty div collapses to zero height
          and a zero-height element has no addressable centre for a pointer
          action. */}
      <div
        data-testid="editor.bar-spacer"
        style={{ flex: 1, alignSelf: "stretch" }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
        {/* Preview-companion toggle is pinned (contextual, not a BAR_ITEMS id):
            it is never reorderable and anchors at the start of the right
            cluster. */}
        {showPreview && onTogglePreview && (
          <Tooltip label={t("editor.chrome.bottomBar.togglePreview")}>
            <button
              type="button"
              onClick={onTogglePreview}
              aria-label={t("editor.chrome.bottomBar.togglePreview")}
              aria-pressed={previewActive}
              data-testid="editor.preview-companion-toggle"
              {...hoverSurface()}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "2px 6px",
                background: "transparent",
                border: 0,
                borderRadius: "var(--radius-1)",
                color: previewActive ? "var(--fg-1)" : "var(--fg-3)",
                cursor: "pointer",
                transition: HOVER_TRANSITION,
              }}
            >
              <Icon name="panel-right" size={14} />
            </button>
          </Tooltip>
        )}
        {rendered.map(({ id, node }) => (
          <div
            key={id}
            draggable
            data-testid="editor.bar-item"
            data-bar-item-id={id}
            data-dragging={draggedId === id ? "true" : undefined}
            onDragStart={(e) => {
              setDraggedId(id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              if (draggedId === null || draggedId === id) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              const edge = dragEdgeX(e);
              setDropTarget((prev) =>
                prev?.id === id && prev.edge === edge ? prev : { id, edge },
              );
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (draggedId !== null && draggedId !== id) {
                onReorder(reorderByDrop(order, draggedId, id, dragEdgeX(e)));
              }
              setDraggedId(null);
              setDropTarget(null);
            }}
            onDragEnd={() => {
              setDraggedId(null);
              setDropTarget(null);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onItemContextMenu(e, id, visibleIds);
            }}
            style={{
              position: "relative",
              display: "flex",
              alignItems: "center",
              cursor: "grab",
              opacity: draggedId === id ? 0.4 : 1,
            }}
          >
            {dropTarget?.id === id && (
              <div style={insertionLineStyleX(dropTarget.edge)} />
            )}
            {node}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * named-workspaces (MYND-308 task 5) - the bottom-bar workspace switcher: a chip
 * showing the active workspace name with a dropdown listing the slots to switch
 * to plus a "Save current as…" affordance. Carries `data-editor-chrome` so it
 * fades with the rest of the chrome in focus mode (the `[data-focus-active]` CSS
 * rule keys on that attribute) and `data-testid="editor.workspace-switcher"` for
 * the E2E harness (SYNC-8). The palette `workspace.*` commands are the in-focus
 * escape (the bar fades).
 */
function WorkspaceSwitcherControl({
  slots,
  activeId,
  onSwitch,
  onSaveAs,
  onRename,
}: {
  slots: WorkspaceSlot[];
  activeId: SlotId;
  onSwitch: (id: SlotId) => void;
  onSaveAs?: () => void;
  onRename?: (id: SlotId) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  // Close on outside click / Esc while open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: globalThis.MouseEvent) => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const active = slots.find((s) => s.id === activeId);
  const activeName = active?.name ?? t("editor.chrome.workspaceSwitcher.defaultName");

  return (
    <div
      ref={ref}
      data-editor-chrome
      data-testid="editor.workspace-switcher"
      style={{ position: "relative", display: "flex", alignItems: "center" }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("editor.chrome.workspaceSwitcher.switchLabel")}
        data-testid="editor.workspace-switcher.toggle"
        title={t("editor.chrome.workspaceSwitcher.toggleTitle", {
          name: activeName,
        })}
        {...hoverSurface()}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-1)",
          maxWidth: 160,
          padding: "2px 8px",
          background: "transparent",
          border: 0,
          borderRadius: "var(--radius-1)",
          color: "var(--fg-3)",
          cursor: "pointer",
          fontFamily: "var(--font-sans)",
          fontSize: 12,
          fontWeight: "var(--weight-medium)",
          transition: HOVER_TRANSITION,
        }}
      >
        <Icon name="layout-grid" size={12} />
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {activeName}
        </span>
        <Icon name="chevron-up" size={12} />
      </button>
      {open && (
        <div
          role="menu"
          data-testid="editor.workspace-switcher.menu"
          style={{
            position: "absolute",
            bottom: "calc(100% + 4px)",
            insetInlineEnd: 0,
            minWidth: 200,
            maxHeight: 320,
            overflowY: "auto",
            background: "var(--bg-1)",
            border: "1px solid var(--line-1)",
            borderRadius: "var(--radius-2)",
            boxShadow: "var(--shadow-3, 0 8px 24px rgba(0,0,0,0.12))",
            padding: "var(--space-1)",
            zIndex: 60,
          }}
        >
          {slots.map((s) => {
            const isActive = s.id === activeId;
            return (
              <div
                key={s.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  borderRadius: "var(--radius-1)",
                  background: isActive ? "var(--paper-2)" : "transparent",
                }}
              >
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={isActive}
                  data-testid="editor.workspace-switcher.item"
                  data-workspace-id={s.id}
                  data-active={isActive ? "true" : "false"}
                  onClick={() => {
                    if (!isActive) onSwitch(s.id);
                    setOpen(false);
                  }}
                  {...hoverSurface({
                    restBg: isActive ? "var(--paper-2)" : "transparent",
                    hoverBg: isActive ? "var(--paper-2)" : "var(--bg-3)",
                  })}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    textAlign: "start",
                    padding: "6px 8px",
                    background: "transparent",
                    border: 0,
                    borderRadius: "var(--radius-1)",
                    color: "var(--fg-1)",
                    cursor: "pointer",
                    fontFamily: "var(--font-sans)",
                    fontSize: 12,
                    transition: HOVER_TRANSITION,
                  }}
                >
                  <span style={{ width: 14, flexShrink: 0, color: "var(--fg-3)" }}>
                    {isActive ? <Icon name="check" size={12} /> : null}
                  </span>
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {s.name}
                  </span>
                </button>
                {onRename !== undefined && (
                  <button
                    type="button"
                    aria-label={t("editor.chrome.workspaceSwitcher.renameItemLabel", {
                      name: s.name,
                    })}
                    data-testid="editor.workspace-switcher.rename"
                    data-workspace-id={s.id}
                    title={t("editor.chrome.workspaceSwitcher.renameTitle")}
                    onClick={() => {
                      setOpen(false);
                      onRename(s.id);
                    }}
                    {...hoverSurface()}
                    style={{
                      flexShrink: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      padding: "4px 8px",
                      background: "transparent",
                      border: 0,
                      borderRadius: "var(--radius-1)",
                      color: "var(--fg-3)",
                      cursor: "pointer",
                      transition: HOVER_TRANSITION,
                    }}
                  >
                    <Icon name="pencil" size={12} />
                  </button>
                )}
              </div>
            );
          })}
          {onSaveAs !== undefined && (
            <>
              <div
                style={{
                  height: 1,
                  margin: "4px 0",
                  background: "var(--line-1)",
                }}
              />
              <button
                type="button"
                role="menuitem"
                data-testid="editor.workspace-switcher.save-as"
                onClick={() => {
                  setOpen(false);
                  onSaveAs();
                }}
                {...hoverSurface()}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  width: "100%",
                  textAlign: "start",
                  padding: "6px 8px",
                  background: "transparent",
                  border: 0,
                  borderRadius: "var(--radius-1)",
                  color: "var(--fg-2)",
                  cursor: "pointer",
                  fontFamily: "var(--font-sans)",
                  fontSize: 12,
                  transition: HOVER_TRANSITION,
                }}
              >
                <span style={{ width: 14, flexShrink: 0, color: "var(--fg-3)" }}>
                  <Icon name="plus" size={12} />
                </span>
                <span>{t("editor.chrome.workspaceSwitcher.saveCurrentAs")}</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
