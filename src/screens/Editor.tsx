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
import { CMEditor } from "../editor/CMEditor";
import { extractFullText } from "../dialect";
import { CommandPalette } from "../components/CommandPalette";
import type { CommandContext } from "../commands";
import { FailClosedError } from "../components/FailClosedError";
import { Icon } from "../components/primitives/Icon";
import { IconButton } from "../components/primitives/IconButton";
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
import { noteRead } from "../notes/readNote";
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
import { useAutosave, type SaveStatus as SaveStatusValue } from "../notes/useAutosave";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import { useActivityHeartbeat } from "../hooks/useActivityHeartbeat";
import { ResizeHandle } from "../components/primitives/ResizeHandle";
import { useEditorLayout } from "./editorLayout";
import { LEFT_BOUNDS, RIGHT_BOUNDS } from "./layoutClamp";
import { AttachmentsLibrary } from "../components/attachments/AttachmentsLibrary";
import { CenterViewProvider, type CenterView } from "./centerView";


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

/**
 * Word count of a note body, frontmatter excluded. `extractFullText`
 * strips the YAML frontmatter block + decoration syntax (code URLs,
 * wikilink targets behind aliases) and collapses whitespace to single
 * spaces, so a plain space-split yields the body word count. Empty body
 * → 0 (a bare split would otherwise return `[""]`, miscounting as 1).
 */
function countBodyWords(content: string): number {
  const text = extractFullText(content);
  return text.length === 0 ? 0 : text.split(" ").length;
}

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
        <EditorChrome
          onLock={onLock}
          onForceRelock={onForceRelock}
          onDeleteVaultSuccess={onDeleteVaultSuccess}
          onSwitchVault={onSwitchVault}
          onCreateAnother={onCreateAnother}
          switching={switching}
          settingsOpen={settingsOpen}
          setSettingsOpen={setSettingsOpen}
          toastMessage={toastMessage}
          setToastMessage={setToastMessage}
        />
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
  setSettingsOpen,
  toastMessage,
  setToastMessage,
}: EditorChromeProps) {
  const ctx = useSelectedNote();
  const [content, setContent] = useState<string>("");
  const [bodyLoading, setBodyLoading] = useState<boolean>(false);
  const [paletteOpen, setPaletteOpen] = useState<boolean>(false);
  const [templatesOpen, setTemplatesOpen] = useState<boolean>(false);
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
  const [wordCount, setWordCount] = useState<number>(0);
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

  // Status-bar word counter — recompute on a short debounce so the parse
  // doesn't run on every keystroke. Frontmatter is excluded by
  // `countBodyWords`. Note-switch flows through `content` too (the
  // selection effect resets it), so the counter follows the active note.
  useEffect(() => {
    const handle = setTimeout(() => {
      setWordCount(countBodyWords(content));
    }, 200);
    return () => clearTimeout(handle);
  }, [content]);

  // Selection-change → load body via `noteRead`. The ID is the
  // canonical reload trigger; if it stays stable across renders we
  // never re-fetch. Race protection: a pending fetch that resolves
  // AFTER a newer selection is dropped via the `cancelled` flag.
  useEffect(() => {
    let cancelled = false;
    const id = ctx.selectedId;
    if (id === null) {
      setContent("");
      setBodyLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setBodyLoading(true);
    void (async () => {
      try {
        const body = await noteRead(id);
        if (!cancelled) {
          setContent(body);
          setBodyLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setContent("");
          setBodyLoading(false);
        }
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn("[Editor] noteRead failed:", err);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ctx.selectedId]);

  // Re-sync the open note's body when a sidebar action mutates it on
  // disk (today: rename of the currently-open note — MYND-140). Without
  // this, the editor's local `content` stays stale after a rename and the
  // next autosave writes the old title back, silently reverting the
  // rename. Keyed on the nonce only (not `selectedId` — plain selection
  // changes flow through the load effect above); skips the initial mount.
  const reloadNonce = ctx.contentReloadNonce;
  const reloadInitRef = useRef(true);
  useEffect(() => {
    if (reloadInitRef.current) {
      reloadInitRef.current = false;
      return;
    }
    const id = ctx.selectedId;
    if (id === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const body = await noteRead(id);
        if (!cancelled) setContent((prev) => (prev === body ? prev : body));
      } catch (err) {
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn("[Editor] content re-sync after rename failed:", err);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // selectedId is read at fire time intentionally; nonce is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadNonce]);

  const autosave = useAutosave(ctx.selectedId, content, undefined, setContent);

  // MYND-121 — report window-level activity to the backend auto-lock idle
  // timer. The Editor is mounted iff the vault is Unlocked, so the heartbeat
  // runs exactly while a lockable session is live.
  useActivityHeartbeat();

  // After every successful save, refresh the sidebar entry for that
  // note so a title/H1 edit in the editor body propagates to the row
  // label (Q13 "action-driven surgical refresh after saveNote"). We
  // track the `saved.at` timestamp identity so re-renders don't
  // re-fire — `useAutosave` produces a new `saved` object only when
  // an IPC actually completes successfully.
  const lastRefreshedAtRef = useRef<number>(0);
  useEffect(() => {
    if (autosave.status.status !== "saved") return;
    const at = autosave.status.at.getTime();
    if (at === lastRefreshedAtRef.current) return;
    lastRefreshedAtRef.current = at;
    const id = ctx.selectedId;
    if (id === null) return;
    void ctx.refreshOne(id).catch(() => {
      /* refresh failure is non-fatal — sidebar shows stale title until next refresh */
    });
  }, [autosave.status, ctx]);

  // T28 — Tauri close-intercept. Block window close until any pending
  // save flushes. Uses the `tauri::api::webviewWindow` listener; safe
  // to no-op when running outside Tauri (browser dev fallback).
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
          try {
            await autosave.flushIfDirty();
          } catch (err) {
            if (import.meta.env.DEV) {
              // eslint-disable-next-line no-console
              console.warn("[Editor] flushIfDirty on close failed:", err);
            }
            // Surface the failure to the user — but for v0.1 we close
            // anyway since blocking forever is worse UX. T31 manual
            // smoke can revisit the close-fail alert dialog.
          }
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
  }, [autosave]);

  // MYND-121 — flush on idle-lock imminent. The backend idle timer emits
  // `vault-lock-imminent` before its grace window; flush any unsaved edit so
  // the autosave delta persists before the keys zeroize. Best-effort — the
  // backend proceeds when the grace elapses regardless. Mirrors the
  // close-intercept's listen / unlisten + cancelled-guard shape; no-op outside
  // Tauri (browser dev shim).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const handle = await listen("vault-lock-imminent", () => {
          if (cancelled) return;
          void autosave.flushIfDirty().catch(() => {
            /* per-flush error already routed through saveStatus */
          });
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
  }, [autosave]);

  // T29 — fire-on-blur. When the editor body loses focus (Tab away to
  // sidebar / another app / Settings modal), trigger an immediate flush.
  // Fire-and-forget; the autosave latest-wins gate handles in-flight
  // overlap.
  const handleEditorBlur = useCallback(() => {
    void autosave.flushIfDirty().catch(() => {
      /* per-flush error already routed through saveStatus */
    });
  }, [autosave]);

  // Lock button flush-then-lock — `decisions.md` 2026-05-07 canonical
  // flush-on-lock. The BottomBar's existing onLock handler fires
  // `lockVault()` then the parent's callback; we wrap with a flush
  // pre-step.
  const handleLockFlushed = useCallback(async () => {
    try {
      await autosave.flushIfDirty();
    } catch (err) {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn("[Editor] flushIfDirty on lock failed:", err);
      }
    }
    await lockVault().catch(() => {
      /* lock is best-effort, parent callback still fires */
    });
    onLock?.();
  }, [autosave, onLock]);

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
      <div
        ref={rowRef}
        style={{
          display: "flex",
          flexDirection: "row",
          flex: 1,
          minHeight: 0,
        }}
      >
        <SidebarBootstrap />
        <SidebarPane
          side="left"
          width={layout.leftWidth}
          collapsed={layout.leftCollapsed}
          min={LEFT_BOUNDS.min}
          max={LEFT_BOUNDS.max}
          containerRef={rowRef}
          onResize={layout.setLeftWidth}
          onToggleCollapse={layout.toggleLeftCollapsed}
          resizeLabel="Resize notes sidebar"
          expandLabel="Expand notes sidebar"
        >
          <NotesSidebarList
            onCollapse={layout.toggleLeftCollapsed}
            onNewFromTemplate={() => setNewFromTemplateOpen(true)}
            onSwitchVault={onSwitchVault}
            onCreateAnother={onCreateAnother}
            switching={switching}
          />
        </SidebarPane>
        {centerView === "attachments" ? (
          <AttachmentsLibrary onClose={() => setCenterView("editor")} />
        ) : (
        <CenterPane
          content={content}
          onChange={setContent}
          onBlur={handleEditorBlur}
          loading={bodyLoading}
          hasSelection={ctx.selectedId !== null}
          noteTitle={
            ctx.selectedId === null
              ? null
              : ctx.cache.get(ctx.selectedId)?.title ?? null
          }
          onCreateNote={() => {
            void ctx.createAndStartRename().catch(() => {});
          }}
        />
        )}
        <SidebarPane
          side="right"
          width={layout.rightWidth}
          collapsed={layout.rightCollapsed}
          min={RIGHT_BOUNDS.min}
          max={RIGHT_BOUNDS.max}
          containerRef={rowRef}
          onResize={layout.setRightWidth}
          onToggleCollapse={layout.toggleRightCollapsed}
          resizeLabel="Resize backlinks sidebar"
          expandLabel="Expand backlinks sidebar"
        >
          <RightSidebar onCollapse={layout.toggleRightCollapsed} />
        </SidebarPane>
      </div>
      <BottomBar
        onOpenSettings={() => setSettingsOpen(true)}
        onShowGraph={() => setGraphOpen(true)}
        onLockFlushed={handleLockFlushed}
        saveStatus={autosave.status}
        onRetry={autosave.retry}
        hideSaveStatus={ctx.selectedId === null}
        wordCount={ctx.selectedId === null ? null : wordCount}
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
      />
      <CommandPaletteHotkey onToggle={() => setPaletteOpen((v) => !v)} />
      <Toast message={toastMessage} onDone={() => setToastMessage(null)} />
    </div>
    </CenterViewProvider>
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
  onLockFlushed: () => Promise<void>;
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
  onLockFlushed,
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

interface CenterPaneProps {
  content: string;
  onChange: (next: string) => void;
  onBlur: () => void;
  loading: boolean;
  hasSelection: boolean;
  noteTitle: string | null;
  onCreateNote: () => void;
}

function CenterPane({
  content,
  onChange,
  onBlur,
  loading,
  hasSelection,
  noteTitle,
  onCreateNote,
}: CenterPaneProps) {
  const isTitleEmpty = noteTitle === null || noteTitle.trim() === "";
  const headerLabel = !hasSelection ? "" : isTitleEmpty ? "Untitled" : noteTitle;
  const headerIsItalic = hasSelection && isTitleEmpty;
  return (
    <main
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          height: 38,
          padding: "0 16px",
          display: "flex",
          alignItems: "center",
          borderBottom: "1px solid var(--line-1)",
          fontSize: 12,
          color: "var(--fg-2)",
          fontStyle: headerIsItalic ? "italic" : "normal",
        }}
      >
        {headerLabel}
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          padding: "12px 24px 32px",
        }}
      >
        {!hasSelection ? (
          <CenterPaneEmpty onCreateNote={onCreateNote} />
        ) : loading ? (
          <CenterPaneLoading />
        ) : (
          <div style={{ maxWidth: 680, margin: "0 auto" }}>
            <CMEditor
              value={content}
              onChange={onChange}
              onBlur={onBlur}
              style={{
                width: "100%",
                minHeight: 360,
                color: "var(--fg-1)",
                fontFamily: "var(--font-mono)",
                fontSize: 14,
                lineHeight: 1.7,
              }}
            />
          </div>
        )}
      </div>
    </main>
  );
}

function CenterPaneEmpty({ onCreateNote }: { onCreateNote: () => void }) {
  return (
    <div
      style={{
        maxWidth: 680,
        margin: "10vh auto 0",
        textAlign: "center",
        color: "var(--fg-3)",
        fontFamily: "var(--font-sans)",
      }}
    >
      <div style={{ fontSize: 14, marginBottom: 14 }}>
        Select a note from the sidebar, or
      </div>
      <button
        type="button"
        onClick={onCreateNote}
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 13,
          fontWeight: 500,
          color: "var(--accent-on)",
          background: "var(--accent)",
          border: 0,
          padding: "10px 14px",
          borderRadius: 6,
          cursor: "pointer",
        }}
      >
        + Create a new note
      </button>
    </div>
  );
}

function CenterPaneLoading() {
  return (
    <div
      style={{
        maxWidth: 680,
        margin: "10vh auto 0",
        textAlign: "center",
        color: "var(--fg-3)",
        fontSize: 13,
        fontFamily: "var(--font-sans)",
      }}
    >
      Loading…
    </div>
  );
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
function RightSidebar({ onCollapse }: { onCollapse?: () => void }) {
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
        width: "100%",
        background: "var(--paper-2)",
        borderLeft: "1px solid var(--line-1)",
        padding: "16px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={SECTION_HEADING_STYLE}>Linked from {rows.length}</div>
        {onCollapse && (
          <IconButton
            icon="panel-right-close"
            label="Collapse backlinks sidebar"
            onClick={onCollapse}
          />
        )}
      </div>
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
 * One resizable/collapsible sidebar slot (MYND-137). When collapsed, renders
 * the {@link CollapsedRail}; otherwise a width-driven `position: relative`
 * wrapper holding the sidebar `children` plus the inner-edge {@link ResizeHandle}
 * (the handle is absolutely positioned, so child order is irrelevant). Both the
 * left (notes) and right (backlinks) panes are this same component, mirrored by
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
  expandLabel,
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
  expandLabel: string;
  children: ReactNode;
}) {
  if (collapsed) {
    return (
      <CollapsedRail side={side} label={expandLabel} onExpand={onToggleCollapse} />
    );
  }
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
 * Thin re-expand rail shown in place of a collapsed sidebar (MYND-137) so a
 * fully-hidden pane stays recoverable. A 14px `--paper-2` strip with the
 * sidebar's hairline border and an inward-pointing chevron near the top;
 * clicking (or Enter/Space) re-expands the pane to its remembered width.
 */
function CollapsedRail({
  side,
  label,
  onExpand,
}: {
  side: "left" | "right";
  label: string;
  onExpand: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onExpand}
      aria-label={label}
      title={label}
      style={{
        width: 14,
        flexShrink: 0,
        background: "var(--paper-2)",
        border: 0,
        ...(side === "left"
          ? { borderRight: "1px solid var(--line-1)" }
          : { borderLeft: "1px solid var(--line-1)" }),
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        paddingTop: 16,
        color: "var(--fg-3)",
        cursor: "pointer",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--paper-3)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "var(--paper-2)";
      }}
    >
      <Icon name={side === "left" ? "chevron-right" : "chevron-left"} size={14} />
    </button>
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
