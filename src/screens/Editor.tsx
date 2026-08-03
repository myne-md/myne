// Terminal post-vault-creation screen — empty shell.
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
// not threaded through to App-level — it becomes a vault-unlock
// concern when that feature lands). The status-bar word counter is
// live (MYND-143): it counts the active note's body words, frontmatter
// excluded, on a short debounce.
//
// References:
//   - PRD: myne-agents/features/empty-editor-shell/prd.md
//   - Design session: myne-agents/sessions/design/2026-04-28-empty-editor-shell.md
//   - Mockup (structural reference only, NOT copied):
//     docs/design/ui_kits/desktop/Editor.jsx

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
import { CommandPalette } from "../components/CommandPalette";
import type { CommandContext } from "../commands";
import { useKeybindDispatcher } from "../commands/useKeybindDispatcher";
import { useConflictMaterializer } from "../hooks/useConflictMaterializer";
import type { KeybindEntry } from "../commands/keybindEngine";
import { catalogDefaults } from "../commands/bindableCatalog";
import { asViewMode, type ViewMode } from "../editor/view-mode";
import { VIM_MODE_EVENT, type VimModeEventDetail } from "../editor/vim";
import { CLOSE_ACTIVE_TAB_EVENT } from "../notes/closeActiveTabSignal";
import { installTaskChipEditor } from "@myne/editor/decorations/task-chip-listener";
import { focusKindOf } from "../commands/scope";
import { FailClosedError } from "../components/FailClosedError";
import { StorageLost } from "./StorageLost";
import { DeviceRevoked } from "./DeviceRevoked";
import { useSyncStatus } from "../hooks/useSyncStatus";
import { has } from "../platform/capabilities";
import { deleteVault } from "../lib/vault-delete";
import { activeVaultId } from "../lib/vault-list";
import { useUnsyncedEdits } from "../hooks/useUnsyncedEdits";
import { useStorageHealth } from "../hooks/useStorageHealth";
import { SyncBanners } from "../components/sync/SyncBanners";
import { Icon } from "../components/primitives/Icon";
import { Tooltip } from "../components/primitives/Tooltip";
import {
  hoverSurface,
  HOVER_TRANSITION,
} from "../components/primitives/hoverSurface";
import { SettingsModal } from "../components/SettingsModal";
import { TemplatesManager } from "../components/TemplatesManager";
import { ThemeInstallDialog } from "../components/ThemeInstallDialog";
import { Spinner } from "../components/Spinner";
import { SnapshotsPanel } from "../notes/components/SnapshotsPanel";
import { SnapshotFailedIndicator } from "../notes/components/SnapshotFailedIndicator";
import { AiHydrationProbe } from "../notes/components/AiHydrationProbe";
import { NewNoteFromTemplateModal } from "../components/NewNoteFromTemplateModal";
import { Toast, type ToastAction, type ToastVariant } from "../components/Toast";
import { Toaster } from "../components/toast/Toaster";
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
import type { StageVaultStatus, SuspicionReason, VaultId } from "../lib/stage";
import {
  noteList,
  loadNoteBatch,
  createNoteFromTemplate,
  createBlankNamedNote,
  resolveTodayNote,
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
import { NoteTasksPanel } from "../notes/components/TasksPane";
import { TASK_WRITE_EVENT } from "../notes/toggleTask";
import { CLI_NOTES_CHANGED_EVENT } from "../lib/cli-access";
import { clearAiOutput } from "../notes/ai/aiOutputStore";
import { clearChat, stopChatTurn } from "../notes/ai/chatStore";
import { runSummarizeToChat } from "../notes/ai/aiToChat";
import { appendSummaryBlock, SUMMARIZE_BUDGET_CHARS } from "../notes/ai/summarize";
import { infer as aiInfer, computeRewrite } from "../lib/writing-assistant";
import { sendChat, stopChat } from "../lib/ai-chat";
import { isNoteAiExcluded } from "../lib/aiExcludedFolders";
import { getActiveEditorView } from "../editor/active-view";
import { BacklinksTab } from "../notes/components/BacklinksTab";
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
import { sidebarCommands } from "../notes/sidebarCommands";
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
import { useReminderScheduler } from "../hooks/useReminderScheduler";
import { createInAppNotifier } from "../lib/reminderNotifier";
import { useLiveVaultTasks } from "../notes/taskIndex";
import i18n from "../i18n";
import { useIdleAutoLock } from "../hooks/useIdleAutoLock";
import { runFlushChain } from "../lib/flush-chain";
import {
  ContextMenu,
  type ContextMenuItem,
} from "../notes/components/ContextMenu";
import {
  HAS_OVERLAY_WINDOW_CONTROLS,
  TRAFFIC_LIGHT_GAP,
  dragRegionProps,
} from "./titlebar";
import { useIsFullscreen } from "../hooks/useIsFullscreen";
import { LEFT_BOUNDS, RIGHT_BOUNDS } from "./layoutClamp";
import { useResponsiveCollapse } from "./responsiveCollapse";
import { AttachmentsLibrary } from "../components/attachments/AttachmentsLibrary";
import { REVEAL_ATTACHMENT_EVENT } from "../editor/attachments/fileCardActions";
import { CenterViewProvider, type CenterView } from "./centerView";
import { WorkspaceProvider, useWorkspace } from "../notes/workspaceContext";
import { ClipDispatchListener } from "../clip/ClipDispatchListener";
import { PaneTree } from "../notes/components/PaneTree";
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

// Lazy-loaded so the tag-browser modal chunk stays out of the editor's initial
// bundle (tag-system #2 / MYND-46, task-1 criterion — confirmed as a separate
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
 * so the blob's mtime stays a coarse (≤ ~5 min) signal — the SYNC-6 mtime-defense
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

const BAR_ITEMS: ReadonlyArray<{ id: string; labelKey: string }> = [
  { id: "save-status", labelKey: "editor.chrome.barItems.saveStatus" },
  { id: "view-mode", labelKey: "editor.chrome.barItems.viewMode" },
  { id: "workspace", labelKey: "editor.chrome.barItems.workspace" },
  { id: "tags", labelKey: "editor.chrome.barItems.tags" },
  { id: "views", labelKey: "editor.chrome.barItems.views" },
  { id: "graph", labelKey: "editor.chrome.barItems.graph" },
  { id: "settings", labelKey: "editor.chrome.barItems.settings" },
  { id: "lock", labelKey: "editor.chrome.barItems.lock" },
  { id: "vim-mode", labelKey: "editor.chrome.barItems.vimMode" },
  { id: "word-count", labelKey: "editor.chrome.barItems.wordCount" },
];

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
 * non-sensitive UI boolean — a per-vault `vault.prefs` flag is a possible future
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
   * editor), where no WebView-side id exists yet — the component resolves the
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
   * The vault stays Unlocked — restore never touches the slot map.
   */
  onRestoreBackup: () => void;
  /**
   * Callback invoked when the user clicks the Lock affordance in the
   * editor's bottom bar. The parent (App.tsx) dispatches the
   * `editor.lock` Stage transition → `unlock(Exists)` (no intermediate
   * "locked" screen — the user lands directly on the password form).
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
   * "Create another" affordance). Optional — omitted → the footer is hidden
   * alongside the switcher (single-vault / pre-task-5 state).
   */
  onCreateAnother?: () => void;
  /**
   * Open the device-join modal from the switcher dropdown's "Add this device to
   * an account" footer (myne#221). App.tsx tears this vault down first — flush +
   * `vault_lock()` + `editor.lock` — and opens the modal it mounts globally over
   * the resulting unlock screen, because `sync_join_account` unlocks a DIFFERENT
   * vault and SYNC-1 zeroizes this one on the way.
   *
   * Optional and capability-gated by App.tsx: a client that holds one container
   * per origin cannot bootstrap a second vault, and an unavailable affordance is
   * omitted rather than disabled. Absence hides that one row, not the switcher —
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
}: EditorProps) {
  const [slotPopulated, setSlotPopulated] = useState<boolean | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<EditorToast | null>(null);

  // #250 — the authoritative active-vault id for every vault-targeting surface
  // below. Prefer the id the stage already carries; fall back to the runtime
  // slot ONLY where the stage has none (post-reload editor entry). The old
  // answer, `resolveActiveVaultId()`, ordered the non-authoritative
  // `registry.json` cache — which only the password path ever stamped, so a
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
        // IPC error itself is treated as invalid state — fail-closed
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
  // survives the loss — the editor body unmounts, and with it any memory of what
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
  // the rebindable `app.open-settings` command (#184 track D) — a WorkspaceHotkeys
  // entry wired to `setSettingsOpen`, no longer a hardcoded window listener here.

  if (slotPopulated === null) {
    // Loading shim — the IPC takes microseconds (single RwLock read);
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
          // Lock first, then erase — the desktop ordering, and for the same
          // reason: keys must be gone before the bytes they could still read
          // are, so a failure part-way never leaves an unlocked session over a
          // half-erased container.
          await lockVault().catch(() => {});
          // ONE erase (task 72), not a second implementation. The target is
          // required since #250 — a lock has already emptied the slot, so the
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
            // fatal — the boot probe re-routes regardless, and a browser that
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
            // — safe to call regardless of whether the slot is
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
      {/* display:contents marker — the E2E suites' "editor mounted"
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
 * Inner editor body — mounts inside `<SidebarStateProvider>` so it can
 * use `useSelectedNote()`. Owns the loaded-body state, the autosave
 * hook, Tauri close-intercept (T28), editor-blur listener (T29), and
 * the BottomBar's save-status / Lock-flush wiring.
 */
/** The Editor's single bottom-right toast: a message plus an optional
 *  inline action (the export flow's "Show in folder", MYND-116 task 4 —
 *  the soft-trash Undo precedent lives in NoteList's own toast). */
type EditorToast = {
  message: string;
  action?: ToastAction;
  variant?: ToastVariant;
};

type EditorChromeProps = {
  /** The resolved active vault id (#250) — `null` while still resolving. Feeds
   *  the backup scheduler and the Settings panels that target a vault. */
  vaultId: string | null;
  onLock?: () => void;
  onForceRelock?: (status: StageVaultStatus, reason?: SuspicionReason) => void;
  onDeleteVaultSuccess: () => void;
  onSwitchVault?: (targetVaultId: VaultId) => void;
  onCreateAnother?: () => void;
  onJoinDevice?: () => void;
  switching: boolean;
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
  settingsOpen,
  onRestoreBackup,
  setSettingsOpen,
  toast,
  setToast,
}: EditorChromeProps) {
  const { t } = useTranslation();
  const ctx = useSelectedNote();
  const ws = useWorkspace();
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
   *  explicitly — the export modal's Copy fires for the note the pre-flight is
   *  about, which the sidebar context-menu path raises for a note that is not
   *  necessarily open (the ne4 defect: falling back to `ctx.selectedId` copied
   *  nothing when nothing was open). A clipboard write has no visible result,
   *  so success MUST toast — otherwise the button reads as broken — and so must
   *  failure, or the user pastes stale content believing it worked. */
  const copyNoteMarkdownById = useCallback(
    async (id: string) => {
      try {
        const { copyNoteMarkdown } = await import("../notes/copyNoteMarkdown");
        await copyNoteMarkdown(id);
        setToast({ message: i18n.t("export.note.modal.copied"), variant: "success" });
      } catch {
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
  // context-menu and palette paths — both receive the same hooks.
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
  // PDF pre-export exclusion notice (MYND-255 task 5) — same promise-
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
  // 98) — same promise-backed pattern again. Reached only where `nativeSaveAs`
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
  const [templatesOpen, setTemplatesOpen] = useState<boolean>(false);
  // Backup-export modal (MYND-56 task 1).
  const [backupExportOpen, setBackupExportOpen] = useState<boolean>(false);
  // Whole-vault markdown export modal (MYND-211 task 3) — same Editor-local
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
  // MYND-53 — Obsidian importer: the active-import modal + the onboarding offer
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
      // Best-effort — if persistence fails the worst case is the offer reappears.
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
          /* sidebar stays as-is until the next refresh — non-fatal */
        });
    },
    [ctx, showToastMessage, t],
  );

  // Cmd/Ctrl+Shift+G opens the whole-vault graph tab (MYND-198, SYNC-7) — the
  // third entry point alongside the command-palette action + BottomBar button.
  // Now the rebindable `graph.show` command routed through the keybind engine
  // (#184 track D), a WorkspaceHotkeys entry → `ws.openGraph()`; no longer a
  // hardcoded window listener here.
  // Editor `#tag` chip click (tag-system #3 / MYND-45): the chip decoration
  // dispatches a bubbling `myne-open-tag` event; open the tag browser seeded to
  // that tag. A single Editor-level listener (the modal is Editor-global) — no
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
  // `reloadOpenNote` is the existing blanket bump used after a sync pull — each
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
  // above, and for the same reason — no per-pane prop threading.
  //
  // Because the chips never open on caret entry, this listener is the ONLY way
  // to edit these values in live mode. It is therefore load-bearing rather than
  // convenience wiring: without it the chips render and do nothing. The listener
  // itself lives in the shared editor package so desktop and mobile install the
  // SAME implementation (`installTaskChipEditor`) rather than two copies.
  useEffect(() => installTaskChipEditor(), []);
  const [newFromTemplateOpen, setNewFromTemplateOpen] = useState<boolean>(false);
  // Bottom-bar readout (save status + word count) — reported up by
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
  const [centerView, setCenterView] = useState<CenterView>("editor");

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
  // sidebar's live/trashed set, so it needs `<SidebarStateProvider>` — which is
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
  // is due — the task surfaces say which.
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

  // MYND-192 — transient responsive auto-collapse. When the window gets too
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
  const leftCollapsed =
    layout.leftCollapsed || forced.forceLeftCollapsed || focusActive;
  const rightCollapsed =
    layout.rightCollapsed || forced.forceRightCollapsed || focusActive;
  // macOS floats the traffic lights over the top-left, so windowed builds inset
  // the sidebar toggle past them. In fullscreen the traffic lights are hidden —
  // drop that gap so the toggle sits flush-left (matching the non-mac layout).
  const isFullscreen = useIsFullscreen();
  const leftToggleX =
    HAS_OVERLAY_WINDOW_CONTROLS && !isFullscreen ? TRAFFIC_LIGHT_GAP + 16 : 12;
  const leftClearance = leftToggleX + LEFT_CONTROLS_WIDTH + 8;

  // Reveal the Saved Views surface (MYND-274) — the "Views" section lives in the
  // left (notes) sidebar, so revealing it ensures that sidebar is expanded, then
  // nudges the section to scroll into view + briefly highlight so the click
  // always lands somewhere visible (even when the sidebar was already open). A
  // width-forced collapse can't be toggled away (MYND-192) and the section would
  // be unmounted, so there is nothing to reveal — bail without firing the signal.
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
  // which is `inert` while collapsed — including focus mode — so the actions
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
  // single `.base` file (no new capability — dialog:allow-open already granted),
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
    if (picked === null) return; // cancelled — no toast
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
        // Count-only (SYNC-12) — never surface the failed view's name in copy.
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
  // (from ANY source — row click, keyboard nav, command palette, favorites,
  // jump-from-attachment) closes the Attachments view and returns the center
  // pane to that note's editor. Keying on `selectedId` makes the swap general:
  // opening Attachments does NOT change `selectedId`, so this never fires when
  // the user enters the library; it fires only when the selection genuinely
  // changes. The sidebar's Attachments entry and a note row are therefore
  // mutually exclusive in the active highlight — opening one deactivates the
  // other. Skips the initial mount so a fresh editor doesn't redundantly
  // re-assert "editor" (it already starts there).
  const selectionInitRef = useRef(true);
  useEffect(() => {
    if (selectionInitRef.current) {
      selectionInitRef.current = false;
      return;
    }
    setCenterView("editor");
  }, [ctx.selectedId]);

  // MYND-173: the generic file-card's "Reveal in library" action fires a window
  // event (the card lives in a CM6 widget, outside React). Open the attachments
  // library in response. Select-by-id within the library is deferred (PRD open
  // question) — this opens the library unfocused, which is the sanctioned
  // first-cut fallback.
  useEffect(() => {
    const onReveal = () => setCenterView("attachments");
    window.addEventListener(REVEAL_ATTACHMENT_EVENT, onReveal);
    return () => window.removeEventListener(REVEAL_ATTACHMENT_EVENT, onReveal);
  }, []);

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
  // loss — the overwriting save coalesces with the pane's earlier ones, so the
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
  // emits `PREFS_SYNC_APPLIED_EVENT` (never for the user's own IPC writes —
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

  // MYND-166 selection bridges — two one-way syncs that never loop
  // (A only fires for a note open in NO pane; B only mirrors):
  //  A) a selection arriving via a non-pane path (a freshly-created note,
  //     the command palette, a backlink / template / today-note open, the
  //     post-delete adjacent pick) is opened into the focused pane.
  //  B) the focused pane's active note is mirrored back into `selectedId`
  //     so the sidebar highlight / rename / F2 + the right-sidebar backlinks
  //     keep tracking the focused pane.
  const { openInFocused } = ws;
  const selectedId = ctx.selectedId;
  useEffect(() => {
    if (selectedId === null) return;
    const where = findItemPane(
      { root: ws.root, focusedPaneId: ws.focusedPaneId },
      { kind: "note", id: selectedId },
    );
    if (where === null) openInFocused(selectedId);
    // `ws.root` is read at fire time; the effect triggers only on a real
    // selection change, never per-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, openInFocused]);

  const focusedActive = ws.focusedLeaf.activeTab;
  // reading-source-modes (MYND-299): the focused note tab's effective view mode
  // for the BottomBar switcher — the tab's own mode, else the default pref, else
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
  // is still visible with the sidebar collapsed — which is the layout a user
  // writing at length is most likely to be in.
  const { unsyncedIds: unsyncedNoteIds, credentialPending } = useUnsyncedEdits();
  const focusedNoteUnsynced =
    focusedActiveNoteId !== null && unsyncedNoteIds.has(focusedActiveNoteId);
  const select = ctx.select;
  useEffect(() => {
    select(focusedActiveNoteId);
  }, [focusedActiveNoteId, select]);

  // MYND-121 — report window-level activity to the backend auto-lock idle
  // timer. The Editor is mounted iff the vault is Unlocked, so the heartbeat
  // runs exactly while a lockable session is live.
  useActivityHeartbeat();

  // MYND-351 — automatic local-backup scheduler (Model A: runs only while the
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
  // re-sync (rename / snapshot restore) — so the chrome only orchestrates
  // the cross-pane flush.
  const flushAll = ws.flushAll;

  // MYND-166 / MYND-308 — restore the persisted workspace CONTAINER ONCE on
  // mount (unlock). A missing / unreadable / malformed descriptor leaves the
  // default single empty pane (spec § 9.7.4). Runs after the slot guard, so the
  // backend read is Slot::Unlocked-gated. The descriptor is the MYW1 0x02
  // `{slots, activeId}` container (a legacy single descriptor is migrated to a
  // Default slot by `deserializeWorkspaces`); the active slot to restore comes
  // from the MYP1 `active_workspace` pref via `resolveActiveSlot` (the
  // consistency fallback to the first slot when the pointer is stale/missing).
  const restoreContainer = ws.restoreContainer;
  const restoredRef = useRef(false);
  // MYND-462 — set when the "Default file to open" preference is "empty" or
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
        // MYND-462 — read the "Default file to open" preference first; it decides
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
          // pane. The blob is NOT cleared — the staging guard below stops a quit
          // from overwriting it, so toggling back to "Last opened" restores it.
          nonDefaultStartupRef.current = true;
          return;
        }

        if (startupMode === "specific" && startupNote) {
          // Open just the chosen note in a fresh single-slot workspace (the same
          // shape `seedWelcomeNote` produces). A deleted / unreadable note simply
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
      } catch {
        // Read failure → keep the default workspace (best-effort restore).
      } finally {
        setRestoreSettled(true);
      }
    })();
  }, [restoreContainer]);

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
  // MYND-308 — set by the staging effect on any container change; the coalesced
  // flush timer (and a graceful-exit save) clears it after a successful write.
  const workspaceDirtyRef = useRef(false);
  // Timestamp (ms) of the last actual blob flush — the coalescing reference.
  // `null` ≡ never flushed → flush as soon as dirty.
  const lastFlushAtMsRef = useRef<number | null>(null);
  // Persist the workspace container + the MYP1 active pointer (graceful-exit /
  // coalesced — never on every switch, so the blob mtime stays a low-resolution
  // signal). Writes the descriptor first, then the active-slot pointer.
  const persistWorkspace = useCallback(async () => {
    try {
      await workspaceWrite(descriptorRef.current);
      await setActiveWorkspace(activeWorkspaceIdRef.current);
      // Graceful-exit save counts as a flush — reset the coalescing window so
      // the timer doesn't redundantly re-write moments later.
      lastFlushAtMsRef.current = Date.now();
      workspaceDirtyRef.current = false;
    } catch {
      // Best-effort — a failed convenience write never blocks lock/close.
    }
  }, []);
  // MYND-271 Task 8 — persist the VaultIndices to the encrypted vault.indices
  // (MYI1) blob on graceful exit (same cadence as the workspace descriptor:
  // lock / idle-lock grace / quit, never per-edit). Best-effort + must run
  // while still unlocked (before vault_lock zeroizes the keys); the next
  // unlock rebuilds the missing delta if this is skipped.
  const persistVaultIndices = useCallback(async () => {
    try {
      await vaultIndicesPersist();
    } catch {
      // Best-effort — a failed index persist never blocks lock/close.
    }
  }, []);

  // MYND-166 / MYND-308 — mirror the current container into the backend's
  // in-RAM staging slot on every change (incl. the restored/default state on
  // mount). The backend flushes it to vault.workspace on `ExitRequested`, so an
  // app QUIT (Cmd+Q / app-menu Quit) persists the layout even though it never
  // fires the window's `onCloseRequested`. Staging is RAM-only — it never writes
  // the blob, so its mtime stays a low-resolution lock/quit signal. The whole
  // `{slots, activeId}` container is staged (so a slot save / switch survives a
  // quit), and the staged change marks the coalesced-flush path dirty.
  useEffect(() => {
    if (!restoreSettled) return; // don't stage the pre-restore default layout
    // MYND-462 — for a non-default startup ("empty" / "specific") the layout we
    // mounted is NOT the saved workspace, so skip the FIRST staging pass (which
    // would overwrite the saved blob on quit), then clear the guard so genuine
    // user layout edits this session still stage + persist as usual.
    if (nonDefaultStartupRef.current) {
      nonDefaultStartupRef.current = false;
      return;
    }
    workspaceDirtyRef.current = true;
    void workspaceStage(serializeWorkspaces(ws.workspacesSnapshot())).catch(() => {
      // Best-effort; outside Tauri (browser dev shim) the invoke rejects.
    });
    // `slots` identity changes on save-as/switch/rename/delete; `root` /
    // `focusedPaneId` change on every layout edit of the active slot.
    // `expandedFolders` (MYND-455) is its OWN dep: the container ops spread
    // `{...c}`, which preserves `slots`/`activeId` identity, so a sidebar
    // folder toggle would otherwise never mark the blob dirty — and a Cmd+Q
    // would flush the stale staged container and lose the expand set.
    // `graphSettings` (graph-connection-ux-polish task 5) is the same shape of
    // dep for the same reason: a graph-panel toggle only changes that one
    // field on the spread container.
  }, [
    restoreSettled,
    ws.slots,
    ws.activeWorkspaceId,
    ws.root,
    ws.focusedPaneId,
    ws.expandedFolders,
    ws.graphSettings,
  ]);

  // MYND-308 (SYNC-6, mtime-defense) — coalesced background flush. The
  // graceful-exit save (lock / close / quit / switch-vault) is the always-flush
  // path; this adds a periodic flush so a CRASH loses ≤ ~5 min of layout work.
  // A ~30 s interval polls the pure `shouldFlushWorkspace` decision against the
  // dirty flag + the last-flush timestamp (≤ once per `WORKSPACE_FLUSH_INTERVAL_MS`
  // = 5 min). NEVER a per-switch file write — switches only set `dirty`, the
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

  // T28 — Tauri close-intercept. Block window close until pending saves
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
          await flushAll();
          await persistWorkspace();
          await persistVaultIndices();
          await flushGraphLayoutNow();
          // `destroy()`, NOT `close()`: the capability ACL grants
          // `core:window:allow-destroy` but deliberately NOT `allow-close`
          // (TB6 surface — see lib/app-window.ts). `close()` rejects under the
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
        // AFTER cleanup ran and is never removed — a leak that follows onto
        // later screens. Its mere presence makes Tauri `prevent_close()` the
        // native title-bar X (manager/window.rs `has_js_listener`), so on
        // Windows — where the X is the only quit affordance — the app can wedge
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
  }, [flushAll, persistWorkspace, persistVaultIndices]);

  // Web graceful exit (MYND-574 task 93). The Tauri close-intercept above is a
  // no-op in a browser — its own catch says so — which meant every tab close
  // silently dropped the newest edit, the workspace descriptor, the vault
  // indices and the graph layout. On the one client where an unsynced edit is
  // all that stands between the user and real loss.
  //
  // Additive rather than a rewrite of the effect above: that path has E2E
  // coverage this task must not disturb, and on desktop this seam is a no-op, so
  // the two cannot both fire.
  //
  // The `kind` split is load-bearing. `pagehide` is a real exit — flush
  // everything. `hidden` is a tab switch that MAY become a discard, so content
  // is flushed (integrity) and `vault.workspace` deliberately is not: writing it
  // per visibility flip would turn its mtime into an editor-activity log, which
  // is exactly what `protocol.md` §9.7.4's graceful-exit-only rule forecloses
  // and what task 65 kept the web client to.
  useEffect(() => {
    return onExitIntent(async (kind) => {
      setUnsavedGuard("flushing", true);
      try {
        // Same chain, same ordering, one call — `kind` carries the ONE
        // difference (a hidden tab must not write `vault.workspace`, whose mtime
        // is a lock/quit signal), so the divergence is a named parameter rather
        // than two sequences that happen to differ by a line.
        await runFlushChain(
          {
            flushAll,
            persistWorkspace,
            persistVaultIndices,
            flushGraphLayout: flushGraphLayoutNow,
          },
          kind,
        );
      } finally {
        setUnsavedGuard("flushing", false);
      }
    });
  }, [flushAll, persistWorkspace, persistVaultIndices]);

  // Task 88 — the second, much longer-lived holder of the same guard.
  //
  // A password change is reported as complete only once the server acknowledges
  // the new `vault.meta`. Until then this browser expects the new password and
  // every other device still expects the old one, and clearing this browser's
  // copy loses the change: on web there is no recovery phrase, so the only other
  // remedy is a native client with the old password — which the user has just
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

  // MYND-121 — flush every pane on idle-lock imminent. The backend idle
  // timer emits `vault-lock-imminent` before its grace window; flush any
  // unsaved edit so the autosave deltas persist before the keys zeroize.
  // Best-effort — the backend proceeds when the grace elapses regardless.
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
            // second (convenience — droppable if the grace window expires).
            await flushAll();
            await persistWorkspace();
            await persistVaultIndices();
            await flushGraphLayoutNow();
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
  }, [flushAll, persistWorkspace, persistVaultIndices]);

  // Lock button flush-then-lock — `decisions.md` 2026-05-07 canonical
  // flush-on-lock, now across all panes; persist the workspace before lock.
  const handleLockFlushed = useCallback(async () => {
    // The chain is best-effort and CANNOT skip the lock (task 93). It used to be
    // a bare `await` sequence ending in `lockVault()`, so a rejection from any
    // writer skipped every step after it — including the lock. A transient write
    // failure did not merely lose a cache: it cancelled the auto-lock, leaving
    // the keys live in the Worker and the plaintext mounted, past the idle
    // deadline, with nothing said.
    await runFlushChain(
      {
        flushAll,
        persistWorkspace,
        persistVaultIndices,
        flushGraphLayout: flushGraphLayoutNow,
      },
      "lock",
    );
    await lockVault().catch(() => {
      /* lock is best-effort, parent callback still fires */
    });
    onLock?.();
  }, [flushAll, persistWorkspace, persistVaultIndices, onLock]);

  // Idle auto-lock where the platform has no OS-level idle detection — the web
  // client (phase3-web-client task 43). Desktop keeps `src-tauri/src/auto_lock.rs`
  // and this is inert there, so the two never race to lock the same vault.
  //
  // It reuses the Lock button's own handler rather than calling `lockVault`
  // directly: locking has to flush first, and a second lock path that skipped
  // the flush would lose the last edits of exactly the session the user walked
  // away from.
  useIdleAutoLock({
    timeoutSecs: barPrefs.auto_lock_seconds ?? 0,
    onIdle: () => void handleLockFlushed(),
  });

  // named-workspaces (MYND-308) — palette command handlers. The BottomBar
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
  // Rename a SPECIFIC slot (the per-row pencil in the bottom-bar switcher) — vs
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

  const centerViewValue = useMemo(
    () => ({ view: centerView, setView: setCenterView }),
    [centerView],
  );

  return (
    <CenterViewProvider value={centerViewValue}>
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
          visible until then. No confirm-discard dialog — the flush is
          automatic. */}
      {switching && <SwitchingOverlay />}
      {/* Sync banners (MYND-426 reconcile / MYND-427 integrity), above the
          three-pane row. Non-blocking + dismissable; renders nothing while sync
          is off (the common case). */}
      <SyncBanners />
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
        <SidebarBootstrap />
        {/* Always mounted (even when collapsed) so the width collapse/expand
            animates instead of popping — SidebarPane drives the width 0↔open
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
                  background: "var(--paper-2)",
                  borderInlineEnd: "1px solid var(--line-1)",
                }}
              />
              <SidebarVaultSwitcher
                onSwitchVault={onSwitchVault}
                onCreateAnother={onCreateAnother}
                onJoinDevice={onJoinDevice}
                switching={switching}
              />
              <NotesSidebarList
                onNewFromTemplate={() => setNewFromTemplateOpen(true)}
                exportHooks={exportHooks}
              />
            </div>
        </SidebarPane>
        {centerView === "attachments" ? (
          // Attachments is a full-center view with no tab strip; give it a
          // matching drag-region clearance row so its toolbar clears the
          // floated toggles + traffic lights.
          <div
            style={{
              flex: 1,
              minWidth: 0,
              // Allow this column to shrink below content height so the nested
              // AttachmentsLibrary scroll area is bounded (flexbox min-height
              // trap — the strip is fixed, the library fills + scrolls).
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              {...dragRegionProps()}
              style={{
                height: STRIP_HEIGHT,
                flexShrink: 0,
                background: "var(--paper-2)",
                borderBottom: "1px solid var(--line-1)",
                display: "flex",
                alignItems: "center",
                // Clear the floated left toggle + traffic lights when the left
                // sidebar is collapsed (they float over this pane's top-left).
                paddingInlineStart: leftCollapsed ? leftClearance : "var(--space-4)",
                paddingInlineEnd: "var(--space-4)",
              }}
            >
              {/* The Attachments title rides the top clearance/tab-strip row so
                  it reads as the surface's header, with the row's border between
                  it and the toolbar below. */}
              <span
                style={{
                  fontFamily: "var(--font-sans)",
                  fontSize: 15,
                  fontWeight: 600,
                  color: "var(--fg-1)",
                }}
              >
                {t("attachments.library.title")}
              </span>
            </div>
            <AttachmentsLibrary onClose={() => setCenterView("editor")} />
          </div>
        ) : (
          <PaneTree
            node={ws.root}
            focusedPaneId={ws.focusedPaneId}
            onReadout={onReadout}
            leftInset={leftCollapsed ? leftClearance : 0}
            rightInset={rightCollapsed ? RIGHT_CLEARANCE : 0}
          />
        )}
        {centerView !== "attachments" && (
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
            <RightSidebar />
          </SidebarPane>
        )}
      </div>
      {/* Sidebar toggles, floated into the editor's top corners (the title-bar
          row), level with the macOS traffic lights. Faded in focus mode. */}
      <div
        data-editor-chrome
        style={{
          position: "absolute",
          top: 6,
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
          toggle only shows while a note is actually open — not on the new-tab
          chooser or the attachments view. Mirror PaneView's `inNewTabState`
          (`pendingNewTab || activeTab === null`) for the FOCUSED pane, so an open
          "+ New tab" over existing tabs still hides it. */}
      {centerView !== "attachments" &&
        ws.focusedLeaf.activeTab !== null &&
        ws.pendingNewTabPaneId !== ws.focusedPaneId && (
        <div
          style={{
            position: "absolute",
            top: 6,
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
        onOpenSettings={() => setSettingsOpen(true)}
        onShowGraph={() => ws.openGraph()}
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
          // checklist — the only path to restore a hidden item.
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
        onClose={() => setSettingsOpen(false)}
        onShowToast={showToastMessage}
        onForceRelock={onForceRelock}
        onDeleteVaultSuccess={onDeleteVaultSuccess}
        onImportObsidian={() => {
          // Keep Settings open BEHIND the importer (both are z-1000 modals and
          // the importer renders later in the DOM, so it layers on top). Closing
          // the importer returns to Settings rather than dumping to the editor
          // (#206 — "actions like import notes close off the settings pane").
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
        onShowToast={showToastMessage}
      />
      <VaultExportModal
        open={vaultExportOpen}
        onClose={() => setVaultExportOpen(false)}
        folders={vaultExportFolders}
      />
      {/* MYND-567: the `myne://theme/install` confirmation gate. Self-driving —
          it drains the deep-link latch on mount and listens for warm arrivals,
          so it needs no state from Editor. Mounted HERE (and only here) because
          Editor is the post-unlock stage: that is what holds a link arriving on
          a locked vault until the vault is open.

          `deferred` yields to the first-run importer offer. Both are focus-
          trapping modals at the same z-index, so showing them together would
          have the two traps fight over focus; the offer is the onboarding gate
          and wins. Deferring only delays — the request stays latched and the
          dialog opens as soon as the offer is dismissed. */}
      <ThemeInstallDialog deferred={offerOpen} />
      <TemplatesManager
        open={templatesOpen}
        onClose={() => setTemplatesOpen(false)}
        onOpenNote={(id) => {
          void ctx.open(id).catch(() => {
            /* selection failure surfaces via sidebar UX */
          });
        }}
      />
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
      <NewNoteFromTemplateModal
        open={newFromTemplateOpen}
        onClose={() => setNewFromTemplateOpen(false)}
        onManageTemplates={() => {
          setNewFromTemplateOpen(false);
          setTemplatesOpen(true);
        }}
        onBlankNote={() => {
          // Zero-templates degrade → the existing instant-blank path, unchanged.
          void ctx.createAndStartRename().catch(() => {});
        }}
        onCreateFromTemplate={(templateId, name) => {
          // Location-agnostic: lands at the root, where the header new-note
          // button's blank note would land (folder = null).
          void createNoteFromTemplate(templateId, name, null)
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
        centerView={centerView}
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
          setCenterView("attachments");
        }}
        onOpenSettings={() => {
          setPaletteOpen(false);
          setSettingsOpen(true);
        }}
        onManageTemplates={() => {
          setPaletteOpen(false);
          setTemplatesOpen(true);
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
          // Same shared flow as the sidebar context-menu item (MYND-116) —
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
          // PDF sibling (MYND-255) — same shared-flow discipline as the
          // markdown action above.
          setPaletteOpen(false);
          const id = ctx.selectedId;
          if (id === null) return;
          void runNotePdfExportFlow(
            noteExportOptions(id, ctx.cache.get(id)?.title ?? null, exportHooks),
          );
        }}
        onExportNoteHtml={() => {
          // HTML sibling (MYND-340) — same shared-flow discipline.
          setPaletteOpen(false);
          const id = ctx.selectedId;
          if (id === null) return;
          void runNoteHtmlExportFlow(
            noteExportOptions(id, ctx.cache.get(id)?.title ?? null, exportHooks),
          );
        }}
        onExportNoteTxt={() => {
          // Plain-text sibling (MYND-340) — same shared-flow discipline.
          setPaletteOpen(false);
          const id = ctx.selectedId;
          if (id === null) return;
          void runNoteTxtExportFlow(
            noteExportOptions(id, ctx.cache.get(id)?.title ?? null, exportHooks),
          );
        }}
        onShowGraph={() => {
          setPaletteOpen(false);
          ws.openGraph();
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
          // MYND-192 — a width-forced collapse can't be toggled away (and
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
          TB10). Mounted here — inside the workspace providers — so the success
          notice's "view" affordance opens the newly-clipped note via the
          workspace note-open. */}
      <ClipDispatchListener
        onViewNote={(id) => {
          void ctx.open(id as NoteId).catch(() => {
            /* note-open failure surfaces via sidebar UX */
          });
        }}
        onNoteCreated={() => {
          // A clip sealed a new note — reload the sidebar so it appears live
          // (same note_list → refreshAll path the boot + "+ New Note" use).
          void noteList()
            .then((ids) => ctx.refreshAll(ids))
            .catch(() => {
              /* sidebar stays as-is until the next refresh — non-fatal */
            });
        }}
      />
      <WorkspaceHotkeys
        focusActive={focusActive}
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
          // the modal is ABOUT. It is captured from the pre-flight — NOT
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
        // soft-trash Undo precedent's 6 s window (NoteList.tsx) — 2.5 s is
        // not enough to read the message AND click the inline action.
        durationMs={toast?.action !== undefined ? 6000 : 2500}
        onDone={() => setToast(null)}
      />
      {/* The single toast surface (#238): renders every toast from the central
          store — this screen's, NoteList's, sync's, and the editor's imperative
          ones — as one shared collapsed stack. Mounted exactly once. */}
      <Toaster />
    </div>
    </CenterViewProvider>
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
  height: 26,
  flexShrink: 0,
  border: 0,
  borderRadius: "var(--radius-1)",
  background: "transparent",
  color: "var(--fg-3)",
  transition: HOVER_TRANSITION,
};

// Sidebar toggles float in the editor's top corners (the OS title-bar row),
// Obsidian-style — there is no separate top bar; each top pane's tab strip
// rises into that row. These constants place the toggles clear of the macOS
// traffic lights and size the clearance the underlying top surface (sidebar
// header or a corner pane's strip) must reserve so nothing collides.
// The left toggle x-offset + left clearance are computed PER-RENDER inside
// EditorChrome (`leftToggleX` / `leftClearance`) because they depend on the live
// fullscreen state (the traffic-light gap collapses in fullscreen).
/** Right toggle's x offset from the right edge. */
const RIGHT_TOGGLE_X = 8;
/** Full width of the top-left control cluster: the sidebar toggle plus the
 *  back + forward nav buttons (MYND-260), each preceded by a cluster gap. */
const LEFT_CONTROLS_WIDTH =
  TITLE_BAR_TOGGLE_WIDTH + 2 * (TITLE_BAR_CLUSTER_GAP + TITLE_BAR_NAV_WIDTH);
/** Right clearance: the top-right surface must keep its content before this.
 *  Reserves room for BOTH floated controls — the note-actions "…" menu plus the
 *  right-sidebar toggle beside it — so a collapsed-right pane's tab strip never
 *  slides under either. */
const RIGHT_CLEARANCE =
  RIGHT_TOGGLE_X + 2 * TITLE_BAR_TOGGLE_WIDTH + TITLE_BAR_CLUSTER_GAP + 8;

/**
 * The Notion-style workspace switcher row at the top of the left sidebar,
 * above the Notes list (MYND-166). Full-width chip — mark + vault name +
 * chevron — with a downward dropdown. Carries the sidebar's right + bottom
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
        // Sits below the traffic-light clearance row, so normal padding — no
        // bottom divider (it reads as a header above the Notes list directly).
        padding: "8px 8px 6px",
        background: "var(--paper-2)",
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
  /** MYND-192 — true when the sidebar is collapsed by a too-narrow window;
   *  the toggle is inert (can't expand into space that isn't there, and
   *  must not persist a manual flip the responsive override imposed). */
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const icon =
    side === "left"
      ? collapsed
        ? "panel-left"
        : "panel-left-close"
      : collapsed
        ? "panel-right"
        : "panel-right-close";
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
      <Icon name={icon} size={16} />
    </button>
  );
}

/**
 * Back / forward note-navigation button (MYND-260), sitting in the top-left
 * cluster immediately right of the left sidebar toggle. Browser-style: steps
 * the focused pane through the sequence of notes it has shown. Disabled
 * (greyed) when there is no history in that direction — matching the
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
  /** Re-open the palette — used to pop back from a QuickPicker sub-flow on
   *  cancel (Esc/backdrop), so the picker reads as stacked on top of the palette. */
  onReopen: () => void;
  /** Which surface the center pane shows — the note-actions "…" menu hides on
   *  the attachments view (it acts on the focused note, absent there). */
  centerView: CenterView;
  onOpenSettings: () => void;
  onOpenAttachments: () => void;
  onManageTemplates: () => void;
  onNewNoteFromTemplate: () => void;
  onOpenSnapshots: () => void;
  onExportNoteMarkdown: () => void;
  onExportNotePdf: () => void;
  onExportNoteHtml: () => void;
  onExportNoteTxt: () => void;
  onShowGraph: () => void;
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
  /** Show a toast (with an optional undo action) — the note-actions "…" menu's
   *  convert-to-template / convert-to-note items announce themselves through it. */
  setToast: Dispatch<SetStateAction<EditorToast | null>>;
};

function CommandPaletteHost({
  open,
  onClose,
  onReopen,
  centerView,
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
  onShowGraph,
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
  // palette is closed — so its cancel must NOT summon a palette the user never
  // opened. Set for that one invocation path; consumed on the next picker close.
  const suppressPaletteReopenRef = useRef(false);
  // Deferred empty-trash confirm (the palette `trash.empty` action): the
  // trashed count at request time, null when closed. A permanent purge never
  // fires straight from the palette — this renders the same count-aware
  // DeleteConfirmModal the TrashPanel footer uses, and only confirm purges.
  // Rendered as a sibling like `picker`, so it survives the palette closing.
  const [emptyTrashConfirm, setEmptyTrashConfirm] = useState<number | null>(null);
  // AI surface (local-ai epic, ai-ux-surface MYND-408, SYNC-9): the `ai_enabled`
  // gate + the AI Chat reveal, threaded into CommandContext so AI capability
  // actions (siblings 4/6/7) gate on `stageName === "editor" && aiEnabled` and
  // open the shared right-panel AI Chat tab.
  const { prefs: aiPrefs, setRightPanelActiveTab: revealRightPanelTab } = usePrefs();
  // Wave 2: layout/pane/tab/nav palette actions dispatch straight to the
  // workspace controller (CommandPaletteHost is inside WorkspaceProvider).
  const paletteWs = useWorkspace();
  // (The palette's real-time-sync toggle was dropped in the develop merge — the
  // sync engine now manages SSE as an always-on baseline with an info-only
  // Privacy row, so there is no user-toggleable pref to bind, `useSyncPrefs`
  // mock removed on develop.)
  // Drop the ephemeral AI render stores when the editor session tears down
  // (lock / vault-switch unmounts this host) — the AS1 artifacts (summary text +
  // the chat transcript) never outlive the open vault (SYNC-8;
  // conversational-ai-chat task 12: the chat transcript is RAM-only, wiped on
  // lock. Unlike the summary it is vault-scoped, so it is NOT cleared on a mere
  // note switch below — only here, on the vault teardown). Tag suggestions are
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
  // fire). Without this, note A's summary lingers — and could be inserted into
  // note B — after switching. Bumping the run epoch (inside the clear) also
  // drops any of A's in-flight runs so they never resolve onto B.
  useEffect(() => {
    clearAiOutput();
  }, [ctx.selectedId]);
  // "Open today's note" (MYND-191): idempotent open-or-create over the FULL note
  // set (authoritative note_list + loadNoteBatch, not the partial sidebar cache).
  // Found → open; not found → create (from the daily template if set, else a
  // blank note titled today's date, the eager-title specialization of #5) in the
  // daily folder, then open. Past days are reached via the ordinary sidebar
  // folder — no calendar.
  const onOpenTodayNote = useCallback(async () => {
    try {
      const prefs = await prefsRead();
      const ids = await noteList();
      const notes = await loadNoteBatch(ids);
      const res = resolveTodayNote(
        new Date(),
        prefs.daily_date_format,
        prefs.daily_folder,
        notes,
      );
      let id: NoteId;
      if (res.kind === "open") {
        id = res.id;
      } else if (prefs.daily_template) {
        // Daily template set → instantiate from it (date as eager title).
        id = (await createNoteFromTemplate(
          prefs.daily_template,
          res.dateTitle,
          res.folder,
        )) as NoteId;
      } else {
        // No daily template → a blank note titled with the date.
        id = (await createBlankNamedNote(res.dateTitle, res.folder)) as NoteId;
      }
      await ctx.open(id);
    } catch (err) {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn("[Editor] open today's note failed:", err);
      }
    }
  }, [ctx]);
  // "Open random note" (MYND-323): serendipitous review. Picks uniformly from the
  // live, non-template notes (mirrors sidebar visibility — trashed/templates are
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
      // Wave 2 — layout / panes / tabs / navigation, dispatched to the workspace.
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
      // Wave 3 — note ops (via the sidebar-state ctx) + right-panel tabs.
      onNewNote: () => void ctx.createAndStartRename().catch(() => {}),
      onDuplicateNote: () => {
        if (ctx.selectedId !== null) void ctx.duplicateAndOpen(ctx.selectedId).catch(() => {});
      },
      onArchiveNote: () => {
        if (ctx.selectedId !== null) void ctx.archiveWithRollback(ctx.selectedId).catch(() => {});
      },
      onRenameNote: () => {
        if (ctx.selectedId !== null) ctx.startRename(ctx.selectedId);
      },
      onTrashNote: () => {
        if (ctx.selectedId !== null) void ctx.trashWithRollback(ctx.selectedId).catch(() => {});
      },
      onEmptyTrash: () => {
        // Permanent purge — request the count-aware confirm instead of firing
        // directly (the TrashPanel footer's flow); the purge runs on confirm.
        const count = trashedRecords(ctx.cache).length;
        if (count > 0) setEmptyTrashConfirm(count);
      },
      onToggleFavorite: () => {
        if (ctx.selectedId === null) return;
        const id = ctx.selectedId;
        // #252: re-read disk truth, then toggle. `favorites` is a whole-sequence
        // write, so deriving `next` from THIS component's `usePrefs` snapshot
        // dropped every favourite starred from the sidebar since it last read —
        // and `favorites` is `SharedDiscipline::SequenceLww`, so the truncation
        // won on every other device. Reading first makes the write depend on
        // what is stored rather than on which surface rendered more recently.
        //
        // The read-modify-write lives in `toggleFavoriteOnDisk` so every
        // snapshot-holding surface gets the same treatment rather than each
        // re-deriving the sequence from whatever it last rendered.
        void toggleFavoriteOnDisk(id).catch(() => {
          // A failed read must not fall back to the stale snapshot — that is
          // the write this fix exists to prevent.
        });
      },
      onShowBacklinks: () => void revealRightPanelTab("backlinks"),
      onShowOutline: () => void revealRightPanelTab("outline"),
      onShowUnlinked: () => void revealRightPanelTab("unlinked"),
      onRestoreBackup,
      // Palette-gap #32 — move the selected note to a folder via the QuickPicker.
      // Targets are the vault's folders (from the sidebar cache) plus any empty
      // "deliberate" folders, sorted, with "Vault root" (empty id → null) first.
      onMoveNote: () => {
        if (ctx.selectedId === null) return;
        const noteId = ctx.selectedId;
        const folders = new Set<string>();
        for (const rec of ctx.cache.values()) {
          // Live, non-template notes only — a folder that survives solely on
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
      // Palette-gap #31 — apply a saved custom theme via the QuickPicker. Lists
      // the vault's custom themes (MYND-486: names from the vault.themes store —
      // every stored theme is valid); picking one reads its palette, persists it
      // as the active choice, and applies it live (the CustomThemesSection apply
      // path).
      onApplyCustomTheme: () => {
        void (async () => {
          // Each entry already carries its palette — MYND-486 makes the single
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
      // Summarize the focused note into the AI Chat tab (note-summarization
      // tasks 3–4): reveal the render target, grab the focused pane's live view
      // via the `getActiveEditorView` registry (the palette pattern), then drive
      // the tested `runSummarizeToStore` pipeline (resolve → truncate → blocking
      // `infer` → ephemeral render). Returns stub output until Candle.
      onSummarizeNote: () => {
        revealRightPanelTab("ai-chat");
        const view = getActiveEditorView();
        if (view === null) return;
        // SYNC-14 fail-closed: never summarize a note in an excluded folder, and
        // never run when the note's folder is unknown (no selection / not cached)
        // — an unknown folder must not default to root and slip past the gate.
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
      // Rewrite the current selection (writing-assistant `/yeniden-yaz` as a
      // palette action): resolve the selection span via the tested `computeRewrite`
      // core, then replace it in place as plain markdown (`ai.rewrite`, one undo
      // step). A no-op on an empty selection.
      onRewriteSelection: () => {
        const view = getActiveEditorView();
        if (view === null) return;
        // SYNC-14 fail-closed: never rewrite a note in an excluded folder, and
        // never when the folder is unknown (see onSummarizeNote).
        if (ctx.selectedId === null) return;
        const cached = ctx.cache.get(ctx.selectedId);
        if (cached === undefined) return;
        if (isNoteAiExcluded(cached.folder ?? "", aiPrefs.ai_excluded_folders)) return;
        // Snapshot the note + the immutable pre-inference state, so the
        // multi-second blocking infer cannot land a stale range onto a document
        // the user edited (or a different note they switched to) in the meantime.
        const noteAtStart = ctx.selectedId;
        const stateAtStart = view.state;
        void (async () => {
          const result = await computeRewrite({ state: stateAtStart, infer: aiInfer });
          if (result === null || result.text.length === 0) return;
          const original = stateAtStart.doc.sliceString(result.from, result.to);
          const now = getActiveEditorView();
          // Staleness guard: same view, same note, and the target range still
          // holds exactly the text we rewrote — otherwise drop the result rather
          // than corrupt the document with pre-inference offsets.
          if (now === null || now !== view || ctx.selectedId !== noteAtStart) return;
          if (result.to > now.state.doc.length) return;
          if (now.state.doc.sliceString(result.from, result.to) !== original) return;
          now.dispatch({
            changes: { from: result.from, to: result.to, insert: result.text },
            userEvent: "ai.rewrite",
          });
        })();
      },
      onLock: onLockFlushed,
      onOpenSettings,
      onManageTemplates,
      onNewNoteFromTemplate,
      onOpenTodayNote,
      onOpenRandomNote,
      onOpenAttachments,
      onOpenSnapshots,
      onExportNoteMarkdown,
      onExportNotePdf,
      onExportNoteHtml,
      onExportNoteTxt,
      onShowGraph,
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
      // `t` at run time — a language switch must rebuild them.
      t,
      onRestoreBackup,
      revealRightPanelTab,
      onLockFlushed,
      onOpenSettings,
      onManageTemplates,
      onNewNoteFromTemplate,
      onOpenTodayNote,
      onOpenRandomNote,
      onOpenAttachments,
      onOpenSnapshots,
      onExportNoteMarkdown,
      onExportNotePdf,
      onExportNoteHtml,
      onExportNoteTxt,
      onShowGraph,
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
  // Stable note predicates (fresh identity only when the cache changes): they
  // sit in the palette's snippet-effect deps, and an inline arrow's per-render
  // identity would re-run that effect — re-issuing its `note_read` decrypts —
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
  // `commandCtx` note-action handlers the palette dispatches — a second surface
  // onto one IPC path, never a second path. It only exists while a note is open
  // in the focused pane, mirroring the right-sidebar toggle's own gate (which
  // lives in `EditorChrome`), so the two float side by side; `centerView` is
  // the one gate input `EditorChrome` owns, threaded in as a prop.
  const showNoteActions =
    centerView !== "attachments" &&
    paletteWs.focusedLeaf.activeTab?.kind === "note" &&
    paletteWs.pendingNewTabPaneId !== paletteWs.focusedPaneId;
  // The note the "…" menu acts on (the focused-pane note the other items use).
  // Its template flag flips the convert item between promote and demote — the
  // dead `convertNoteToTemplate` wire (nothing called it) and the modal-only
  // `convertTemplateToNote`, surfaced where you author.
  const activeNoteId = ctx.selectedId;
  const activeIsTemplate = activeNoteId !== null && isTemplate(activeNoteId);
  // Convert with an undo toast: promoting a note to a template makes it LEAVE
  // the sidebar (templates are inverse-visibility, hidden like trash), so the
  // toast is what keeps it from reading as "my note vanished". Undo runs the
  // exact inverse. `refreshOne` re-reads the flipped record so the tree settles.
  const convertActive = (toTemplate: boolean) => {
    if (activeNoteId === null) return;
    const id = activeNoteId;
    const forward = toTemplate ? convertNoteToTemplate : convertTemplateToNote;
    const inverse = toTemplate ? convertTemplateToNote : convertNoteToTemplate;
    // The convert wrote the `template:` flag straight to disk, out of band of the
    // open pane's buffer. Re-read the open note (`reloadOpenNote`) so its buffer
    // carries the new frontmatter — otherwise a later autosave would write the
    // stale buffer back and silently revert the flag (the frontmatter-vs-buffer
    // staleness class). Skipped for a dirty buffer, which the reload guards.
    const settle = () => {
      ctx.reloadOpenNote();
      return ctx.refreshOne(id);
    };
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
              void inverse(id).then(settle).catch(() => {});
            },
          },
        });
      })
      .catch(() => {
        /* mutation failure leaves the note unchanged; no toast */
      });
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
      action: "export-markdown",
      icon: "download",
      label: t("editor.noteActions.exportMarkdown"),
      onSelect: commandCtx.onExportNoteMarkdown,
    },
    {
      kind: "action",
      action: "export-pdf",
      icon: "download",
      label: t("editor.noteActions.exportPdf"),
      onSelect: commandCtx.onExportNotePdf,
    },
    {
      kind: "action",
      action: "export-html",
      icon: "download",
      label: t("editor.noteActions.exportHtml"),
      onSelect: commandCtx.onExportNoteHtml,
    },
    {
      kind: "action",
      action: "export-txt",
      icon: "download",
      label: t("editor.noteActions.exportTxt"),
      onSelect: commandCtx.onExportNoteTxt,
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
            top: 6,
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
        // Cancel (Esc / backdrop) pops back to the command palette — the picker
        // is stacked on top of it (the palette closed when the action ran) —
        // UNLESS the "…" menu opened it with the palette closed (see the ref).
        onClose={() => {
          const suppress = suppressPaletteReopenRef.current;
          suppressPaletteReopenRef.current = false;
          setPicker(null);
          if (!suppress) onReopen();
        }}
      />
      {emptyTrashConfirm !== null && (
        <DeleteConfirmModal
          title={t("notes.trash.emptyConfirmTitle")}
          body={t("notes.trash.emptyConfirmBody", { count: emptyTrashConfirm })}
          confirmLabel={t("notes.trash.emptyConfirmCta")}
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
                // Best-effort bulk purge — report a remaining count on partial
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
 * Also owns the global Cmd+N keymap (T25) — wired here so the
 * shortcut fires regardless of which pane is focused.
 *
 * Returns `null` — purely a side-effect mount. The actual sidebar
 * surface is `<NotesSidebarList>` rendered as a sibling.
 */
function SidebarBootstrap() {
  const ctx = useSelectedNote();
  const booted = useRef(false);
  // MYND-574 task 64 — the deep link resolves HERE, and only here, because this
  // is the one place that has the authoritative note list. A URL is untrusted
  // input and a bookmark outlives the note it points at, so the id is checked
  // against `note_list` before it is opened; an id that is not there is dropped
  // and the user lands in an empty editor, never on an error. `routeReady`
  // gates the URL binding below: nothing may rewrite the address bar until this
  // settles, or a reload (which always lands locked on web — the keys are RAM)
  // would throw away the note it was asked to restore.
  const [routeReady, setRouteReady] = useState(false);
  useEffect(() => {
    if (booted.current) return; // StrictMode double-invoke guard
    booted.current = true;
    void (async () => {
      try {
        const ids = await noteList();
        await ctx.refreshAll(ids);
        const target = takeDeepLinkNoteId();
        if (target !== null && ids.includes(target)) ctx.select(target);
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
  // listed + rebindable (#184 C) — the WorkspaceHotkeys `note.new-tab` entry runs
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
// chord literals — the catalog is the one place defaults live). The dispatcher
// only fires the ids it has entries for, so passing the full catalog (including
// the commands handled elsewhere) is harmless; the user override
// (vault.prefs.keymap) shadows these per id. Ctrl+Tab is deliberately NOT a
// catalog-rebindable default — see the inline handler note below.
const KEYBIND_DEFAULTS: Readonly<Record<string, string[]>> = catalogDefaults();

function WorkspaceHotkeys({
  focusActive,
  onToggleFocus,
  onExitFocus,
  onTogglePalette,
  onToggleSettings,
}: {
  focusActive: boolean;
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
      // listener's gate exactly — stands down in plain inputs (rename/search),
      // stays live inside the CM6 editor surface. The dispatcher's preventDefault
      // also suppresses the WebView's native Print dialog on Cmd+P.
      { id: "palette.toggle", scope: {}, run: () => onTogglePalette() },
      // #184 track D — these three were hardcoded window listeners (settings,
      // graph) or palette-only with an INERT declared chord (tasks); routing them
      // through the engine is what makes the panel's "rebindable" mark honest and
      // their default chords actually fire.
      { id: "app.open-settings", scope: {}, run: () => onToggleSettings() },
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
    selectedNoteId: null,
    activeModal: null,
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

  // Ctrl+Tab / Ctrl+Shift+Tab — cycle tabs in the focused pane. Kept as a
  // literal-Ctrl inline handler OUTSIDE the rebindable keymap: Ctrl+Tab is a
  // cross-platform browser convention (literal Ctrl on every OS), but the
  // engine's `Mod` token maps `ctrlKey`→`Mod` on non-mac, so a literal Ctrl
  // can't be distinctly represented as a keymap chord. Treated as an
  // OS/browser-convention chord (same spirit as SYNC-9's CM-formatting
  // deferral); revisit if cross-platform literal-Ctrl bindings become rebindable.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Stand down while typing in a plain input (sidebar rename / search) —
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
 * here, as count-only clickable source cards (no body snippet — grill Q1),
 * alphabetical, self-link hidden, `ctx.open` navigation. No bespoke locked
 * state — the Editor unmounts on lock and its mount-time fail-closed guard
 * covers the race. Stays live via the vault-wide index-changed nonce (SYNC-5):
 * any note's save/rename/move re-queries; the reference-equal bail guards renders.
 */
/**
 * The right panel — a multi-tab surface (right-panel tabs) modeled on the bottom
 * bar: multiple NON-closable tabs (Backlinks / Unlinked mentions / Outline) that
 * drag-reorder and right-click hide/restore, with ONE active tab at a time. The
 * WHOLE-panel show/hide stays the existing `rightCollapsed` toggle (title-bar
 * button + palette command) — unchanged. Each tab body is its own component
 * (`BacklinksTab`, `UnlinkedMentionsSection` in `asTab` mode, `OutlineTab`); this
 * container owns only the strip, the active-tab/order/hidden prefs, and the two
 * right-click menus (the per-tab move/hide + the strip-wide restore checklist).
 */
function RightSidebar() {
  const { t } = useTranslation();
  const ctx = useSelectedNote();
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
  // resolves to a plain disk write — `openNoteDirty: false` is correct in the
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

  const tabOrder = prefs.right_panel_tab_order;
  const hidden = prefs.right_panel_hidden_tabs;
  const order = useMemo(
    () => resolveBarOrder(tabOrder, RIGHT_PANEL_DEFAULT_ORDER),
    [tabOrder],
  );
  // The AI Chat tab is only offered when AI is actually on (#225): with it off
  // the tab was a dead affordance whose body just pointed the user to Settings.
  // Gated on `ai_enabled` (the feature state), NOT `developer_mode` — turning
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
        background: "var(--paper-2)",
        borderInlineStart: "1px solid var(--line-1)",
      }}
    >
      {/* Tab strip — drag-reorder + right-click hide/restore (bottom-bar
          pattern), single active tab. Right-clicking empty strip space opens the
          restore checklist even when every tab is hidden (the only restore path). */}
      <div
        data-testid="editor.right-panel-tabs"
        role="tablist"
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
        {visible.map((id) => {
          const tab = RIGHT_PANEL_TABS.find((tt) => tt.id === id);
          if (tab === undefined) return null;
          const isActive = id === active;
          const label = t(tab.labelKey);
          return (
            // Icon-only tabs (the dar-sağ-panel convention — Obsidian/Logseq):
            // the label rides the tooltip + aria-label so three tabs always fit a
            // 280px panel and the strip keeps a right-click-able empty area.
            <button
              key={id}
              type="button"
              role="tab"
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
        {/* Trailing flex spacer — keeps tabs left-aligned and gives the
            strip-wide restore checklist a reliable empty right-click target (it
            has no onContextMenu of its own, so the event bubbles to the strip). */}
        <div data-testid="editor.right-panel-tabs-rest" style={{ flex: 1, alignSelf: "stretch" }} />
      </div>

      {/* Active tab body */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "16px 18px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {active === null ? (
          <div style={{ fontSize: 13, color: "var(--fg-3)", marginTop: 4 }}>
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
            onInsert={(text) => {
              // "Insert into note" (note-summarization task 5, SYNC-17): append a
              // `## Summary` block to the focused note and let the normal autosave
              // path (note_save/MY01) persist it — byte-identical to a hand-typed
              // block, only on this explicit click.
              const view = getActiveEditorView();
              if (view === null) return;
              const newBody = appendSummaryBlock(view.state.doc.toString(), text);
              view.dispatch({
                changes: { from: 0, to: view.state.doc.length, insert: newBody },
                userEvent: "ai.insert",
              });
            }}
            onSend={(m) => void sendChat(m)}
            onStop={() => {
              // Instant UI: close the turn keeping the partial; then signal the
              // backend to abort the in-flight generation (task 4/9).
              stopChatTurn();
              void stopChat();
            }}
            onOpenNote={(noteId) => void ctx.open(noteId as NoteId).catch(() => {})}
            titleOf={(noteId) => notes.find((n) => n.noteUuid === noteId)?.title ?? null}
          />
        ) : null}
      </div>

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
 * renders NOTHING — the pane is fully hidden (MYND-166 removed the thin
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
  // Collapse/expand is animated by transitioning the pane width between 0 and
  // its open width. The transition stays ARMED at all times EXCEPT during an
  // active resize: a drag changes `width` every pointermove, and an active
  // width transition there would make the pane lag behind the cursor. Arming
  // it permanently (rather than only just-after a collapse flip) is what makes
  // the toggle animate reliably — the transition is already on the element
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
      style={{
        position: "relative",
        width: collapsed ? 0 : width,
        flexShrink: 0,
        display: "flex",
        // Pin the inner content to the inner edge so collapsing clips it
        // toward the screen edge (left sidebar clips right→, right sidebar
        // clips ←left), matching the side the sidebar lives on.
        justifyContent: side === "right" ? "flex-end" : "flex-start",
        overflow: "hidden",
        minHeight: 0,
        transition: resizing
          ? "none"
          : "width var(--duration-base) var(--ease-standard)",
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
 * scrim with a spinner + "saving…" copy — it makes the lock+flush window
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
        fontSize: 13,
        fontWeight: 500,
      }}
    >
      <Spinner size={16} style={{ borderWidth: 2 }} />
      <span>{t("editor.chrome.switchingOverlay.saving")}</span>
    </div>
  );
}

interface BottomBarProps {
  /** Lock callback that awaits the autosave flush before firing
   *  `lockVault()` and the parent's onLock — wired by `EditorChrome`. */
  onLockFlushed: () => Promise<void>;
  onOpenSettings?: () => void;
  /** Open the whole-vault graph (the persistent wedge-first-class affordance,
   *  SYNC-7) — parallel to the settings gear. */
  onShowGraph?: () => void;
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
   *  (phase3-web-client task 23) — trails the save readout. */
  saveStatusUnsynced?: boolean;
  /** Whole-note statistics of the active note (frontmatter + markdown syntax
   *  excluded). `null` hides the readout entirely — same rationale as
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
   *  right-clickable — the only restore path. */
  onContextMenu?: (e: ReactMouseEvent) => void;
  /** Bottom-bar reorder: the user's stored right-cluster display order
   *  (`prefs.bar_items_order`). Resolved against the canonical default at
   *  render so a partial/empty order still renders every visible item. */
  barItemsOrder: string[];
  /** Persist a new right-cluster order after a drag-drop reorder. */
  onReorder: (order: string[]) => void;
  /** Right-click handler for a SPECIFIC bar item — opens the per-item menu
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
  onShowGraph,
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
            fontWeight: 500,
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
    graph: () =>
      onShowGraph ? (
        <Tooltip label={t("editor.chrome.bottomBar.graphTitle")}>
          <button
            type="button"
            data-testid="editor.graph-button"
            onClick={onShowGraph}
            aria-label={t("editor.chrome.bottomBar.showGraph")}
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
            <Icon name="share-2" size={14} />
          </button>
        </Tooltip>
      ) : null,
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
          gap: 4,
          padding: "4px 8px",
          background: "transparent",
          border: 0,
          borderRadius: "var(--radius-1)",
          color: "var(--fg-3)",
          fontFamily: "var(--font-sans)",
          fontSize: 12,
          fontWeight: 500,
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
      // makes the transition audible — modal state must not be a purely visual
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

  return (
    <div
      data-testid="editor.bottom-bar"
      data-editor-chrome
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
      <div style={{ flex: 1 }} />
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
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
 * named-workspaces (MYND-308 task 5) — the bottom-bar workspace switcher: a chip
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
          gap: 4,
          maxWidth: 160,
          padding: "2px 8px",
          background: "transparent",
          border: 0,
          borderRadius: "var(--radius-1)",
          color: "var(--fg-3)",
          cursor: "pointer",
          fontFamily: "var(--font-sans)",
          fontSize: 12,
          fontWeight: 500,
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
            padding: 4,
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
