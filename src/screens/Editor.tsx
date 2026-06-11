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
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import { CommandPalette } from "../components/CommandPalette";
import type { CommandContext } from "../commands";
import { FailClosedError } from "../components/FailClosedError";
import { Icon } from "../components/primitives/Icon";
import { SettingsModal } from "../components/SettingsModal";
import { TemplatesManager } from "../components/TemplatesManager";
import { Spinner } from "../components/Spinner";
import { SnapshotsPanel } from "../notes/components/SnapshotsPanel";
import { GraphView } from "../notes/components/GraphView";
import { SnapshotFailedIndicator } from "../notes/components/SnapshotFailedIndicator";
import { NewNoteFromTemplateModal } from "../components/NewNoteFromTemplateModal";
import { Toast } from "../components/Toast";
import { ObsidianImportModal } from "../notes/import/ObsidianImportModal";
import { ImporterOnboardingOffer } from "../notes/import/ImporterOnboardingOffer";
import { BackupExportModal } from "../components/backup/BackupExportModal";
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
import { NoteList as NotesSidebarList } from "../notes/components/NoteList";
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
import { ResizeHandle } from "../components/primitives/ResizeHandle";
import { VaultSwitcher } from "../components/VaultSwitcher";
import { useEditorLayout } from "./editorLayout";
import { IS_MAC, TRAFFIC_LIGHT_GAP } from "./titlebar";
import { LEFT_BOUNDS, RIGHT_BOUNDS } from "./layoutClamp";
import { AttachmentsLibrary } from "../components/attachments/AttachmentsLibrary";
import { CenterViewProvider, type CenterView } from "./centerView";
import { WorkspaceProvider, useWorkspace } from "../notes/workspaceContext";
import { PaneTree } from "../notes/components/PaneTree";
import { STRIP_HEIGHT } from "../notes/components/TabStrip";
import type { PaneReadout } from "../notes/components/PaneView";
import { findNotePane } from "../notes/workspaceState";
import {
  deserializeWorkspace,
  serializeWorkspace,
  workspaceRead,
  workspaceStage,
  workspaceWrite,
} from "../lib/workspace-persist";


const STATUS_TEXT_STYLE: CSSProperties = {
  fontSize: 12,
  color: "var(--fg-3)",
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
  const [toastMessage, setToastMessage] = useState<string | null>(null);

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
          toastMessage={toastMessage}
          setToastMessage={setToastMessage}
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
  toastMessage: string | null;
  setToastMessage: Dispatch<SetStateAction<string | null>>;
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
  toastMessage,
  setToastMessage,
}: EditorChromeProps) {
  const ctx = useSelectedNote();
  const ws = useWorkspace();
  const [paletteOpen, setPaletteOpen] = useState<boolean>(false);
  const [templatesOpen, setTemplatesOpen] = useState<boolean>(false);
  // Backup-export modal (MYND-56 task 1).
  const [backupExportOpen, setBackupExportOpen] = useState<boolean>(false);
  const [snapshotsOpen, setSnapshotsOpen] = useState<boolean>(false);
  const [graphOpen, setGraphOpen] = useState<boolean>(false);
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
      setToastMessage(
        `Imported ${result.imported} ${result.imported === 1 ? "note" : "notes"}${skipped}`,
      );
      // Repopulate the sidebar so the imported notes appear immediately.
      void noteList()
        .then((ids) => ctx.refreshAll(ids))
        .catch(() => {
          /* sidebar stays as-is until the next refresh — non-fatal */
        });
    },
    [ctx, setToastMessage],
  );

  // Cmd/Ctrl+Shift+G toggles the whole-vault graph (MYND-198, SYNC-7) — the
  // third entry point alongside the command-palette action + BottomBar button.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        (e.key === "G" || e.key === "g")
      ) {
        e.preventDefault();
        setGraphOpen((g) => !g);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const [newFromTemplateOpen, setNewFromTemplateOpen] = useState<boolean>(false);
  // Bottom-bar readout (save status + word count) — reported up by
  // whichever PaneView is currently focused (MYND-166). Per-pane PaneViews
  // own content load, autosave, word count, and the surgical sidebar
  // refresh-after-save; the chrome just mirrors the focused pane's readout.
  const [readout, setReadout] = useState<PaneReadout>({
    status: { status: "clean" },
    wordCount: null,
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
    const where = findNotePane(
      { root: ws.root, focusedPaneId: ws.focusedPaneId },
      selectedId,
    );
    if (where === null) openInFocused(selectedId);
    // `ws.root` is read at fire time; the effect triggers only on a real
    // selection change, never per-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, openInFocused]);

  const focusedActive = ws.focusedLeaf.activeTab;
  const select = ctx.select;
  useEffect(() => {
    select(focusedActive);
  }, [focusedActive, select]);

  // MYND-121 — report window-level activity to the backend auto-lock idle
  // timer. The Editor is mounted iff the vault is Unlocked, so the heartbeat
  // runs exactly while a lockable session is live.
  useActivityHeartbeat();

  // Close / lock / idle-lock flush EVERY pane's pending save via the
  // workspace flush registry (each PaneView registers its `flushIfDirty`).
  // Per-pane PaneViews own content load, autosave, the surgical sidebar
  // refresh-after-save (title/H1 → row label), and the `contentReloadNonce`
  // re-sync (rename / snapshot restore) — so the chrome only orchestrates
  // the cross-pane flush.
  const flushAll = ws.flushAll;

  // MYND-166 — restore the persisted workspace ONCE on mount (unlock).
  // A missing / unreadable / malformed descriptor leaves the default
  // single empty pane (spec § 9.7.4). Runs after the slot guard, so the
  // backend read is Slot::Unlocked-gated.
  const restore = ws.restore;
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
        const state = deserializeWorkspace(descriptor);
        if (state !== null) restore(state);
      } catch {
        // Read failure → keep the default workspace (best-effort restore).
      } finally {
        setRestoreSettled(true);
      }
    })();
  }, [restore]);

  // Latest serialized descriptor, refreshed every render so the
  // graceful-exit hooks (which capture a stale closure) always persist the
  // CURRENT layout. Serialization is cheap (a small JSON tree).
  const descriptorRef = useRef("");
  descriptorRef.current = serializeWorkspace({
    root: ws.root,
    focusedPaneId: ws.focusedPaneId,
  });
  // Persist the workspace descriptor (graceful-exit only — never per
  // tab-switch, so the blob mtime stays a low-resolution lock/quit signal).
  const persistWorkspace = useCallback(async () => {
    try {
      await workspaceWrite(descriptorRef.current);
    } catch {
      // Best-effort — a failed convenience write never blocks lock/close.
    }
  }, []);

  // MYND-166 — mirror the current layout into the backend's in-RAM staging
  // slot on every change (incl. the restored/default state on mount). The
  // backend flushes it to vault.workspace on `ExitRequested`, so an app QUIT
  // (Cmd+Q / app-menu Quit) persists the layout even though it never fires
  // the window's `onCloseRequested`. Staging is RAM-only — it never writes
  // the blob, so its mtime stays a low-resolution lock/quit signal.
  useEffect(() => {
    if (!restoreSettled) return; // don't stage the pre-restore default layout
    void workspaceStage(
      serializeWorkspace({ root: ws.root, focusedPaneId: ws.focusedPaneId }),
    ).catch(() => {
      // Best-effort; outside Tauri (browser dev shim) the invoke rejects.
    });
  }, [restoreSettled, ws.root, ws.focusedPaneId]);

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
  }, [flushAll, persistWorkspace]);

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
  }, [flushAll, persistWorkspace]);

  // Lock button flush-then-lock — `decisions.md` 2026-05-07 canonical
  // flush-on-lock, now across all panes; persist the workspace before lock.
  const handleLockFlushed = useCallback(async () => {
    await flushAll();
    await persistWorkspace();
    await lockVault().catch(() => {
      /* lock is best-effort, parent callback still fires */
    });
    onLock?.();
  }, [flushAll, persistWorkspace, onLock]);

  const centerViewValue = useMemo(
    () => ({ view: centerView, setView: setCenterView }),
    [centerView],
  );

  return (
    <CenterViewProvider value={centerViewValue}>
    <div
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
        {!layout.leftCollapsed && (
          <SidebarPane
            side="left"
            width={layout.leftWidth}
            collapsed={false}
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
              />
            </div>
          </SidebarPane>
        )}
        {centerView === "attachments" ? (
          // Attachments is a full-center view with no tab strip; give it a
          // matching drag-region clearance row so its toolbar clears the
          // floated toggles + traffic lights.
          <div
            style={{
              flex: 1,
              minWidth: 0,
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
            leftInset={layout.leftCollapsed ? LEFT_CLEARANCE : 0}
            rightInset={layout.rightCollapsed ? RIGHT_CLEARANCE : 0}
          />
        )}
        {centerView !== "attachments" && !layout.rightCollapsed && (
          <SidebarPane
            side="right"
            width={layout.rightWidth}
            collapsed={false}
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
          row), level with the macOS traffic lights. */}
      <div
        style={{ position: "absolute", top: 6, left: LEFT_TOGGLE_X, zIndex: 30 }}
      >
        <TitleBarToggle
          side="left"
          collapsed={layout.leftCollapsed}
          onToggle={layout.toggleLeftCollapsed}
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
            collapsed={layout.rightCollapsed}
            onToggle={layout.toggleRightCollapsed}
          />
        </div>
      )}
      <BottomBar
        onOpenSettings={() => setSettingsOpen(true)}
        onShowGraph={() => setGraphOpen(true)}
        onLockFlushed={handleLockFlushed}
        saveStatus={readout.status}
        onRetry={readout.retry}
        hideSaveStatus={ws.focusedLeaf.activeTab === null}
        wordCount={readout.wordCount}
      />
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onShowToast={setToastMessage}
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
      />
      <BackupExportModal
        open={backupExportOpen}
        onClose={() => setBackupExportOpen(false)}
        onShowToast={setToastMessage}
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
      <GraphView open={graphOpen} onClose={() => setGraphOpen(false)} />
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
        onBackupVault={() => {
          setPaletteOpen(false);
          setBackupExportOpen(true);
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
        onShowGraph={() => {
          setPaletteOpen(false);
          setGraphOpen(true);
        }}
        onLockFlushed={async () => {
          setPaletteOpen(false);
          await handleLockFlushed();
        }}
        onToggleLeftSidebar={() => {
          setPaletteOpen(false);
          layout.toggleLeftCollapsed();
        }}
        onToggleRightSidebar={() => {
          setPaletteOpen(false);
          layout.toggleRightCollapsed();
        }}
      />
      <CommandPaletteHotkey onToggle={() => setPaletteOpen((v) => !v)} />
      <WorkspaceHotkeys />
      <Toast message={toastMessage} onDone={() => setToastMessage(null)} />
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

// Sidebar toggles float in the editor's top corners (the OS title-bar row),
// Obsidian-style — there is no separate top bar; each top pane's tab strip
// rises into that row. These constants place the toggles clear of the macOS
// traffic lights and size the clearance the underlying top surface (sidebar
// header or a corner pane's strip) must reserve so nothing collides.
/** Left toggle's x offset — comfortably right of the traffic lights on macOS. */
const LEFT_TOGGLE_X = IS_MAC ? TRAFFIC_LIGHT_GAP + 16 : 12;
/** Right toggle's x offset from the right edge. */
const RIGHT_TOGGLE_X = 8;
/** Left clearance: the top-left surface must keep its content past this. */
const LEFT_CLEARANCE = LEFT_TOGGLE_X + TITLE_BAR_TOGGLE_WIDTH + 8;
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
}: {
  side: "left" | "right";
  collapsed: boolean;
  onToggle: () => void;
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
      aria-label={label}
      title={label}
      style={{
        display: "flex",
        alignSelf: "center",
        alignItems: "center",
        justifyContent: "center",
        width: TITLE_BAR_TOGGLE_WIDTH,
        height: 26,
        flexShrink: 0,
        border: 0,
        borderRadius: "var(--radius-1)",
        background: "transparent",
        color: "var(--fg-3)",
        cursor: "pointer",
      }}
    >
      <Icon name={icon} size={16} />
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
  onShowGraph: () => void;
  onImportObsidian: () => void;
  onBackupVault: () => void;
  onLockFlushed: () => Promise<void>;
  onToggleLeftSidebar: () => void;
  onToggleRightSidebar: () => void;
};

function CommandPaletteHost({
  open,
  onClose,
  onOpenSettings,
  onOpenAttachments,
  onManageTemplates,
  onNewNoteFromTemplate,
  onOpenSnapshots,
  onShowGraph,
  onImportObsidian,
  onBackupVault,
  onLockFlushed,
  onToggleLeftSidebar,
  onToggleRightSidebar,
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
  const commandCtx: CommandContext = useMemo(
    () => ({
      stageName: "editor",
      selectedNoteId: ctx.selectedId,
      onLock: onLockFlushed,
      onOpenSettings,
      onManageTemplates,
      onNewNoteFromTemplate,
      onOpenTodayNote,
      onOpenAttachments,
      onOpenSnapshots,
      onShowGraph,
      onImportObsidian,
      onBackupVault,
      onToggleLeftSidebar,
      onToggleRightSidebar,
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
      onOpenAttachments,
      onOpenSnapshots,
      onShowGraph,
      onImportObsidian,
      onBackupVault,
      onToggleLeftSidebar,
      onToggleRightSidebar,
    ],
  );
  return (
    <CommandPalette
      open={open}
      onClose={onClose}
      ctx={commandCtx}
      isTrashed={(id) => ctx.cache.get(id)?.trashed != null}
      isTemplate={(id) => ctx.cache.get(id)?.template === true}
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
 */
function WorkspaceHotkeys() {
  const ws = useWorkspace();
  const ctx = useSelectedNote();
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
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
      const mod = e.metaKey || e.ctrlKey;

      // Ctrl+Tab / Ctrl+Shift+Tab — cycle tabs in the focused pane.
      if (e.ctrlKey && e.key === "Tab") {
        const tabs = ws.focusedLeaf.tabs;
        if (tabs.length === 0) return;
        e.preventDefault();
        const cur = ws.focusedLeaf.activeTab;
        const i = cur === null ? -1 : tabs.indexOf(cur);
        const len = tabs.length;
        const next = e.shiftKey
          ? tabs[(i - 1 + len) % len]!
          : tabs[(i + 1) % len]!;
        ws.activateInPane(ws.focusedPaneId, next);
        return;
      }

      if (!mod) return;

      // Cmd/Ctrl+Alt+Arrow — move focus between panes (tree order).
      if (
        e.altKey &&
        (e.key === "ArrowLeft" ||
          e.key === "ArrowRight" ||
          e.key === "ArrowUp" ||
          e.key === "ArrowDown")
      ) {
        const ids = ws.leaves.map((l) => l.id);
        if (ids.length < 2) return;
        e.preventDefault();
        const i = ids.indexOf(ws.focusedPaneId);
        const forward = e.key === "ArrowRight" || e.key === "ArrowDown";
        const next = ids[(i + (forward ? 1 : -1) + ids.length) % ids.length]!;
        ws.focusPane(next);
        return;
      }

      switch (e.key) {
        case "t":
        case "T":
          e.preventDefault();
          void ctx.createAndStartRename().catch(() => {});
          return;
        case "w":
        case "W": {
          const a = ws.focusedLeaf.activeTab;
          if (a === null) return;
          e.preventDefault();
          ws.closeTabInPane(ws.focusedPaneId, a);
          return;
        }
        case "\\":
          e.preventDefault();
          ws.splitFocused(e.shiftKey ? "column" : "row");
          return;
        default:
          return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [ws, ctx]);
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
  if (collapsed) return null;
  return (
    <div
      style={{
        position: "relative",
        width,
        flexShrink: 0,
        display: "flex",
        minHeight: 0,
      }}
    >
      {children}
      <ResizeHandle
        side={side}
        width={width}
        min={min}
        max={max}
        containerRef={containerRef}
        onResize={onResize}
        onToggleCollapse={onToggleCollapse}
        label={resizeLabel}
      />
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
  saveStatus: SaveStatusValue;
  onRetry: () => void;
  /** Hide the save-status badge entirely when no note is selected
   *  (the indicator would otherwise read "Saved" / a stale relative-
   *  time from the previous note and confuse the user). */
  hideSaveStatus?: boolean;
  /** Body word count of the active note (frontmatter excluded). `null`
   *  hides the counter entirely — same rationale as `hideSaveStatus`:
   *  with no note selected the value would be a meaningless 0. */
  wordCount?: number | null;
}

function BottomBar({
  onLockFlushed,
  onOpenSettings,
  onShowGraph,
  saveStatus,
  onRetry,
  hideSaveStatus = false,
  wordCount = null,
}: BottomBarProps) {
  const handleLockClick = () => {
    void onLockFlushed().catch(() => {
      /* lock flush failures already routed through saveStatus */
    });
  };

  return (
    <div
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
      <span style={STATUS_TEXT_STYLE}>Local-only · not synced</span>
      <div style={{ flex: 1 }} />
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {!hideSaveStatus && <SaveStatusBadge status={saveStatus} onRetry={onRetry} />}
        {onShowGraph && (
          <button
            type="button"
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
        <button
          type="button"
          onClick={handleLockClick}
          aria-label="Vault'u kilitle"
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
        {wordCount !== null && (
          <span
            style={{
              ...STATUS_TEXT_STYLE,
              fontFamily: "var(--font-mono)",
            }}
          >
            {wordCount} {wordCount === 1 ? "word" : "words"}
          </span>
        )}
      </div>
    </div>
  );
}
