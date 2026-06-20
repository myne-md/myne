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
//   - PRD: agent-tooling/features/empty-editor-shell/prd.md
//   - Design session: agent-tooling/sessions/design/2026-04-28-empty-editor-shell.md
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
import { CommandPalette } from "../components/CommandPalette";
import type { CommandContext } from "../commands";
import { useKeybindDispatcher } from "../commands/useKeybindDispatcher";
import type { KeybindEntry } from "../commands/keybindEngine";
import { catalogDefaults } from "../commands/bindableCatalog";
import { asViewMode, type ViewMode } from "../editor/view-mode";
import { focusKindOf } from "../commands/scope";
import { FailClosedError } from "../components/FailClosedError";
import { SyncStatusIndicator } from "../components/sync/SyncStatusIndicator";
import { SyncBanners } from "../components/sync/SyncBanners";
import { Icon } from "../components/primitives/Icon";
import { SettingsModal } from "../components/SettingsModal";
import { TemplatesManager } from "../components/TemplatesManager";
import { Spinner } from "../components/Spinner";
import { SnapshotsPanel } from "../notes/components/SnapshotsPanel";
import { SnapshotFailedIndicator } from "../notes/components/SnapshotFailedIndicator";
import { NewNoteFromTemplateModal } from "../components/NewNoteFromTemplateModal";
import { Toast, type ToastAction } from "../components/Toast";
import { NoteExportModal } from "../components/export/NoteExportModal";
import { ObsidianImportModal } from "../notes/import/ObsidianImportModal";
import { ImporterOnboardingOffer } from "../notes/import/ImporterOnboardingOffer";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
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
import type { StageVaultStatus, SuspicionReason, VaultId } from "../lib/stage";
import {
  noteList,
  loadNoteBatch,
  createNoteFromTemplate,
  createBlankNamedNote,
  resolveTodayNote,
} from "../notes";
import { prefsRead } from "../lib/prefs";
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
import type { ExcludedAttachment } from "../dialect/html/emitNoteHtml";
import { NoteList as NotesSidebarList } from "../notes/components/NoteList";
import { vaultIndicesPersist } from "../notes/vaultIndices";
import {
  SECTION_HEADING_STYLE,
  SIDEBAR_CARD_STYLE,
} from "../notes/components/sharedStyles";
import {
  backlinkRows,
  backlinkRowsEqual,
  type BacklinkRow,
} from "../notes/backlinkRows";
import { useIndexNonce } from "../notes/indexNonce";
import { requestRevealViews } from "../notes/views/revealViewsSignal";
import { useResolverNotes } from "../notes/resolverNotes";
import { backlinks } from "../notes/vaultIndices";
import { UnlinkedMentionsSection } from "../notes/components/UnlinkedMentionsSection";
import { linkMention } from "../notes/linkMention";
import type { UnlinkedMention } from "../notes/unlinkedMentions";
import { SaveStatus as SaveStatusBadge } from "../notes/components/SaveStatus";
import {
  SidebarStateProvider,
  useSelectedNote,
  type NoteId,
} from "../notes/sidebarState";
import type { SaveStatus as SaveStatusValue } from "../notes/useAutosave";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import { useActivityHeartbeat } from "../hooks/useActivityHeartbeat";
import { useBackupScheduler } from "../hooks/useBackupScheduler";
import { BACKUP_SCHEDULE_FAILED_TOAST } from "../lib/load-bearing-copy";
import { ResizeHandle } from "../components/primitives/ResizeHandle";
import { VaultSwitcher } from "../components/VaultSwitcher";
import { useEditorLayout } from "./editorLayout";
import { usePrefs } from "../hooks/usePrefs";
import {
  ContextMenu,
  type ContextMenuItem,
} from "../notes/components/ContextMenu";
import { IS_MAC, TRAFFIC_LIGHT_GAP } from "./titlebar";
import { LEFT_BOUNDS, RIGHT_BOUNDS } from "./layoutClamp";
import { useResponsiveCollapse } from "./responsiveCollapse";
import { AttachmentsLibrary } from "../components/attachments/AttachmentsLibrary";
import { REVEAL_ATTACHMENT_EVENT } from "../editor/attachments/fileCardActions";
import { CenterViewProvider, type CenterView } from "./centerView";
import { WorkspaceProvider, useWorkspace } from "../notes/workspaceContext";
import { PaneTree } from "../notes/components/PaneTree";
import { STRIP_HEIGHT } from "../notes/components/TabStrip";
import type { PaneReadout } from "../notes/components/PaneView";
import type { DocStats } from "../notes/documentStats";
import {
  findItemPane,
  resolveActiveSlot,
  sameItem,
  shouldFlushWorkspace,
  switchToSlot,
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
import { setActiveWorkspace } from "../lib/prefs";
import { promptForText } from "../lib/promptForText";

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
const BAR_ITEMS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "sync-status", label: "Sync status" },
  { id: "save-status", label: "Save status" },
  { id: "view-mode", label: "View mode" },
  { id: "workspace", label: "Workspace" },
  { id: "tags", label: "Tags" },
  { id: "views", label: "Views" },
  { id: "graph", label: "Graph" },
  { id: "settings", label: "Settings" },
  { id: "lock", label: "Lock" },
  { id: "word-count", label: "Word count" },
];

/** reading-source-modes (MYND-299): short labels for the BottomBar view-mode
 *  switcher. */
const VIEW_MODE_LABEL: Record<ViewMode, string> = {
  live: "Live",
  reading: "Reading",
  source: "Source",
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
   * wires this to `dispatch({ type: "editor.delete-vault-success" })`;
   * Stage transitions to welcome, this Editor unmounts, the
   * SettingsModal unmounts in cascade.
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
  onResetRequested,
  onRestoreBackup,
  onLock,
  onForceRelock,
  onDeleteVaultSuccess,
  onSwitchVault,
  onCreateAnother,
  switching = false,
}: EditorProps) {
  const [slotPopulated, setSlotPopulated] = useState<boolean | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<EditorToast | null>(null);

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

  // Cmd+, (macOS) / Ctrl+, (Win/Linux) toggles the Settings modal —
  // toggle so the same shortcut closes the modal when it's open.
  // Listener mounts only when the editor body renders (after the
  // mount-time slot guard passes); pre-mount keystrokes are ignored.
  useEffect(() => {
    if (slotPopulated !== true) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen((s) => !s);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [slotPopulated]);

  if (slotPopulated === null) {
    // Loading shim — the IPC takes microseconds (single RwLock read);
    // a flash of nothing is invisible at human latency. Returning
    // null avoids any flash of the editor body before the guard
    // result arrives.
    return null;
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
          onLock={onLock}
          onForceRelock={onForceRelock}
          onDeleteVaultSuccess={onDeleteVaultSuccess}
          onSwitchVault={onSwitchVault}
          onCreateAnother={onCreateAnother}
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
};

type EditorChromeProps = {
  onLock?: () => void;
  onForceRelock?: (status: StageVaultStatus, reason?: SuspicionReason) => void;
  onDeleteVaultSuccess: () => void;
  onSwitchVault?: (targetVaultId: VaultId) => void;
  onCreateAnother?: () => void;
  switching: boolean;
  settingsOpen: boolean;
  onRestoreBackup: () => void;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  toast: EditorToast | null;
  setToast: Dispatch<SetStateAction<EditorToast | null>>;
};

function EditorChrome({
  onLock,
  onForceRelock,
  onDeleteVaultSuccess,
  onSwitchVault,
  onCreateAnother,
  switching,
  settingsOpen,
  onRestoreBackup,
  setSettingsOpen,
  toast,
  setToast,
}: EditorChromeProps) {
  const ctx = useSelectedNote();
  const ws = useWorkspace();
  // Plain-message sink for the pre-existing string consumers (Settings,
  // backup export, importer); the export flow goes through the structured
  // `showExportToast` below so success can carry its reveal action.
  const showToastMessage = useCallback(
    (message: string) => setToast({ message }),
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
    resolve: (choice: AttachmentPreflightChoice | null) => void;
  } | null>(null);
  const confirmAttachments = useCallback(
    (count: number) =>
      new Promise<AttachmentPreflightChoice | null>((resolve) => {
        setExportPreflight({ count, resolve });
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
  // If the Editor unmounts mid-question (lock / force-relock), resolve
  // any pending pre-flight with its cancel value so the awaiting flow
  // (and, on the PDF path, its held body string) isn't stranded forever.
  const exportPreflightRef = useRef(exportPreflight);
  exportPreflightRef.current = exportPreflight;
  const pdfPreflightRef = useRef(pdfPreflight);
  pdfPreflightRef.current = pdfPreflight;
  useEffect(
    () => () => {
      exportPreflightRef.current?.resolve(null);
      pdfPreflightRef.current?.resolve(false);
    },
    [],
  );
  const exportHooks = useMemo<NoteExportUiHooks>(
    () => ({
      showToast: showExportToast,
      confirmAttachments,
      confirmPdfExclusions,
    }),
    [showExportToast, confirmAttachments, confirmPdfExclusions],
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
    (result: ImportResult) => {
      const skipped =
        result.skippedExisting > 0 ? ` · ${result.skippedExisting} skipped` : "";
      showToastMessage(
        `Imported ${result.imported} ${result.imported === 1 ? "note" : "notes"}${skipped}`,
      );
      // Repopulate the sidebar so the imported notes appear immediately.
      void noteList()
        .then((ids) => ctx.refreshAll(ids))
        .catch(() => {
          /* sidebar stays as-is until the next refresh — non-fatal */
        });
    },
    [ctx, showToastMessage],
  );

  // Cmd/Ctrl+Shift+G opens the whole-vault graph tab (MYND-198, SYNC-7) — the
  // third entry point alongside the command-palette action + BottomBar button.
  // The graph is a singleton tab, so re-firing reveals the existing tab.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        (e.key === "G" || e.key === "g")
      ) {
        e.preventDefault();
        ws.openGraph();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ws]);
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
  const { prefs: barPrefs, setHiddenBarItems } = usePrefs();
  const hiddenBarItems = barPrefs.hidden_bar_items;
  const [barMenu, setBarMenu] = useState<{ x: number; y: number } | null>(null);

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

  // Import a `.base` saved-views file (Saved Views #6, MYND-276, task 6): pick a
  // single `.base` file (no new capability — dialog:allow-open already granted),
  // run the shipped import entry point (read → parse → map → persist into
  // vault.prefs), and surface a concise SYNC-12 summary toast. The picked path's
  // parent directory is the root passed to the root-confined importer read seam.
  const importBaseView = useCallback(async () => {
    const picked = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "Obsidian Base", extensions: ["base"] }],
    });
    if (picked === null) return; // cancelled — no toast
    try {
      // The root-confining directory split lives in importBase (sealed seam).
      const tally = await importBaseFilePath(picked);
      let message = `Imported ${tally.importedViews} view(s)`;
      if (tally.skippedViews > 0) {
        message += ` · ${tally.skippedViews} skipped`;
      }
      if (tally.droppedUnsupportedFilters > 0) {
        message += ` · ${tally.droppedUnsupportedFilters} filters dropped`;
      }
      setToast({ message });
    } catch (e) {
      if (e instanceof BaseParseError) {
        setToast({ message: "Not a valid .base file." });
      } else if (e instanceof BaseImportPersistError) {
        // Count-only (SYNC-12) — never surface the failed view's name in copy.
        setToast({
          message: `Import stopped after ${e.persistedCount} view(s).`,
        });
      } else {
        setToast({ message: "Import failed." });
      }
    }
  }, [setToast]);

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
  useBackupScheduler((scheduleTick) => {
    if (scheduleTick.freshFailure) {
      setToast({ message: BACKUP_SCHEDULE_FAILED_TOAST });
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
        const descriptor = await workspaceRead();
        if (descriptor === null) return;
        const container = deserializeWorkspaces(descriptor);
        if (container === null) return; // malformed → keep the default container
        // Apply the persisted active-slot pointer (MYP1) against the loaded
        // slots; `resolveActiveSlot` self-heals a stale/missing pointer to the
        // first slot. `prefsRead` defaults the field to null on any read miss.
        let activePref: SlotId | null = null;
        try {
          activePref = (await prefsRead()).active_workspace;
        } catch {
          // Pref read failure → fall back to the container's own activeId.
        }
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
    workspaceDirtyRef.current = true;
    void workspaceStage(serializeWorkspaces(ws.workspacesSnapshot())).catch(() => {
      // Best-effort; outside Tauri (browser dev shim) the invoke rejects.
    });
    // `slots` identity changes on save-as/switch/rename/delete; `root` /
    // `focusedPaneId` change on every layout edit of the active slot.
  }, [restoreSettled, ws.slots, ws.activeWorkspaceId, ws.root, ws.focusedPaneId]);

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
        unlisten = await w.onCloseRequested(async (event) => {
          if (cancelled) return;
          // Stop the default close; we'll close manually after flush.
          event.preventDefault();
          await flushAll();
          await persistWorkspace();
          await persistVaultIndices();
          await w.close();
        });
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
    await flushAll();
    await persistWorkspace();
    await persistVaultIndices();
    await lockVault().catch(() => {
      /* lock is best-effort, parent callback still fires */
    });
    onLock?.();
  }, [flushAll, persistWorkspace, persistVaultIndices, onLock]);

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
        title: "Save workspace as",
        confirmLabel: "Save",
        placeholder: "Workspace name",
        testIdPrefix: "workspace-prompt",
      });
      if (name !== null) saveWorkspaceAs(name);
    })();
  }, [saveWorkspaceAs]);
  const handleRenameWorkspace = useCallback(() => {
    const snapshot = ws.workspacesSnapshot();
    const active = snapshot.slots.find((s) => s.id === snapshot.activeId);
    if (active === undefined) return;
    void (async () => {
      const name = await promptForText({
        title: "Rename workspace",
        initialValue: active.name,
        confirmLabel: "Rename",
        testIdPrefix: "workspace-prompt",
      });
      if (name !== null) renameWorkspace(active.id, name);
    })();
  }, [ws, renameWorkspace]);
  // Rename a SPECIFIC slot (the per-row pencil in the bottom-bar switcher) — vs
  // handleRenameWorkspace which renames the active slot (the palette command).
  const handleRenameWorkspaceById = useCallback(
    (id: SlotId) => {
      const slot = ws.workspacesSnapshot().slots.find((s) => s.id === id);
      if (slot === undefined) return;
      void (async () => {
        const name = await promptForText({
          title: "Rename workspace",
          initialValue: slot.name,
          confirmLabel: "Rename",
          testIdPrefix: "workspace-prompt",
        });
        if (name !== null) renameWorkspace(id, name);
      })();
    },
    [ws, renameWorkspace],
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
          resizeLabel="Resize notes sidebar"
        >
            <div style={SIDEBAR_COLUMN_STYLE}>
              {/* Traffic-light + left-toggle clearance row. The floated toggle
                  and macOS traffic lights sit over this; the vault switcher
                  and Notes list start below it. Draggable (title-bar row). */}
              <div
                data-tauri-drag-region
                style={{
                  height: STRIP_HEIGHT,
                  flexShrink: 0,
                  background: "var(--paper-2)",
                  borderRight: "1px solid var(--line-1)",
                }}
              />
              <SidebarVaultSwitcher
                onSwitchVault={onSwitchVault}
                onCreateAnother={onCreateAnother}
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
              data-tauri-drag-region
              style={{
                height: STRIP_HEIGHT,
                flexShrink: 0,
                background: "var(--paper-2)",
                borderBottom: "1px solid var(--line-1)",
              }}
            />
            <AttachmentsLibrary onClose={() => setCenterView("editor")} />
          </div>
        ) : (
          <PaneTree
            node={ws.root}
            focusedPaneId={ws.focusedPaneId}
            onReadout={onReadout}
            leftInset={leftCollapsed ? LEFT_CLEARANCE : 0}
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
            resizeLabel="Resize backlinks sidebar"
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
          left: LEFT_TOGGLE_X,
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
      {centerView !== "attachments" && (
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
        onContextMenu={(e) => {
          e.preventDefault();
          setBarMenu({ x: e.clientX, y: e.clientY });
        }}
      />
      {barMenu && (
        <ContextMenu
          x={barMenu.x}
          y={barMenu.y}
          onClose={() => setBarMenu(null)}
          items={BAR_ITEMS.map(
            (it): ContextMenuItem => ({
              id: it.id,
              label: it.label,
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
      )}
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onShowToast={showToastMessage}
        onForceRelock={onForceRelock}
        onDeleteVaultSuccess={onDeleteVaultSuccess}
        onImportObsidian={() => {
          setSettingsOpen(false);
          setImporterOpen(true);
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
      <NewNoteFromTemplateModal
        open={newFromTemplateOpen}
        onClose={() => setNewFromTemplateOpen(false)}
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
      <CommandPaletteHotkey onToggle={() => setPaletteOpen((v) => !v)} />
      <WorkspaceHotkeys
        focusActive={focusActive}
        onToggleFocus={toggleFocus}
        onExitFocus={exitFocus}
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
      <Toast
        message={toast?.message ?? null}
        action={toast?.action}
        // Action-bearing toasts (export success "Show in folder") get the
        // soft-trash Undo precedent's 6 s window (NoteList.tsx) — 2.5 s is
        // not enough to read the message AND click the inline action.
        durationMs={toast?.action !== undefined ? 6000 : 2500}
        onDone={() => setToast(null)}
      />
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
};

// Sidebar toggles float in the editor's top corners (the OS title-bar row),
// Obsidian-style — there is no separate top bar; each top pane's tab strip
// rises into that row. These constants place the toggles clear of the macOS
// traffic lights and size the clearance the underlying top surface (sidebar
// header or a corner pane's strip) must reserve so nothing collides.
/** Left toggle's x offset — comfortably right of the traffic lights on macOS. */
const LEFT_TOGGLE_X = IS_MAC ? TRAFFIC_LIGHT_GAP + 16 : 12;
/** Right toggle's x offset from the right edge. */
const RIGHT_TOGGLE_X = 8;
/** Full width of the top-left control cluster: the sidebar toggle plus the
 *  back + forward nav buttons (MYND-260), each preceded by a cluster gap. */
const LEFT_CONTROLS_WIDTH =
  TITLE_BAR_TOGGLE_WIDTH + 2 * (TITLE_BAR_CLUSTER_GAP + TITLE_BAR_NAV_WIDTH);
/** Left clearance: the top-left surface must keep its content past this. */
const LEFT_CLEARANCE = LEFT_TOGGLE_X + LEFT_CONTROLS_WIDTH + 8;
/** Right clearance: the top-right surface must keep its content before this. */
const RIGHT_CLEARANCE = RIGHT_TOGGLE_X + TITLE_BAR_TOGGLE_WIDTH + 8;

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
  switching,
}: {
  onSwitchVault?: (targetVaultId: VaultId) => void;
  onCreateAnother?: () => void;
  switching: boolean;
}) {
  if (onSwitchVault === undefined || onCreateAnother === undefined) return null;
  return (
    <div
      style={{
        flexShrink: 0,
        // Sits below the traffic-light clearance row, so normal padding — no
        // bottom divider (it reads as a header above the Notes list directly).
        padding: "8px 8px 6px",
        background: "var(--paper-2)",
        borderRight: "1px solid var(--line-1)",
      }}
    >
      <VaultSwitcher
        onSwitchVault={onSwitchVault}
        onCreateAnother={onCreateAnother}
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
  const icon =
    side === "left"
      ? collapsed
        ? "panel-left"
        : "panel-left-close"
      : collapsed
        ? "panel-right"
        : "panel-right-close";
  const label = `${collapsed ? "Show" : "Hide"} ${
    side === "left" ? "notes" : "backlinks"
  } sidebar`;
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
  const label = direction === "back" ? "Go back" : "Go forward";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      data-testid={`editor.nav-${direction}`}
      data-disabled={disabled ? "true" : "false"}
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
  onImportBaseView: () => void;
  onBackupVault: () => void;
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
};

function CommandPaletteHost({
  open,
  onClose,
  onOpenSettings,
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
  const ctx = useSelectedNote();
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
        showAttachmentToast("No notes to open.");
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
  }, [ctx]);
  const commandCtx: CommandContext = useMemo(
    () => ({
      stageName: "editor",
      selectedNoteId: ctx.selectedId,
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
  return (
    <CommandPalette
      open={open}
      onClose={onClose}
      ctx={commandCtx}
      isTrashed={(id) => ctx.cache.get(id)?.trashed != null}
      isTemplate={(id) => ctx.cache.get(id)?.template === true}
      isArchived={(id) => ctx.cache.get(id)?.archived != null}
    />
  );
}

/**
 * Global window-level keydown listener for the unified command palette
 * (MYND-86 + MYND-40). Sits outside the editor's CM6 keymap so it works
 * regardless of which pane has focus (sidebar, settings rail, etc.).
 *
 * `Cmd/Ctrl+K` and `Cmd/Ctrl+P` BOTH toggle the same palette — it shows
 * commands + note search together, so there is no separate mode to enter.
 * `preventDefault` (which fires for both) also suppresses the WebView's native
 * Print dialog on Cmd+P.
 */
function CommandPaletteHotkey({ onToggle }: { onToggle: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key !== "k" && e.key !== "K" && e.key !== "p" && e.key !== "P") {
        return;
      }
      // Skip when typing inside an input or contenteditable field whose
      // intent is to capture all keystrokes (e.g., rename input, URL
      // overlay input). Editor's contentDOM IS contenteditable but the
      // palette should still open from there — special-case by checking
      // for the `.cm-content` class.
      const target = e.target as HTMLElement | null;
      if (target !== null) {
        const tag = target.tagName.toLowerCase();
        if (
          (tag === "input" || tag === "textarea") &&
          !target.classList.contains("cm-content")
        ) {
          return;
        }
      }
      e.preventDefault();
      onToggle();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onToggle]);
  return null;
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
  useEffect(() => {
    if (booted.current) return; // StrictMode double-invoke guard
    booted.current = true;
    void (async () => {
      try {
        const ids = await noteList();
        await ctx.refreshAll(ids);
      } catch (e) {
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn("[Editor] sidebar boot refresh failed:", e);
        }
      }
    })();
  }, [ctx]);

  // Global Cmd+N / Ctrl+N → create new note (T25).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key !== "n" && e.key !== "N") return;
      e.preventDefault();
      void ctx.createAndStartRename().catch((err) => {
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn("[Editor] Cmd+N createNote failed:", err);
        }
      });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [ctx]);

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
}: {
  focusActive: boolean;
  onToggleFocus: () => void;
  onExitFocus: () => void;
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
    ];
  }, [ws, ctx, onToggleFocus]);

  useKeybindDispatcher({
    entries,
    defaults: KEYBIND_DEFAULTS,
    overrides: prefs.keymap,
    stageName: "editor",
    selectedNoteId: null,
    activeModal: null,
  });

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
function RightSidebar() {
  const ctx = useSelectedNote();
  const notes = useResolverNotes();
  const indexNonce = useIndexNonce();
  const [rows, setRows] = useState<BacklinkRow[]>([]);

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

  useEffect(() => {
    const noteId = ctx.selectedId;
    if (noteId === null) {
      setRows((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    let cancelled = false;
    void backlinks(noteId, notes).then(
      (groups) => {
        if (cancelled) return;
        const next = backlinkRows(groups, noteId);
        // SYNC-5 condition 2: keep the previous reference when the result is
        // unchanged, so a no-op re-query (e.g. a vault-wide reindex burst)
        // bails the React render.
        setRows((prev) => (backlinkRowsEqual(prev, next) ? prev : next));
      },
      () => {
        // Best-effort — a transient query failure shows the empty state.
        if (!cancelled) setRows((prev) => (prev.length === 0 ? prev : []));
      },
    );
    return () => {
      cancelled = true;
    };
    // `indexNonce` re-runs the cheap (decrypt-free) re-query on every vault
    // index mutation (SYNC-5); the reference-equal bail above guards renders.
  }, [ctx.selectedId, notes, indexNonce]);

  return (
    <aside
      style={{
        // Fills the layout-seam wrapper, which owns the resizable width.
        // `flex: 1` fills the height below the ribbon header (MYND-166).
        width: "100%",
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        background: "var(--paper-2)",
        borderLeft: "1px solid var(--line-1)",
        padding: "16px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={SECTION_HEADING_STYLE}>Linked from {rows.length}</div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--fg-3)", marginTop: 4 }}>
          No backlinks yet.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {rows.map((row) => (
            <button
              key={row.sourceUuid}
              type="button"
              data-testid="editor.backlink-row"
              data-source-id={row.sourceUuid}
              onClick={() => void ctx.open(row.sourceUuid)}
              style={SIDEBAR_CARD_STYLE}
            >
              <span
                style={{ fontSize: 12, fontWeight: 600, color: "var(--fg-1)" }}
              >
                {row.sourceTitle ?? "Untitled"}
              </span>
              {row.count > 1 && (
                <span
                  style={{ fontSize: 12, color: "var(--fg-3)", marginLeft: 6 }}
                >
                  ({row.count})
                </span>
              )}
              {/* Archived source (MYND-331): a backlink from an archived note
                  still resolves (archive ≠ soft-trash) — a small badge tells the
                  user the source lives in the Archive, not the working tree. */}
              {ctx.cache.get(row.sourceUuid)?.archived != null && (
                <span
                  data-testid="editor.backlink-archived-badge"
                  title="Archived"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    marginLeft: 6,
                    color: "var(--fg-3)",
                  }}
                >
                  <Icon name="archive" size={12} />
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      <UnlinkedMentionsSection
        openNoteId={selectedId}
        openTitle={openTitle}
        notes={notes}
        onNavigate={(noteId) => void ctx.open(noteId)}
        onLinkMention={handleLinkMention}
      />
    </aside>
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
      <span>Saving…</span>
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
}: BottomBarProps) {
  const handleLockClick = () => {
    void onLockFlushed().catch(() => {
      /* lock flush failures already routed through saveStatus */
    });
  };
  const isHidden = (id: string) => hiddenItems.includes(id);

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
      {!isHidden("sync-status") && <SyncStatusIndicator />}
      <div style={{ flex: 1 }} />
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {!hideSaveStatus && !isHidden("save-status") && (
          <SaveStatusBadge status={saveStatus} onRetry={onRetry} />
        )}
        {!isHidden("workspace") &&
          onSwitchWorkspace !== undefined &&
          activeWorkspaceId !== undefined && (
            <WorkspaceSwitcherControl
              slots={workspaceSlots}
              activeId={activeWorkspaceId}
              onSwitch={onSwitchWorkspace}
              onSaveAs={onSaveWorkspaceAs}
              onRename={onRenameWorkspace}
            />
          )}
        {viewMode !== null && onCycleViewMode && !isHidden("view-mode") && (
          <button
            type="button"
            onClick={onCycleViewMode}
            aria-label="Cycle view mode"
            data-testid="editor.view-mode-cta"
            data-view-mode={viewMode}
            title={`View mode: ${VIEW_MODE_LABEL[viewMode]} (click to cycle)`}
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
            }}
          >
            {VIEW_MODE_LABEL[viewMode]}
          </button>
        )}
        {showPreview && onTogglePreview && (
          <button
            type="button"
            onClick={onTogglePreview}
            aria-label="Toggle side-by-side preview"
            aria-pressed={previewActive}
            data-testid="editor.preview-companion-toggle"
            title="Toggle side-by-side preview"
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
            }}
          >
            <Icon name="panel-right" size={14} />
          </button>
        )}
        {onShowTags && !isHidden("tags") && (
          <button
            type="button"
            onClick={onShowTags}
            aria-label="Browse tags"
            data-testid="editor.tags-cta"
            title="Tags"
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
            }}
          >
            <Icon name="hash" size={14} />
          </button>
        )}
        {onShowViews && !isHidden("views") && (
          <button
            type="button"
            onClick={onShowViews}
            aria-label="Browse views"
            data-testid="editor.views-cta"
            title="Views"
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
            }}
          >
            <Icon name="layout-grid" size={14} />
          </button>
        )}
        {onShowGraph && !isHidden("graph") && (
          <button
            type="button"
            data-testid="editor.graph-button"
            onClick={onShowGraph}
            aria-label="Show graph view"
            title="Graph (⌘⇧G)"
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
            }}
          >
            <Icon name="share-2" size={14} />
          </button>
        )}
        {!isHidden("settings") && (
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="Open settings"
            data-testid="editor.settings-cta"
            title="Settings (⌘,)"
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
            }}
          >
            <Icon name="settings" size={12} />
          </button>
        )}
        {!isHidden("lock") && (
          <button
            type="button"
            onClick={handleLockClick}
            aria-label="Lock vault"
            data-testid="editor.lock-cta"
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
            }}
          >
            <Icon name="lock" size={12} />
            <span>Lock</span>
          </button>
        )}
        {(() => {
          // Combined statistics readout (MYND-339), reusing the `word-count`
          // bar-item id (one toggle). Shows the selection figures when a
          // non-empty selection exists, else the whole-note figures; the full
          // four-stat breakdown is in the hover title.
          const shown = selectionStats ?? stats;
          if (shown === null || isHidden("word-count")) return null;
          const isSel = selectionStats !== null;
          return (
            <span
              data-testid="editor.doc-stats"
              data-scope={isSel ? "selection" : "document"}
              title={
                `${shown.characters} characters · ${shown.words} words · ` +
                `${shown.spaces} spaces · ${shown.paragraphs} ` +
                `${shown.paragraphs === 1 ? "paragraph" : "paragraphs"}` +
                `${isSel ? " (selection)" : ""}`
              }
              style={{
                ...STATUS_TEXT_STYLE,
                fontFamily: "var(--font-mono)",
              }}
            >
              {shown.words} {shown.words === 1 ? "word" : "words"} · {shown.characters} chars
              {isSel ? " (sel)" : ""}
            </span>
          );
        })()}
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
  const activeName = active?.name ?? "Workspace";

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
        aria-label="Switch workspace"
        data-testid="editor.workspace-switcher.toggle"
        title={`Workspace: ${activeName}`}
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
            right: 0,
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
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    textAlign: "left",
                    padding: "6px 8px",
                    background: "transparent",
                    border: 0,
                    borderRadius: "var(--radius-1)",
                    color: "var(--fg-1)",
                    cursor: "pointer",
                    fontFamily: "var(--font-sans)",
                    fontSize: 12,
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
                    aria-label={`Rename workspace ${s.name}`}
                    data-testid="editor.workspace-switcher.rename"
                    data-workspace-id={s.id}
                    title="Rename workspace"
                    onClick={() => {
                      setOpen(false);
                      onRename(s.id);
                    }}
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
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  width: "100%",
                  textAlign: "left",
                  padding: "6px 8px",
                  background: "transparent",
                  border: 0,
                  borderRadius: "var(--radius-1)",
                  color: "var(--fg-2)",
                  cursor: "pointer",
                  fontFamily: "var(--font-sans)",
                  fontSize: 12,
                }}
              >
                <span style={{ width: 14, flexShrink: 0, color: "var(--fg-3)" }}>
                  <Icon name="plus" size={12} />
                </span>
                <span>Save current as…</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
