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
import { CMEditor } from "../../editor/CMEditor";
import { noteRead } from "../readNote";
import { createNote } from "../createNote";
import { useSelectedNote, type NoteId } from "../sidebarState";
import { useResolverNotes } from "../resolverNotes";
import { useIndexNonce } from "../indexNonce";
import { useWorkspace } from "../workspaceContext";
import { useAutosave, type SaveStatus } from "../useAutosave";
import { countBodyWords } from "../wordCount";
import type { LeafPane, SplitDirection } from "../workspaceState";
import { TAB_DRAG_MIME, readTabDrag } from "../tabDrag";
import { NewTabChooser } from "./NewTabChooser";
import { TabStrip, STRIP_HEIGHT } from "./TabStrip";

export type PaneReadout = {
  status: SaveStatus;
  /** Body word count of the active note; `null` when the pane is empty. */
  wordCount: number | null;
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
  const activeId = leaf.activeTab;
  // WL-5/WL-6: the live resolver note-set fed into this pane's editor so wikilink
  // chips resolve (broken-link styling + hover R1). Re-feed a fresh reference on
  // every SYNC-5 index-change nonce so a note created/renamed/loaded elsewhere
  // re-resolves the chips live — `useResolverNotes` alone only changes on a cache
  // ref change, which can miss the async post-unlock index populate (the "linked
  // but looks broken on reload" case).
  const liveNotes = useResolverNotes();
  const indexNonce = useIndexNonce();
  const notes = useMemo(() => liveNotes.slice(), [liveNotes, indexNonce]);
  // Click-to-navigate target for a resolved wikilink chip → open the note.
  const handleOpenWikilink = useCallback(
    (noteUuid: string) => {
      void ctx.open(noteUuid as NoteId);
    },
    [ctx],
  );

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

  // Word count (debounced) — reported up only while focused.
  const [wordCount, setWordCount] = useState(0);
  useEffect(() => {
    const h = setTimeout(() => setWordCount(countBodyWords(content)), 200);
    return () => clearTimeout(h);
  }, [content]);

  const retry = autosave.retry;
  const status = autosave.status;
  useEffect(() => {
    if (!focused) return;
    onReadout({
      status,
      wordCount: activeId === null ? null : wordCount,
      retry,
    });
  }, [focused, status, wordCount, activeId, retry, onReadout]);

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
      if (zone === "center") {
        ws.dropNoteOnPane(leaf.id, payload.noteId, leaf.tabs.length);
      } else {
        const { direction, side } = zoneToSplit(zone);
        ws.splitPaneWithNote(leaf.id, direction, side, payload.noteId);
      }
    },
    [ws, leaf.id, leaf.tabs.length],
  );

  // The "new tab" state: an empty pane (no active tab) OR an explicit "+ new
  // tab" both show the tab bar's New-tab chip + the chooser body. The tab bar
  // is ALWAYS displayed (MYND-166) — an empty/not-yet-focused pane just shows
  // it in its New-tab state.
  const inNewTabState = pendingNewTab || activeId === null;

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
    if (loading) {
      return <PaneLoading />;
    }
    return (
      <div style={{ maxWidth: 680, margin: "0 auto" }}>
        <CMEditor
          value={content}
          onChange={setContent}
          onBlur={handleBlur}
          noteSet={notes}
          onOpenWikilink={handleOpenWikilink}
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
    );
  }, [
    inNewTabState,
    onPickNote,
    onCreateNote,
    clearPending,
    leaf.tabs.length,
    loading,
    content,
    handleBlur,
    notes,
    handleOpenWikilink,
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
        tabs={leaf.tabs}
        activeTab={inNewTabState ? null : activeId}
        titleOf={(id) => ctx.cache.get(id)?.title ?? null}
        activeDirty={
          status.status === "editing" ||
          status.status === "saving" ||
          status.status === "error"
        }
        pendingNewTab={pendingNewTab}
        onActivate={(id) => ws.activateInPane(leaf.id, id)}
        onClose={(id) => ws.closeTabInPane(leaf.id, id)}
        onNewTab={() => ws.beginNewTab(leaf.id)}
        onCloseNewTab={leaf.tabs.length > 0 ? clearPending : undefined}
        onMoveTab={(_fromPaneId, id, toIndex) =>
          ws.dropNoteOnPane(leaf.id, id, toIndex)
        }
        insetLeft={insetLeft}
        insetRight={insetRight}
      />
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          padding: "12px 24px 32px",
        }}
      >
        {editorEl}
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
