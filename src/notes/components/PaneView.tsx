// `<PaneView>` — one leaf pane of the editor workspace (MYND-166, Task 4).
//
// Each visible pane owns its OWN content state + `useAutosave` loop for its
// active tab's note, so two panes can show two different notes side by
// side. The pane registers its `flushIfDirty` in the workspace flush
// registry so the chrome's lock / close / blur hooks flush every pane, not
// just one. When the pane has no active tab it renders the
// empty-editor-shell (frame `MYND-166 · B3`); the last pane can't be closed,
// so this is where a fully-closed workspace lands.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
} from "react";
import { CMEditor, type ScrollAnchorRequest } from "../../editor/CMEditor";
import { asViewMode, type ViewMode } from "../../editor/view-mode";

/** Stable no-op onChange for the read-only preview companion (MYND-299) — a fresh
 *  arrow each render would rebuild nothing here, but a module const keeps it tidy. */
const NOOP_ON_CHANGE = (_next: string): void => {};
import { hasAnchor, type WikilinkAnchor } from "../../editor/wikilink/anchor";
import { noteRead } from "../readNote";
import { createNote } from "../createNote";
import { useSelectedNote, type NoteId } from "../sidebarState";
import { useResolverNotes } from "../resolverNotes";
import { useIndexNonce } from "../indexNonce";
import { useVaultHeadings } from "../useVaultHeadings";
import { useWorkspace } from "../workspaceContext";
import { usePrefs } from "../../hooks/usePrefs";
import { typographyStyle } from "../../editor/typography";
import { useAutosave, type SaveStatus } from "../useAutosave";
import { computeDocStats, statsOfPlain, type DocStats } from "../documentStats";
import {
  itemKey,
  parseItemKey,
  type LeafPane,
  type SplitDirection,
} from "../workspaceState";
import { TAB_DRAG_MIME, readTabDrag } from "../tabDrag";
import { NewTabChooser } from "./NewTabChooser";
import { GraphPane } from "./GraphView";
import { TabStrip, STRIP_HEIGHT } from "./TabStrip";
import { useViewResult } from "../views/useViewResult";
import { ViewRenderHost } from "../views/viewRenderHost";
import { resolveCoverAttachmentId } from "../views/cardsView";
import { setNoteCover } from "../setNoteCover";
import { upsertSavedView } from "../../lib/prefs";
import { CoverPicker, type CoverChoice } from "../../components/attachments/CoverPicker";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { buildCardMenuItems } from "../views/cardMenu";
import { writeText as clipboardWriteText } from "@tauri-apps/plugin-clipboard-manager";

export type PaneReadout = {
  status: SaveStatus;
  /** Whole-note statistics of the active note; `null` when the pane is empty. */
  stats: DocStats | null;
  /** Statistics of the current non-empty selection; `null` when nothing is
   *  selected (the readout then shows whole-note `stats`). */
  selectionStats: DocStats | null;
  retry: () => void;
};

// ── Drag-to-split drop zones (MYND-166 behavioral pass) ──────────────
//
// Dropping a tab (or a sidebar note) onto a pane body splits along the
// edge the cursor lands on, or — in the center band — adds it as a tab.
// Geometry only: which quadrant/edge is nearest, with a 25% edge band; a
// drop further than that from every edge is "center".

type DropZone = "left" | "right" | "top" | "bottom" | "center";

function computeDropZone(x: number, y: number, rect: DOMRect): DropZone {
  if (rect.width <= 0 || rect.height <= 0) return "center";
  const dist = {
    left: (x - rect.left) / rect.width,
    right: (rect.right - x) / rect.width,
    top: (y - rect.top) / rect.height,
    bottom: (rect.bottom - y) / rect.height,
  };
  let zone: DropZone = "center";
  let min = 0.25; // edge-band depth (fraction of the pane)
  for (const edge of ["left", "right", "top", "bottom"] as const) {
    if (dist[edge] < min) {
      min = dist[edge];
      zone = edge;
    }
  }
  return zone;
}

function zoneToSplit(zone: "left" | "right" | "top" | "bottom"): {
  direction: SplitDirection;
  side: "before" | "after";
} {
  switch (zone) {
    case "left":
      return { direction: "row", side: "before" };
    case "right":
      return { direction: "row", side: "after" };
    case "top":
      return { direction: "column", side: "before" };
    case "bottom":
      return { direction: "column", side: "after" };
  }
}

function zoneHighlightStyle(zone: DropZone): CSSProperties {
  switch (zone) {
    case "left":
      return { left: 0, top: 0, width: "50%", height: "100%" };
    case "right":
      return { right: 0, top: 0, width: "50%", height: "100%" };
    case "top":
      return { left: 0, top: 0, width: "100%", height: "50%" };
    case "bottom":
      return { left: 0, bottom: 0, width: "100%", height: "50%" };
    case "center":
      return { inset: 0 };
  }
}

type PaneViewProps = {
  leaf: LeafPane;
  focused: boolean;
  /** Reported (only while this pane is focused) up to the bottom bar. */
  onReadout: (r: PaneReadout) => void;
  /** Extra strip left/right padding when this pane sits at a top window
   *  corner with that side's sidebar closed (clears the window controls). */
  insetLeft?: number;
  insetRight?: number;
};

export function PaneView({
  leaf,
  focused,
  onReadout,
  insetLeft = 0,
  insetRight = 0,
}: PaneViewProps) {
  const ws = useWorkspace();
  const ctx = useSelectedNote();
  const { prefs } = usePrefs();
  // This pane is the note-editor host: it tracks only a NOTE active tab. A
  // view-kind active tab (MYND-274) maps to `null` here (no note body) until
  // the dedicated view host lands in #4 task 2; view tabs cannot yet be opened.
  const activeId: NoteId | null =
    leaf.activeTab?.kind === "note" ? leaf.activeTab.id : null;
  // A view-kind active tab renders the view host (MYND-274) instead of the
  // note editor; `activeViewId` is non-null exactly then.
  const activeViewId: string | null =
    leaf.activeTab?.kind === "view" ? leaf.activeTab.id : null;
  // reading-source-modes (MYND-299): the effective view mode for this pane's
  // note tab — the tab's own per-tab mode if set, else the global
  // `editor_default_view_mode` pref, else `live`. Drives the CMEditor below
  // (re-mount-free reconfigure on change).
  const defaultViewMode: ViewMode = asViewMode(prefs.editor_default_view_mode);
  const effectiveViewMode: ViewMode =
    leaf.activeTab?.kind === "note" && leaf.activeTab.viewMode
      ? leaf.activeTab.viewMode
      : defaultViewMode;
  // A graph-kind active tab renders the whole-vault graph pane (MYND-198) in
  // place of the note editor — a first-class tab, no longer a modal carve-out.
  const isGraph = leaf.activeTab?.kind === "graph";
  // WL-5/WL-6: the live resolver note-set fed into this pane's editor so wikilink
  // chips resolve (broken-link styling + hover R1). Re-feed a fresh reference on
  // every SYNC-5 index-change nonce so a note created/renamed/loaded elsewhere
  // re-resolves the chips live — `useResolverNotes` alone only changes on a cache
  // ref change, which can miss the async post-unlock index populate (the "linked
  // but looks broken on reload" case).
  const liveNotes = useResolverNotes();
  const indexNonce = useIndexNonce();
  const notes = useMemo(() => liveNotes.slice(), [liveNotes, indexNonce]);
  // MYND-305: the vault-wide heading set the `[[##` autocomplete searches (built
  // lazily by reading note bodies; rebuilt on the index nonce). Empty until the
  // first async build settles — `[[##` simply finds nothing until then.
  const vaultHeadings = useVaultHeadings();
  // Click-to-navigate target for a resolved wikilink chip → open the note, and
  // (MYND-305) carry the GENERIC deep-link anchor so the editor scrolls to the
  // `#heading` / imported `^block-id` AFTER the note body loads. A click focuses
  // this pane (`onMouseDownCapture`), so the resolved note opens HERE; the
  // pending request is consumed by the CMEditor below once `activeId` matches and
  // its body settles. The nonce bumps per click so re-clicking the same anchor
  // re-fires the scroll.
  const [scrollAnchor, setScrollAnchor] = useState<ScrollAnchorRequest>(null);
  // reading-source-modes (MYND-299): side-by-side preview companion — a PaneView-
  // local, read-only Reading mirror of the SAME `content` buffer. It is NOT a
  // workspace item (the global duplicate-forbid `(kind,id)` invariant is
  // untouched) and writes nothing (this PaneView stays the single autosave owner).
  // The side-by-side preview companion (MYND-299) is ephemeral per-pane state in
  // the workspace context (shared with the bottom-bar "Preview" toggle). Only
  // meaningful in SOURCE mode — live renders inline, reading IS the rendered view,
  // so a companion left open auto-hides when you leave source.
  const companionOpen = ws.isCompanionOpen(leaf.id);
  const companionVisible = companionOpen && effectiveViewMode === "source";
  const pendingAnchorTargetRef = useRef<NoteId | null>(null);
  const handleOpenWikilink = useCallback(
    (noteUuid: string, anchor: WikilinkAnchor | null) => {
      if (anchor !== null && hasAnchor(anchor)) {
        pendingAnchorTargetRef.current = noteUuid as NoteId;
        setScrollAnchor({ anchor, nonce: Date.now() });
      }
      void ctx.open(noteUuid as NoteId);
    },
    [ctx],
  );
  // Only feed the pending scroll into the editor once THIS pane is actually
  // showing the deep-link target (the body-load effect keys on `activeId`); a
  // stale request for a different note is dropped so we never scroll the wrong
  // note.
  const activeScrollAnchor =
    scrollAnchor !== null && pendingAnchorTargetRef.current === activeId
      ? scrollAnchor
      : null;

  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);

  // Load the active note's body on change. Race-protected: a fetch that
  // resolves after a newer activation is dropped via `cancelled`.
  useEffect(() => {
    let cancelled = false;
    if (activeId === null) {
      setContent("");
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setLoading(true);
    void (async () => {
      try {
        const body = await noteRead(activeId);
        if (!cancelled) {
          setContent(body);
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setContent("");
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  const autosave = useAutosave(activeId, content, undefined, setContent);

  // Re-sync this pane's body when the open note is renamed on disk
  // (MYND-140) — only relevant when this pane shows the note the sidebar
  // acted on (`selectedId`). Skips the initial mount.
  const reloadNonce = ctx.contentReloadNonce;
  const reloadInit = useRef(true);
  useEffect(() => {
    if (reloadInit.current) {
      reloadInit.current = false;
      return;
    }
    if (activeId === null || activeId !== ctx.selectedId) return;
    let cancelled = false;
    void (async () => {
      try {
        const body = await noteRead(activeId);
        if (!cancelled) setContent((prev) => (prev === body ? prev : body));
      } catch {
        /* re-sync failure is non-fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
    // nonce is the trigger; activeId/selectedId read at fire time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadNonce]);

  // Register this pane's flush so the chrome can flush every pane on
  // lock / close / quit.
  const { registerFlush, unregisterFlush } = ws;
  const flushIfDirty = autosave.flushIfDirty;
  useEffect(() => {
    registerFlush(leaf.id, flushIfDirty);
    return () => unregisterFlush(leaf.id);
  }, [leaf.id, flushIfDirty, registerFlush, unregisterFlush]);

  // Surgical sidebar refresh after a successful save (title/H1 edits
  // propagate to the row label). Tracks the `saved.at` identity.
  const lastRefreshedAt = useRef<number>(0);
  useEffect(() => {
    if (autosave.status.status !== "saved") return;
    const at = autosave.status.at.getTime();
    if (at === lastRefreshedAt.current) return;
    lastRefreshedAt.current = at;
    if (activeId === null) return;
    void ctx.refreshOne(activeId).catch(() => {});
  }, [autosave.status, ctx, activeId]);

  // Document statistics (MYND-339): whole-doc (debounced from content) +
  // selection-scoped (from the CMEditor selection seam). Reported up only while
  // focused. Whole-doc stats are seeded synchronously so the readout doesn't
  // flash empty for the first 200ms after a note load.
  const [stats, setStats] = useState<DocStats | null>(() => computeDocStats(content));
  useEffect(() => {
    const h = setTimeout(() => setStats(computeDocStats(content)), 200);
    return () => clearTimeout(h);
  }, [content]);

  const [selectedText, setSelectedText] = useState("");
  const handleSelectionChange = useCallback((t: string) => setSelectedText(t), []);
  const [selectionStats, setSelectionStats] = useState<DocStats | null>(null);
  useEffect(() => {
    const h = setTimeout(
      () => setSelectionStats(selectedText === "" ? null : statsOfPlain(selectedText)),
      150,
    );
    return () => clearTimeout(h);
  }, [selectedText]);

  const retry = autosave.retry;
  const status = autosave.status;
  useEffect(() => {
    if (!focused) return;
    onReadout({
      status,
      stats: activeId === null ? null : stats,
      selectionStats: activeId === null ? null : selectionStats,
      retry,
    });
  }, [focused, status, stats, selectionStats, activeId, retry, onReadout]);

  const handleBlur = useCallback(() => {
    void autosave.flushIfDirty().catch(() => {});
  }, [autosave]);

  // "+ new tab" / empty-pane chooser (MYND-166). The "+" no longer force-
  // creates a note — it opens an empty "New tab" whose body lets the user
  // search/pick an existing note or create a fresh one. A tabless pane shows
  // the same chooser. Pending state lives in the WORKSPACE (`ws.beginNewTab`)
  // — not PaneView-local — so a sidebar click (routed through
  // `ws.openInFocused`) appends into the new tab instead of replacing the
  // previously-active one.
  const pendingNewTab = ws.pendingNewTabPaneId === leaf.id;
  const clearPending = ws.cancelNewTab;

  const onPickNote = useCallback(
    (id: NoteId) => {
      ws.openNewTabInFocused(id);
    },
    [ws],
  );

  const onCreateNote = useCallback(() => {
    void (async () => {
      try {
        // `createNote` (not `ctx.createAndStartRename`) so the note is NOT
        // auto-selected — that would route through Editor.tsx's bridge A and
        // open it in the focused pane's ACTIVE slot (reuse), defeating the
        // new-tab intent. Open it explicitly into a new tab, then rename.
        const id = await createNote(null);
        ws.openNewTabInFocused(id);
        await ctx.refreshOne(id).catch(() => {});
        ctx.startRename(id);
      } catch {
        /* creation failure surfaces via the sidebar UX on next refresh */
      }
    })();
  }, [ws, ctx]);

  const focusThisPane = useCallback(() => {
    if (!focused) ws.focusPane(leaf.id);
  }, [focused, ws, leaf.id]);

  // ── Drag-to-split / drop-as-tab (MYND-166 behavioral pass) ──────────
  // `dragActive` mirrors a workspace-wide tab/note drag (tracked off the
  // window's dragstart/dragend); while it's on, each pane mounts a capture
  // overlay over its body so the drop lands on us, not on CodeMirror.
  // `dropZone` is the live target region under the cursor in THIS pane.
  const [dragActive, setDragActive] = useState(false);
  const [dropZone, setDropZone] = useState<DropZone | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onStart = (e: DragEvent) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes(TAB_DRAG_MIME)) {
        setDragActive(true);
      }
    };
    const onEnd = () => {
      setDragActive(false);
      setDropZone(null);
    };
    window.addEventListener("dragstart", onStart);
    window.addEventListener("dragend", onEnd);
    return () => {
      window.removeEventListener("dragstart", onStart);
      window.removeEventListener("dragend", onEnd);
    };
  }, []);

  const onOverlayDragOver = useCallback((e: ReactDragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes(TAB_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = overlayRef.current?.getBoundingClientRect();
    if (rect) setDropZone(computeDropZone(e.clientX, e.clientY, rect));
  }, []);

  const onOverlayDragLeave = useCallback((e: ReactDragEvent<HTMLDivElement>) => {
    // Only clear when the cursor genuinely leaves the overlay (moving between
    // children fires dragleave with a contained relatedTarget).
    const related = e.relatedTarget as Node | null;
    if (related === null || !e.currentTarget.contains(related)) {
      setDropZone(null);
    }
  }, []);

  const onOverlayDrop = useCallback(
    (e: ReactDragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = overlayRef.current?.getBoundingClientRect();
      const zone = rect ? computeDropZone(e.clientX, e.clientY, rect) : "center";
      setDropZone(null);
      setDragActive(false);
      const payload = readTabDrag(e.dataTransfer);
      if (payload === null) return;
      const item = parseItemKey(payload.tabId);
      if (zone === "center") {
        ws.dropItemOnPane(leaf.id, item, leaf.tabs.length);
      } else {
        const { direction, side } = zoneToSplit(zone);
        ws.splitPaneWithItem(leaf.id, direction, side, item);
      }
    },
    [ws, leaf.id, leaf.tabs.length],
  );

  // The "new tab" state: an empty pane (no active tab) OR an explicit "+ new
  // tab" both show the tab bar's New-tab chip + the chooser body. The tab bar
  // is ALWAYS displayed (MYND-166) — an empty/not-yet-focused pane just shows
  // it in its New-tab state.
  // Empty/chooser only when there is NO active tab at all — a view-active tab
  // is NOT a new-tab state (it renders the view host below).
  const inNewTabState = pendingNewTab || leaf.activeTab === null;

  const editorEl = useMemo(() => {
    if (inNewTabState) {
      return (
        <NewTabChooser
          onPick={onPickNote}
          onCreate={onCreateNote}
          cancellable={leaf.tabs.length > 0}
          onCancel={clearPending}
        />
      );
    }
    if (activeViewId !== null) {
      return <ViewHost viewId={activeViewId} />;
    }
    if (isGraph) {
      return <GraphPane />;
    }
    if (loading) {
      return <PaneLoading />;
    }
    return (
      // Editor-typography: the content max-width + the three CSS custom
      // properties (`--editor-text-size` / `--editor-line-spacing` /
      // `--editor-font-family`) come from `typographyStyle(prefs)`. The vars
      // inherit into the child `.cm-editor`, which reads them via
      // `var(--editor-*)` in `theme.ts` — so a preset change re-renders this
      // wrapper and updates the editor live (no CodeMirror remount).
      <div
        data-testid="editor.content-frame"
        style={
          companionVisible
            ? { ...typographyStyle(prefs), maxWidth: "none", margin: 0, display: "flex", gap: 16 }
            : { ...typographyStyle(prefs), margin: "0 auto" }
        }
      >
        <div style={{ minWidth: 0, flex: companionVisible ? 1 : undefined }}>
          <CMEditor
            value={content}
            onChange={setContent}
            onBlur={handleBlur}
            onSelectionChange={handleSelectionChange}
            noteSet={notes}
            vaultHeadings={vaultHeadings}
            onOpenWikilink={handleOpenWikilink}
            scrollAnchor={activeScrollAnchor}
            // editor-line-numbers (MYND-314): default OFF (prose-first); the open
            // editor reconfigures its line-number compartment live when the pref
            // flips (no remount). `prefs` is already a useMemo dep below.
            lineNumbers={prefs.editor_line_numbers === true}
            // reading-source-modes (MYND-299): per-tab live/reading/source. The
            // editor reconfigures its view-mode compartments live (no remount).
            viewMode={effectiveViewMode}
            style={{
              width: "100%",
              minHeight: 360,
              color: "var(--fg-1)",
            }}
          />
        </div>
        {companionVisible && (
          // Read-only Reading mirror of the same buffer (single autosave owner is
          // the primary editor above; this one never calls onChange).
          <div
            data-testid="editor.preview-companion"
            style={{ flex: 1, minWidth: 0, borderLeft: "1px solid var(--line-1)", paddingLeft: 16 }}
          >
            <CMEditor
              value={content}
              onChange={NOOP_ON_CHANGE}
              noteSet={notes}
              vaultHeadings={vaultHeadings}
              readOnly
              viewMode="reading"
              style={{ width: "100%", minHeight: 360, color: "var(--fg-1)" }}
            />
          </div>
        )}
      </div>
    );
  }, [
    prefs,
    effectiveViewMode,
    companionVisible,
    inNewTabState,
    activeViewId,
    isGraph,
    onPickNote,
    onCreateNote,
    clearPending,
    leaf.tabs.length,
    loading,
    content,
    handleBlur,
    handleSelectionChange,
    notes,
    vaultHeadings,
    handleOpenWikilink,
    activeScrollAnchor,
  ]);

  return (
    <section
      onMouseDownCapture={focusThisPane}
      data-testid="editor.pane"
      data-pane-id={leaf.id}
      data-focused={focused}
      style={{
        position: "relative",
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        // In a SPLIT, the focused pane gets a subtle top accent so you can
        // tell which pane the centralized top-bar tabs belong to. Inset shadow
        // → no layout shift. Suppressed for a single pane, where it would draw
        // a stray line under the tab strip and fight the connected-tab look.
        boxShadow:
          focused && ws.leaves.length > 1
            ? "inset 0 2px 0 0 var(--accent-soft)"
            : "none",
      }}
    >
      <TabStrip
        paneId={leaf.id}
        tabs={leaf.tabs.map(itemKey)}
        activeTab={
          inNewTabState || leaf.activeTab === null
            ? null
            : itemKey(leaf.activeTab)
        }
        // tab-modes (MYND-319/320): per-tab pin + per-leaf stacked layout. The
        // strip works in `itemKey` strings; resolve each back to its tab item.
        isPinned={(key) =>
          leaf.tabs.find((t) => itemKey(t) === key)?.pinned === true
        }
        onTogglePin={(key) => {
          const tab = leaf.tabs.find((t) => itemKey(t) === key);
          if (tab !== undefined) {
            ws.setItemPinned(leaf.id, tab, tab.pinned !== true);
          }
        }}
        stacked={leaf.stacked === true}
        titleOf={(key) => {
          const it = parseItemKey(key);
          if (it.kind === "note") return ctx.cache.get(it.id)?.title ?? null;
          // Graph tab: the whole-vault graph is a singleton with a fixed label.
          if (it.kind === "graph") return "Graph";
          // View tab: label by the saved view's name (MYND-274), not its raw id.
          // A blank name shows "Untitled view" (the sidebar's label rule); an
          // unknown id (a stale tab for a deleted view) falls back to null.
          const view = prefs.saved_views.find((v) => v.id === it.id);
          if (view === undefined) return null;
          return view.name.trim() === "" ? "Untitled view" : view.name;
        }}
        iconOf={(key) => {
          const kind = parseItemKey(key).kind;
          if (kind === "view") return "layout-grid";
          if (kind === "graph") return "share-2";
          return "file-text";
        }}
        activeDirty={
          status.status === "editing" ||
          status.status === "saving" ||
          status.status === "error"
        }
        pendingNewTab={pendingNewTab}
        onActivate={(key) => ws.activateItemInPane(leaf.id, parseItemKey(key))}
        onClose={(key) => ws.closeItemInPane(leaf.id, parseItemKey(key))}
        onNewTab={() => ws.beginNewTab(leaf.id)}
        onCloseNewTab={leaf.tabs.length > 0 ? clearPending : undefined}
        onMoveTab={(_fromPaneId, key, toIndex) =>
          ws.dropItemOnPane(leaf.id, parseItemKey(key), toIndex)
        }
        insetLeft={insetLeft}
        insetRight={insetRight}
      />
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          // No TOP padding here: this div is the scroll parent of the in-note
          // find bar's sticky top panel, and a top padding leaves a band above the
          // bar where scrolled text bleeds through (MYND-299 QA). The 12px top
          // breathing-room moves onto the inner wrapper below, so it scrolls UNDER
          // the now-flush sticky bar instead of opening a gap above it.
          padding: "0 24px 32px",
        }}
      >
        <div style={{ paddingTop: 12 }}>{editorEl}</div>
      </div>
      {dragActive && (
        // Capture overlay — only mounted during a tab/note drag, covering the
        // pane BODY (not the tab strip) so the drop lands here instead of
        // inside CodeMirror, while the strip stays free to receive reorder /
        // move drops on its own. The inner div is the live region highlight.
        <div
          ref={overlayRef}
          onDragOver={onOverlayDragOver}
          onDragLeave={onOverlayDragLeave}
          onDrop={onOverlayDrop}
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: STRIP_HEIGHT,
            bottom: 0,
            zIndex: 5,
          }}
        >
          {dropZone !== null && (
            <div
              style={{
                position: "absolute",
                ...zoneHighlightStyle(dropZone),
                background: "var(--accent-soft)",
                border: "2px solid var(--accent)",
                borderRadius: "var(--radius-1)",
                boxSizing: "border-box",
                pointerEvents: "none",
              }}
            />
          )}
        </div>
      )}
    </section>
  );
}

function PaneLoading() {
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
 * Host for an open saved-view tab (MYND-275, Saved Views #5). Resolves the
 * `viewId` to its `SavedView` def via prefs, runs the query engine over the
 * sidebar caches (`useViewResult`), and renders via the viewType dispatch
 * (`ViewRenderHost` → cards / table / list). No autosave / flush — views are
 * read-only projections, not editable buffers. Keeps the `editor.view-host`
 * testid wrapper (E2E #4 contract). While the result is loading (or the view id
 * is stale) the wrapper holds a calm, quiet body — no spinner churn.
 */
function ViewHost({ viewId }: { viewId: string }) {
  const { def, result } = useViewResult(viewId);
  const ws = useWorkspace();
  const sidebar = useSelectedNote();
  const [cardMenu, setCardMenu] = useState<{
    noteId: string;
    x: number;
    y: number;
  } | null>(null);
  // Card navigation reuses the workspace open seam — the same matrix NoteList
  // wires for a sidebar row (toSide → split, newTab → new tab, else focused).
  const onOpenNote = useCallback(
    (noteId: string, intent: { newTab: boolean; toSide: boolean }) => {
      if (intent.toSide) ws.openToSide(noteId);
      else if (intent.newTab) ws.openNewTabInFocused(noteId);
      else ws.openInFocused(noteId);
    },
    [ws],
  );
  const onCardContextMenu = useCallback(
    (noteId: string, pos: { x: number; y: number }) =>
      setCardMenu({ noteId, x: pos.x, y: pos.y }),
    [],
  );
  // Cover-image picker (Saved Views follow-on): a card's "Set cover" affordance
  // opens this picker for that note; the choice is written to the note's cover
  // frontmatter property. The property NAME is the view's `image` setting,
  // defaulting to `cover` on first use (and recorded onto the view so the cards
  // render reads it back).
  const [coverNoteId, setCoverNoteId] = useState<string | null>(null);
  const onSetCover = useCallback((noteId: string) => setCoverNoteId(noteId), []);
  const coverPropertyKey = def?.image ?? "cover";
  // Whether the picker's target note already has a resolvable cover (enables the
  // picker's "Remove cover" action). Scans the open view's result for that row.
  const coverTargetHasCover = useMemo(() => {
    if (coverNoteId === null || def?.image === undefined || result === null) {
      return false;
    }
    for (const group of result.groups) {
      for (const r of group.rows) {
        if (r.noteId === coverNoteId) {
          return resolveCoverAttachmentId(r.values[def.image]) !== null;
        }
      }
    }
    return false;
  }, [coverNoteId, def, result]);
  const applyCover = useCallback(
    (choice: CoverChoice | null) => {
      const noteId = coverNoteId;
      setCoverNoteId(null);
      if (noteId === null) return;
      void (async () => {
        try {
          await setNoteCover(noteId, coverPropertyKey, choice);
          // First cover on a view with no image property → adopt `cover` as the
          // view's cover property so the card render picks it up.
          if (choice !== null && def !== null && def.image === undefined) {
            await upsertSavedView({ ...def, image: coverPropertyKey });
          }
        } catch {
          /* surfaced via backend tracing */
        }
      })();
    },
    [coverNoteId, coverPropertyKey, def],
  );
  // The non-mutating card context menu (task 8) — the CLOSED four-item set
  // (`buildCardMenuItems`): Open · Open in new tab · Reveal in folder · Copy
  // link. NO delete / move / trash / rename (a saved view is a read-only
  // projection; deletion stays at the note's own location, the sidebar).
  // Reveal selects the note in the sidebar; Copy link writes a `[[title]]`
  // wikilink via the existing clipboard plugin (no new capability).
  const cardMenuItems: ContextMenuItem[] = useMemo(() => {
    if (cardMenu === null) return [];
    const id = cardMenu.noteId;
    return buildCardMenuItems({
      open: () => ws.openInFocused(id),
      openInNewTab: () => ws.openNewTabInFocused(id),
      revealInFolder: () => sidebar.select(id),
      copyLink: () => {
        const title = sidebar.cache.get(id)?.title ?? "";
        if (title !== "") void clipboardWriteText(`[[${title}]]`);
      },
    });
  }, [cardMenu, ws, sidebar]);
  return (
    <div data-testid="editor.view-host" data-view-id={viewId}>
      {def !== null && result !== null ? (
        <ViewRenderHost
          def={def}
          result={result}
          onOpenNote={onOpenNote}
          onCardContextMenu={onCardContextMenu}
          onSetCover={onSetCover}
        />
      ) : (
        <div
          style={{
            maxWidth: 680,
            margin: "12vh auto 0",
            textAlign: "center",
            color: "var(--fg-3)",
            fontSize: 13,
            fontFamily: "var(--font-sans)",
            lineHeight: 1.6,
          }}
        />
      )}
      {cardMenu !== null && (
        <ContextMenu
          x={cardMenu.x}
          y={cardMenu.y}
          items={cardMenuItems}
          onClose={() => setCardMenu(null)}
        />
      )}
      <CoverPicker
        open={coverNoteId !== null}
        hasCover={coverTargetHasCover}
        onClose={() => setCoverNoteId(null)}
        onPick={(choice) => applyCover(choice)}
        onRemove={() => applyCover(null)}
      />
    </div>
  );
}
