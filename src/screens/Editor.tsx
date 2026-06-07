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
import { CMEditor } from "../editor/CMEditor";
import { extractFullText } from "../dialect";
import { CommandPalette } from "../components/CommandPalette";
import type { CommandContext } from "../commands";
import { FailClosedError } from "../components/FailClosedError";
import { Icon } from "../components/primitives/Icon";
import { IconButton } from "../components/primitives/IconButton";
import { SettingsModal } from "../components/SettingsModal";
import { TemplatesManager } from "../components/TemplatesManager";
import { NewNoteFromTemplateModal } from "../components/NewNoteFromTemplateModal";
import { Toast } from "../components/Toast";
import { isVaultUnlocked, lockVault } from "../lib/vault-unlock";
import type { StageVaultStatus, SuspicionReason } from "../lib/stage";
import {
  noteList,
  loadNoteBatch,
  createNoteFromTemplate,
  createBlankNamedNote,
  resolveTodayNote,
} from "../notes";
import { prefsRead } from "../lib/prefs";
import { NoteList as NotesSidebarList } from "../notes/components/NoteList";
import { SECTION_HEADING_STYLE } from "../notes/components/sharedStyles";
import { noteRead } from "../notes/readNote";
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


const STATUS_TEXT_STYLE: CSSProperties = {
  fontSize: 12,
  color: "var(--fg-3)",
};

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
      <EditorChrome
        onLock={onLock}
        onForceRelock={onForceRelock}
        onDeleteVaultSuccess={onDeleteVaultSuccess}
        settingsOpen={settingsOpen}
        setSettingsOpen={setSettingsOpen}
        toastMessage={toastMessage}
        setToastMessage={setToastMessage}
      />
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
  settingsOpen: boolean;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  toastMessage: string | null;
  setToastMessage: Dispatch<SetStateAction<string | null>>;
};

function EditorChrome({
  onLock,
  onForceRelock,
  onDeleteVaultSuccess,
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
  const [newFromTemplateOpen, setNewFromTemplateOpen] = useState<boolean>(false);
  const [wordCount, setWordCount] = useState<number>(0);

  // Resizable/collapsible sidebar layout (MYND-137). Widths + collapse
  // flags are persisted to vault.prefs and clamped on load; `rowRef`
  // measures the three-pane row live so a drag honors the center-pane
  // minimum.
  const layout = useEditorLayout();
  const rowRef = useRef<HTMLDivElement | null>(null);

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

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--bg-1)",
        flex: 1,
        minHeight: 0,
      }}
    >
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
          />
        </SidebarPane>
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
      <CommandPaletteHost
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
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
        onLockFlushed={async () => {
          setPaletteOpen(false);
          await handleLockFlushed();
        }}
      />
      <CommandPaletteHotkey onToggle={() => setPaletteOpen((v) => !v)} />
      <Toast message={toastMessage} onDone={() => setToastMessage(null)} />
    </div>
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
  onManageTemplates: () => void;
  onNewNoteFromTemplate: () => void;
  onLockFlushed: () => Promise<void>;
};

function CommandPaletteHost({
  open,
  onClose,
  onOpenSettings,
  onManageTemplates,
  onNewNoteFromTemplate,
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

function RightSidebar({ onCollapse }: { onCollapse?: () => void }) {
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
        <div style={SECTION_HEADING_STYLE}>Backlinks</div>
        {onCollapse && (
          <IconButton
            icon="panel-right-close"
            label="Collapse backlinks sidebar"
            onClick={onCollapse}
          />
        )}
      </div>
      <div style={{ fontSize: 12, color: "var(--fg-3)" }}>Linked from 0</div>
      <div style={{ fontSize: 13, color: "var(--fg-3)", marginTop: 4 }}>
        No backlinks yet.
      </div>
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

interface BottomBarProps {
  /** Lock callback that awaits the autosave flush before firing
   *  `lockVault()` and the parent's onLock — wired by `EditorChrome`. */
  onLockFlushed: () => Promise<void>;
  onOpenSettings?: () => void;
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
