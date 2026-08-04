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
import { useTranslation } from "react-i18next";
import { CMEditor, type ScrollAnchorRequest, type CMEditorProps, type EditorSwapApi } from "../../editor/CMEditor";
import type { EditorState } from "@codemirror/state";
import { resolveDefaultViewMode, type ViewMode } from "../../editor/view-mode";
import { headingSections } from "../../dialect";

/** Stable no-op onChange for the read-only preview companion (MYND-299) — a fresh
 *  arrow each render would rebuild nothing here, but a module const keeps it tidy. */
const NOOP_ON_CHANGE = (_next: string): void => {};
import { hasAnchor, type WikilinkAnchor } from "../../editor/wikilink/anchor";
import { noteRead } from "../readNote";
import { saveNote } from "../saveNote";
import { handleBaseMismatch, productionBaseMismatchDeps } from "../baseMismatch";
import { useSyncStatus } from "../../hooks/useSyncStatus";
import { peekRevealHeading, useRevealHeadingNonce } from "../views/revealHeadingSignal";
import { peekRevealMatch, useRevealMatchNonce } from "../views/revealMatchSignal";
import { setActiveHeading } from "../views/activeHeadingSignal";
import { createNote } from "../createNote";
import { createDrawing } from "../createDrawing";
import { nextDrawingTitle } from "../drawingEmbedTitle";
import { useSelectedNote, type NoteId } from "../sidebarState";
import { useLiveResolverNotes } from "../resolverNotes";
import { useIndexNonce } from "../indexNonce";
import { useVaultHeadings } from "../useVaultHeadings";
import { useVaultBlockAnchors } from "../useVaultBlockAnchors";
import { useWorkspace } from "../workspaceContext";
import { usePrefs } from "../../hooks/usePrefs";
import { typographyStyle } from "../../editor/typography";
import { useAutosave, type SaveStatus, type SavedBodyPatch } from "../useAutosave";
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
import { TASK_KIND_VALUE } from "../../dialect";
import { useViewResult } from "../views/useViewResult";
import { ViewRenderHost } from "../views/viewRenderHost";
import { TasksPane } from "./TasksPane";
import { useTaskQueryResults } from "../useTaskQueryResults";
import { useTagSuggestions } from "../useTagSuggestions";
import { acceptTagIntoView } from "../ai/acceptTagIntoView";
import * as capabilities from "../../platform/capabilities";
import { toggleTaskSwallowingRefusal } from "../toggleTask";
import type { TaskQueryRowEventDetail } from "@myne/editor/decorations/task-query-block";
import { resolveCoverAttachmentId } from "../views/cardsView";
import { setNoteCover } from "../setNoteCover";
import { upsertSavedView } from "../../lib/prefs";
import { isNoteAiExcluded } from "../../lib/aiExcludedFolders";
import { CoverPicker, type CoverChoice } from "../../components/attachments/CoverPicker";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { buildCardMenuItems } from "../views/cardMenu";
import { writeText as clipboardWriteText } from "../../platform/clipboardManager";
import {
  DrawingCanvasLazy,
  extractSceneJson,
  writeSceneJson,
  isDrawingBody,
  type DrawingEmbedIo,
} from "@myne/editor/drawing";

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

/** The live `EditorView | null` the primary editor hands back via `onReady`,
 *  typed off `CMEditorProps` so no direct `@codemirror/view` import is needed. */
type OutlineTrackView = Parameters<NonNullable<CMEditorProps["onReady"]>>[0];

/** A heading counts as the current one once its block reaches within this many
 *  px of the viewport top (outline-scroll-tracking) — a small lead so the
 *  highlight flips as the heading arrives at the top rather than after. */
const OUTLINE_ACTIVE_OFFSET_PX = 8;

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
  const { t } = useTranslation();
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
  // vim-keyboard-mode (MYND-313): with vim on and no explicit stored choice,
  // notes open in source view — live preview hides the markdown characters
  // vim's motions still count. An explicit pref wins in either direction.
  const defaultViewMode: ViewMode = resolveDefaultViewMode(
    prefs.editor_default_view_mode,
    prefs.editor_vim_mode === true,
  );
  const effectiveViewMode: ViewMode =
    leaf.activeTab?.kind === "note" && leaf.activeTab.viewMode
      ? leaf.activeTab.viewMode
      : defaultViewMode;
  // A graph-kind active tab renders the whole-vault graph pane (MYND-198) in
  // place of the note editor — a first-class tab, no longer a modal carve-out.
  const isGraph = leaf.activeTab?.kind === "graph";
  // A tasks-kind active tab renders the vault-wide task list (MYND-616) in place
  // of the note editor — the same first-class-tab pattern the graph established.
  const isTasks = leaf.activeTab?.kind === "tasks";
  // WL-5/WL-6: the live resolver note-set fed into this pane's editor so wikilink
  // chips resolve (broken-link styling + hover R1). The hook re-evaluates on
  // every SYNC-5 index-change nonce — so a note created/renamed/loaded elsewhere
  // re-resolves the chips live, including through the async post-unlock index
  // populate the cache reference alone can miss — but hands back a fresh
  // reference only when the set actually changed, so an unrelated bump no longer
  // reconfigures this pane's editor (myne#217).
  const notes = useLiveResolverNotes();
  const indexNonce = useIndexNonce();
  // writing-assistant task 6 / SYNC-14: the AI surface (slash `/devam`,
  // `/başlık` + inline ghost-text) is enabled only when `ai_enabled` AND the
  // open note is not in an `ai_excluded_folders` folder. This flows to CMEditor's
  // `aiEnabled` prop, which reconfigures the live AI compartment — so toggling
  // the pref, excluding the folder, or switching notes takes effect immediately
  // (no remount / reopen needed).
  // The open note's canonical folder (`""` = vault root, and also the value for
  // "no note open"). Both AI gates below are folder-scoped (SYNC-14), so it is
  // resolved once rather than twice.
  const activeNoteFolder = useMemo(
    () =>
      activeId !== null ? (notes.find((n) => n.noteUuid === activeId)?.folder ?? "") : "",
    [activeId, notes],
  );

  // MYND-634: the inline-drawing-embed IO seam handed to CMEditor. `readScene` /
  // `saveScene` are note-id-parameterized (folder-independent); `createSibling`
  // reads the CURRENT note's folder + cache through refs, so the seam OBJECT stays
  // stable (deps `[]`) and never churns the editor's IO facet compartment.
  const drawingIoCtxRef = useRef(ctx);
  const drawingIoFolderRef = useRef(activeNoteFolder);
  useEffect(() => {
    drawingIoCtxRef.current = ctx;
  }, [ctx]);
  useEffect(() => {
    drawingIoFolderRef.current = activeNoteFolder;
  }, [activeNoteFolder]);
  const drawingIo = useMemo<DrawingEmbedIo>(
    () => ({
      readScene: async (id) => extractSceneJson(await noteRead(id as NoteId)),
      saveScene: async (id, sceneJson) => {
        const body = await noteRead(id as NoteId);
        await saveNote(id as NoteId, writeSceneJson(body, sceneJson));
      },
      createSibling: async () => {
        const folder = drawingIoFolderRef.current === "" ? null : drawingIoFolderRef.current;
        const title = nextDrawingTitle(drawingIoCtxRef.current.cache.values());
        const id = await createDrawing(title, folder);
        // Surgical refresh so the new drawing enters the resolver note-set and the
        // just-inserted `![[Drawing N]]` resolves to it (renders as a thumbnail).
        await drawingIoCtxRef.current.refreshOne(id as NoteId);
        return title;
      },
      renameDrawing: async (id, newTitle) => {
        // Route through the transactional rename so the `![[oldTitle]]` embed(s)
        // are rewritten to `![[newTitle]]` — a bare title write would orphan them.
        const body = await noteRead(id as NoteId);
        await drawingIoCtxRef.current.commitRename(id as NoteId, body, newTitle);
      },
    }),
    [],
  );
  const aiSlashEnabled = useMemo(() => {
    if (prefs.ai_enabled !== true) return false;
    return !isNoteAiExcluded(activeNoteFolder, prefs.ai_excluded_folders);
  }, [prefs.ai_enabled, prefs.ai_excluded_folders, activeNoteFolder]);
  // MYND-305: the vault-wide heading set the `[[##` autocomplete searches (built
  // lazily by reading note bodies; rebuilt on the index nonce). Empty until the
  // first async build settles — `[[##` simply finds nothing until then.
  const vaultHeadings = useVaultHeadings();
  // MYND-382: the vault-wide imported-block-anchor set the `[[^^` enumerate-only
  // autocomplete searches (read from the persisted vault-indices index via one
  // IPC query; refetched on the index nonce). Empty until the first query
  // settles — `[[^^` simply finds nothing until then.
  const vaultBlockAnchors = useVaultBlockAnchors();
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
        // MYND-305 × MYND-534: an anchored open that switches to a DIFFERENT note
        // must land at the anchor (or note-top if not found), NOT the target's
        // restored cached scroll — flag it for the body-load effect. A same-note
        // re-click keeps the flag clear (CMEditor's scroll effect handles it) so
        // no stale flag leaks into a later plain tab-switch.
        if (noteUuid !== activeIdRef.current) {
          deepLinkOpenTargetRef.current = noteUuid as NoteId;
        }
        setScrollAnchor({ anchor, nonce: Date.now() });
      }
      void ctx.open(noteUuid as NoteId);
    },
    [ctx],
  );
  // Outline tab → editor scroll bridge (right-panel tabs): the panel-level
  // Outline tab emits a heading-reveal request through the module-level signal
  // (a separate render subtree), and the FOCUSED pane converts it into the SAME
  // `setScrollAnchor` call a `[[#heading]]` chip click uses. Self-gated on the
  // monotonic nonce (like CMEditor's applied-scroll-nonce) so a non-focused or
  // stale pane never scrolls, and re-clicking the same heading re-fires.
  const revealHeadingNonce = useRevealHeadingNonce();
  useEffect(() => {
    const req = peekRevealHeading();
    if (req === null || !focused || activeId === null) return;
    if (req.paneId !== null && req.paneId !== leaf.id) return;
    pendingAnchorTargetRef.current = activeId;
    setScrollAnchor({ anchor: { heading: req.heading }, nonce: req.nonce });
  }, [revealHeadingNonce, focused, activeId, leaf.id]);

  // Search result → scroll-to-match bridge (MYND-448b): the command palette
  // opens the note and emits a reveal-match request; the FOCUSED pane showing
  // that note converts it into the same `setScrollAnchor` call, with a `{ query }`
  // anchor the editor resolves to the earliest literal match and selects. Deps
  // include `activeId` so the effect re-runs once the note finishes opening.
  const revealMatchNonce = useRevealMatchNonce();
  useEffect(() => {
    const req = peekRevealMatch();
    if (req === null || !focused || activeId === null) return;
    if (req.noteId !== activeId) return;
    pendingAnchorTargetRef.current = activeId;
    setScrollAnchor({ anchor: { query: req.query }, nonce: req.nonce });
  }, [revealMatchNonce, focused, activeId]);

  // Only feed the pending scroll into the editor once THIS pane is actually
  // showing the deep-link target (the body-load effect keys on `activeId`); a
  // stale request for a different note is dropped so we never scroll the wrong
  // note.
  const activeScrollAnchor =
    scrollAnchor !== null && pendingAnchorTargetRef.current === activeId
      ? scrollAnchor
      : null;

  // The pane's buffer. `text` is the note body; `base` is the doc text `text`
  // was DERIVED from, and it is set by exactly ONE producer — the autosave
  // `updated:` patch echo (`handleSaveEcho` below). Every other producer is
  // authoritative (disk load, swap restore, out-of-band reload, keep-both
  // adopt, drawing scene write, the editor's own `onChange`) and leaves it
  // undefined, which the `setContent` wrapper guarantees BY CONSTRUCTION —
  // forgetting to clear a stale baseline is not possible, because the only way
  // to set one is the dedicated setter. `base` flows to `<CMEditor valueBase>`,
  // which refuses an echo the buffer has already moved past (myne#167).
  const [buffer, setBuffer] = useState<{ text: string; base?: string }>({
    text: "",
  });
  const content = buffer.text;
  const setContent = useCallback(
    (next: string | ((prev: string) => string)) => {
      setBuffer((prev) => ({
        text: typeof next === "function" ? next(prev.text) : next,
      }));
    },
    [],
  );
  // The save echo, as a compare-and-swap: `useAutosave` hands down an updater
  // that returns `prev` unchanged when the buffer has moved on, so an adoption
  // is exactly the case where `prev` IS the text the patch was derived from —
  // which makes it the correct `valueBase` to hand the editor.
  const handleSaveEcho = useCallback((applyPatch: SavedBodyPatch) => {
    setBuffer((prev) => {
      const next = applyPatch(prev.text);
      return next === prev.text ? prev : { text: next, base: prev.text };
    });
  }, []);
  const [loading, setLoading] = useState<boolean>(false);

  // Persistent-view swap (MYND-534). One long-lived CMEditor per pane; on a
  // markdown→markdown note switch we cache the outgoing note's EditorState (undo +
  // selection) + outer-scroller scrollTop and swap the incoming note's in via the
  // CMEditor swap API, instead of tearing the view down. `swapApiRef` is handed up
  // by the primary CMEditor's `onSwapReady` (null while unmounted — e.g. a drawing
  // tab — in which case we fall back to the plain content-mirror path).
  const swapApiRef = useRef<EditorSwapApi | null>(null);
  const stateCacheRef = useRef<Map<NoteId, { state: EditorState; scrollTop: number }>>(
    new Map(),
  );
  const prevActiveIdRef = useRef<NoteId | null>(null);

  // MYND-305 × MYND-534: the target note-id of an in-flight deep-link OPEN (a
  // wikilink chip carrying an anchor that switches to a DIFFERENT note). Set by
  // `handleOpenWikilink`, consumed once by the body-load effect: when the load
  // for that note runs, the anchor owns the scroll, so the note lands at the TOP
  // (anchor `scrollIntoView` / §5.6 not-found fallback take over) instead of its
  // restored cached scrollTop. Only set for cross-note opens so it never leaks a
  // stale flag into a later plain tab-switch (which must restore cached scroll).
  const deepLinkOpenTargetRef = useRef<NoteId | null>(null);

  // MYND-534: evict cached EditorStates for notes no longer open in this pane (a
  // closed tab), so the cache is bounded by the pane's open-tab count and a
  // reopen starts fresh (grill Q3 — tab-switch-only lifetime).
  const openNoteTabKey = leaf.tabs
    .filter((t) => t.kind === "note")
    .map((t) => t.id)
    .join("\u0000");
  useEffect(() => {
    const open = new Set(
      leaf.tabs.filter((t) => t.kind === "note").map((t) => t.id),
    );
    for (const key of [...stateCacheRef.current.keys()]) {
      if (!open.has(key)) stateCacheRef.current.delete(key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openNoteTabKey]);

  // --- Live outline scroll tracking (outline-scroll-tracking) ------------------
  // The focused pane publishes its topmost visible heading to the panel-level
  // Outline tab (a separate render subtree) through the `activeHeadingSignal`
  // store, so the tab can highlight the current section and keep it in view.
  // Heading positions come from the SAME `headingSections` parser the tab uses,
  // so the `from` offsets join exactly once the buffer matches disk.
  const headingFroms = useMemo(() => headingSections(content).map((h) => h.from), [content]);
  const headingFromsRef = useRef<number[]>(headingFroms);
  const outlineViewRef = useRef<OutlineTrackView>(null);
  // The same view as `outlineViewRef`, in state — see `handleEditorReady`.
  const [editorView, setEditorView] = useState<OutlineTrackView>(null);
  const outlineScrollerRef = useRef<HTMLDivElement | null>(null);
  const activeIdRef = useRef(activeId);
  const focusedRef = useRef(focused);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  useEffect(() => {
    focusedRef.current = focused;
  }, [focused]);

  // Resolve the heading currently at the top of the viewport: the last heading
  // whose block sits at or above the viewport top. The editor GROWS to fit its
  // content inside an OUTER scroller (`view.scrollDOM` / `.cm-scroller` does not
  // scroll here), so measure in window coords — the content-top rect plus each
  // heading's always-available height-map offset — against the scroller's top.
  // Only the focused pane publishes, so the outline follows the note in view.
  const recomputeActiveHeading = useCallback(() => {
    const view = outlineViewRef.current;
    const scroller = outlineScrollerRef.current;
    if (view === null || scroller === null || !focusedRef.current) return;
    const noteId = activeIdRef.current;
    if (noteId === null) return;
    const froms = headingFromsRef.current;
    if (froms.length === 0) {
      setActiveHeading(null);
      return;
    }
    // Bottom-of-scroll clamp (#186): once the outer scroller is bottomed out, a
    // heading in the final viewport can never rise to the fixed cutoff below, so
    // the loop would leave the highlight stuck on an earlier heading. When we are
    // at (within 1px of) max scroll, the LAST heading is the active one — this
    // fixes both clicking a bottom heading and manually scrolling to the bottom.
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1) {
      setActiveHeading({ noteId, from: froms[froms.length - 1]! });
      return;
    }
    const contentTop = view.contentDOM.getBoundingClientRect().top;
    const cutoff = scroller.getBoundingClientRect().top + OUTLINE_ACTIVE_OFFSET_PX;
    const docLen = view.state.doc.length;
    let activeFrom = froms[0]!; // default: above the first heading ⇒ first section
    for (const from of froms) {
      let blockTop: number;
      try {
        blockTop = view.lineBlockAt(Math.min(from, docLen)).top;
      } catch {
        continue;
      }
      if (contentTop + blockTop <= cutoff) activeFrom = from;
      else break;
    }
    setActiveHeading({ noteId, from: activeFrom });
  }, []);

  // Recompute when the heading set changes (edit / note switch) or this pane
  // gains focus, so the highlight tracks without waiting for the next scroll.
  useEffect(() => {
    headingFromsRef.current = headingFroms;
    recomputeActiveHeading();
  }, [headingFroms, recomputeActiveHeading]);
  useEffect(() => {
    if (focused) recomputeActiveHeading();
  }, [focused, recomputeActiveHeading]);

  // Watch the pane's real scroll container with a rAF-throttled listener. Stable
  // across note switches — the view handle is read live via the ref, so a
  // not-yet-ready view simply no-ops until `onReady` fires.
  useEffect(() => {
    const scroller = outlineScrollerRef.current;
    if (scroller === null) return;
    let raf = 0;
    const onScroll = () => {
      if (raf !== 0) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        recomputeActiveHeading();
      });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [recomputeActiveHeading]);

  // The primary editor hands back its live view on mount (and null on unmount);
  // capture it and take an initial reading.
  //
  // Kept in STATE as well as the ref (MYND-617): the outline tracker reads the
  // view imperatively from a scroll handler, but the task-query results have to
  // be recomputed by a hook, and a ref does not re-render. Same view, two
  // consumers with different reactivity needs.
  const handleEditorReady = useCallback(
    (view: OutlineTrackView) => {
      outlineViewRef.current = view;
      setEditorView(view);
      if (view !== null) recomputeActiveHeading();
    },
    [recomputeActiveHeading],
  );

  // MYND-617: results for every task-query block in this pane's document. The
  // editor finds the blocks and renders rows; what a query MEANS is decided
  // here, because the type authority for a `due::` value is the dialect's and
  // the vault-wide task list is an IPC surface.
  const { results: taskQueryResults, resolveRow: resolveTaskRow } = useTaskQueryResults(
    editorView,
    content,
    indexNonce,
  );

  // A row's checkbox → the ONE writer every task surface goes through. The
  // widget dispatched a `{queryKey, rowKey}` and nothing else, so the record is
  // looked back up here; an unresolvable key means the index moved under the
  // render and doing nothing is the right answer.
  const handleTaskQueryToggle = useCallback(
    (detail: TaskQueryRowEventDetail) => {
      const task = resolveTaskRow(detail.rowKey);
      if (task === undefined) return;
      void toggleTaskSwallowingRefusal(task, ws.flushAll);
    },
    [resolveTaskRow, ws.flushAll],
  );

  const handleTaskQueryOpen = useCallback(
    (detail: TaskQueryRowEventDetail) => {
      const task = resolveTaskRow(detail.rowKey);
      if (task !== undefined) ws.openInFocused(task.noteId);
    },
    [resolveTaskRow, ws],
  );

  // MYND-651: the inline tag-suggestion band for this pane's note. Gated on BOTH
  // AI switches and on the host actually having local AI — the Rust side refuses
  // regardless (task 4), but an off feature should not be arming idle timers or
  // building prompts that carry note text.
  const { suggestions: tagSuggestions, dismiss: dismissTagSuggestion } = useTagSuggestions({
    noteId: activeId,
    body: content,
    folder: activeNoteFolder,
    enabled:
      capabilities.has("localAi") &&
      prefs.ai_enabled === true &&
      prefs.auto_tag_enabled === true,
    excludedFolders: prefs.ai_excluded_folders,
  });

  // A chip click → the ONE accept path (task 6). `false` means nothing was
  // written — the note already carries the tag, or its frontmatter is a shape
  // the writer refuses to touch — and in both cases the user's intent is already
  // satisfied or unreachable, so the chip goes away either way and no error is
  // surfaced.
  const handleAcceptTagSuggestion = useCallback(
    (detail: { tag: string }) => {
      if (editorView !== null) acceptTagIntoView(editorView, detail.tag);
      dismissTagSuggestion(detail.tag);
    },
    [editorView, dismissTagSuggestion],
  );

  const handleDismissTagSuggestion = useCallback(
    (detail: { tag: string }) => dismissTagSuggestion(detail.tag),
    [dismissTagSuggestion],
  );

  // Load / restore the active note's body on change (MYND-534). Persistent-view
  // aware: capture the OUTGOING note's EditorState + scroll before swapping, then
  // for the incoming note either restore its cached state instantly (no re-read,
  // no loading) or read from disk (first open) and build a fresh state. When the
  // swap API is unavailable (drawing tab, or before the view's onSwapReady fires),
  // it degrades to the plain content-mirror path. `acceptReloadedBody` baselines
  // autosave so a swap is never mistaken for a user edit. Race-protected via
  // `cancelled`.
  useEffect(() => {
    let cancelled = false;
    let api = swapApiRef.current;
    const cache = stateCacheRef.current;
    const scroller = outlineScrollerRef.current;
    const prevId = prevActiveIdRef.current;

    // Snapshot the outgoing markdown note (the view still holds it here) so a
    // later return restores its undo history + scroll. Best-effort: a stale /
    // mid-update / destroyed view (common right after a pane split/move) must
    // NEVER break the switch — on failure we drop the swap API and reload.
    if (api !== null && prevId !== null && prevId !== activeId) {
      try {
        cache.set(prevId, {
          state: api.captureState(),
          scrollTop: scroller?.scrollTop ?? 0,
        });
      } catch {
        swapApiRef.current = null;
        api = null;
      }
    }
    prevActiveIdRef.current = activeId;

    if (activeId === null) {
      setContent("");
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    // MYND-305 × MYND-534: is THIS open driven by a deep-link (a wikilink chip
    // carrying an anchor that switched to this note)? If so the anchor owns the
    // scroll — restoring the note's cached scrollTop would clobber both the
    // anchor's `scrollIntoView` AND the §5.6 not-found fallback, which relies on
    // the note opening at the TOP (a not-found anchor scrolls nowhere). Consumed
    // once here so a later plain tab-switch restores the note's own cached scroll.
    const anchorDrivenOpen = deepLinkOpenTargetRef.current === activeId;
    if (anchorDrivenOpen) deepLinkOpenTargetRef.current = null;

    // Cached + swap API live → try an instant restore (no disk read, no loading
    // gate). ANY failure degrades to the disk-reload path below, which always
    // clears `loading` — so a bad swap can never strand the pane in a loading
    // state (the MYND-534 pane-op regression).
    const cached = api !== null ? cache.get(activeId) : undefined;
    if (api !== null && cached !== undefined) {
      let swapped = false;
      try {
        api.applyState(cached.state);
        swapped = true;
      } catch {
        swapApiRef.current = null; // view unusable → force a clean reload
      }
      if (swapped) {
        const doc = cached.state.doc.toString();
        setContent(doc);
        // myne#288 — flush the OUTGOING note before baselining the incoming one.
        //
        // This effect is registered before `useAutosave`'s own note-change
        // effect, so it runs first: `acceptReloadedBody` used to clear `dirtyRef`
        // and re-baseline `savedBodyRef` while the hook still believed it was
        // editing the previous note. By the time the hook noticed the switch
        // there was nothing left to flush, and up to ~10 s of typing was gone —
        // silently, because the cached EditorState put the text back on screen
        // and the status read `clean`.
        //
        // `flushOutgoing` saves for whatever note the hook still holds, which at
        // this point is the previous one.
        autosaveRef.current?.flushOutgoing();
        autosaveRef.current?.acceptReloadedBody(doc);
        setLoading(false);
        // Anchor-driven open → land at the top and let the anchor effect take it
        // to the heading (or hold at top if not found); otherwise restore the
        // note's own cached scroll. Same 0-then-scrollIntoView shape as first open.
        const top = anchorDrivenOpen ? 0 : cached.scrollTop;
        // Restore scroll after the swapped-in content lays out.
        requestAnimationFrame(() => {
          if (!cancelled && scroller !== null) scroller.scrollTop = top;
        });
        return () => {
          cancelled = true;
        };
      }
      // fall through to the disk reload on swap failure
    }

    // First open (uncached) or degraded swap → read from disk. The loading gate
    // rebuilds the view here (first-open re-init is unchanged; only re-VISITS get
    // the persistent view + preserved undo/scroll). No applyState: the remounted
    // view picks up `content` via its value-mirror. `finally` guarantees `loading`
    // always clears (unless a newer switch cancelled us, which owns it instead).
    setLoading(true);
    void (async () => {
      try {
        const body = await noteRead(activeId);
        if (cancelled) return;
        setContent(body);
        // Same ordering hazard as the cached-swap path above (myne#288).
        autosaveRef.current?.flushOutgoing();
        autosaveRef.current?.acceptReloadedBody(body);
        requestAnimationFrame(() => {
          if (!cancelled && scroller !== null) scroller.scrollTop = 0;
        });
      } catch {
        if (!cancelled) setContent("");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  // While the body is still loading, autosave sees NO note (`null`): a pane
  // that MOUNTS with an active note (a split/remount — the initial single pane
  // mounts with no selection) otherwise burns useAutosave's "first body change
  // is loaded content" token on the transient empty body, so the real body's
  // arrival registered as a user edit and γ1 silently REWROTE the note ~1s
  // later — a no-op body with a fresh nonce + fresh `updated:`, which the sync
  // engine can only read as a local edit (false-conflict fodder; caught by the
  // unfocused-split-pane E2E). The id flip to `null` resets the token; the
  // loaded body then lands in the same commit as the id flip back, so it is
  // classified as loaded content. Tab switches flush BEFORE the switch (the
  // workspace flush registry), so the transient `null` never drops real edits.
  // §11.3 BaseMismatch keep-both handler: a save rejected because a sync
  // pull-apply re-based the note underneath the editor. Order is load-bearing
  // (copy FIRST — a copy failure leaves the buffer untouched, zero keystroke
  // loss); the orchestration lives in `baseMismatch.ts` (unit-tested). Read
  // through a ref-stable callback: `activeId` is captured per render, which is
  // correct — the handler resolves the pane's CURRENT note.
  const onBaseMismatch = useCallback(
    async (staleBufferBody: string) => {
      if (activeId === null) return;
      await handleBaseMismatch(
        { noteId: activeId, bufferBody: staleBufferBody },
        productionBaseMismatchDeps((diskBody) => {
          autosaveRef.current.acceptReloadedBody(diskBody);
          setContent(diskBody);
        }, (copyId) => ctx.refreshOne(copyId)),
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeId],
  );
  // §11.3 expected-base guard only makes sense while a sync endpoint is
  // enrolled — a remote pull-apply is the sole writer it defends against. With
  // sync off the guard can only misfire on the editor's own local base churn
  // (a create→rename hop the autosave loop never saw, an out-of-band reload
  // racing a keystroke), turning a routine edit into a false conflict, so gate
  // it on sync being active. `null` (status not read yet) counts as inactive:
  // fail toward last-write-wins rather than risk a spurious conflict at boot.
  const { status: syncStatus } = useSyncStatus();
  const syncGuardEnabled =
    syncStatus !== null &&
    syncStatus.state !== "disabled" &&
    syncStatus.state !== "not_enrolled";
  const autosave = useAutosave(
    loading ? null : activeId,
    content,
    undefined,
    handleSaveEcho,
    onBaseMismatch,
    syncGuardEnabled,
  );

  // Render-surface dispatch (drawing-notes SF2, MYND-499; SYNC-2): a value-strict
  // `kind: drawing` in the loaded body routes this pane to the Excalidraw canvas
  // instead of CodeMirror. Derived from `content` (authoritative over the sidebar
  // cache); a note WITHOUT the canonical marker is unaffected (guard is exact).
  const isDrawing = useMemo(() => isDrawingBody(content), [content]);
  // Latest autosave handle for the reload effect, which keys only on the reload
  // nonce (so it must NOT take `autosave` as a dep — its identity changes every
  // render). Read through the ref at fire time.
  const autosaveRef = useRef(autosave);
  autosaveRef.current = autosave;
  // The pane's live buffer, readable from an async continuation. Written during
  // RENDER for the same reason `useAutosave`'s `latestBodyRef` is: an
  // effect-written mirror is one commit stale exactly while a keystroke's
  // commit waits for its passive-effect flush, which is when the out-of-band
  // reload below is most likely to resolve.
  const contentRef = useRef(content);
  contentRef.current = content;

  // Re-sync this pane's body when the open note's `.myn` changed out of band —
  // a rename (MYND-140), a snapshot restore, OR a sync pull (`sync://changed` →
  // `reloadOpenNote`). EVERY pane with an open note re-reads, not just the
  // selected one: a sync pull can rewrite a note held by an UNFOCUSED pane, and
  // a buffer left stale there would autosave the pre-pull body back over the
  // remote edit on the user's next keystroke (the stale-pane overwrite bug).
  // Cheap by construction: the workspace forbids duplicate tabs, so a bump
  // costs at most one noteRead per pane, and an unchanged body settles as a
  // setContent identity no-op. Skips the initial mount.
  const reloadNonce = ctx.contentReloadNonce;
  const reloadInit = useRef(true);
  useEffect(() => {
    if (reloadInit.current) {
      reloadInit.current = false;
      return;
    }
    // MYND-534: an out-of-band change (sync pull / external edit) may have
    // rewritten ANY note, including ones cached in the background. Clear the
    // whole per-note EditorState cache so the next swap-in rebuilds fresh from
    // disk (content correctness over background-note undo — grill Q5). The active
    // note's own re-read happens just below.
    stateCacheRef.current.clear();
    if (activeId === null) return;
    // Never clobber unsaved local edits: a dirty buffer means the engine kept
    // OUR on-disk version (it skips a locally-dirty blob on pull), so reloading
    // would either resurrect stale bytes or discard the user's work. Leave the
    // dirty buffer alone; its edit pushes on the next sync.
    //
    // `hasPendingWork()` and NOT `status` (myne#167): `status` is React state
    // written from a passive effect, so it still reads `saved`/`clean` for a
    // whole scheduler slice after the user has typed — long enough for this
    // reload to resolve inside it and overwrite those keystrokes with disk
    // bytes. The predicate reads refs only.
    if (autosaveRef.current.hasPendingWork()) return;
    const before = contentRef.current;
    let cancelled = false;
    void (async () => {
      try {
        const body = await noteRead(activeId);
        if (cancelled) return;
        // Re-check dirtiness AFTER the await: typing may have started while the
        // read was in flight, and re-baselining now would clobber those keys
        // with the just-read (already-stale) bytes.
        if (autosaveRef.current.hasPendingWork()) return;
        // Re-baseline autosave to the reloaded body BEFORE swapping it in, so the
        // content change registers as freshly-loaded content, not a user edit.
        // Without this, a sync-pulled reload looks locally-dirty and the next
        // sync stages a spurious keep-both conflict for a note the user never
        // touched (the false-conflict bug, sync Bug 1).
        autosaveRef.current.acceptReloadedBody(body);
        // Compare-and-swap, not a bare set: the ONLY buffer these disk bytes may
        // replace is the one the guard above was answered for.
        setContent((prev) => (prev === before ? body : prev));
      } catch {
        /* re-sync failure is non-fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
    // nonce is the trigger; activeId read at fire time.
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
    // A drawing note is an Excalidraw scene stored as fenced JSON — a word/char
    // count over that body counts the JSON, a meaningless, confusing metric. Emit
    // null so the bottom-bar readout hides for drawings (it renders nothing when
    // stats are null).
    const suppressStats = activeId === null || isDrawing;
    onReadout({
      status,
      stats: suppressStats ? null : stats,
      selectionStats: suppressStats ? null : selectionStats,
      retry,
    });
  }, [focused, status, stats, selectionStats, activeId, isDrawing, retry, onReadout]);

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

  // Mint a note via `mint` (createNote / createDrawing — NOT
  // `ctx.createAndStartRename`, which auto-selects into the focused pane's ACTIVE
  // slot via Editor.tsx's bridge A and defeats the new-tab intent), open it
  // explicitly into a NEW tab, then inline-rename. Shared by the note + drawing
  // chooser buttons (drawing-notes SF2, MYND-499).
  const createIntoNewTab = useCallback(
    (mint: () => Promise<string>) => {
      void (async () => {
        try {
          const id = await mint();
          ws.openNewTabInFocused(id);
          await ctx.refreshOne(id).catch(() => {});
          ctx.startRename(id);
        } catch {
          /* creation failure surfaces via the sidebar UX on next refresh */
        }
      })();
    },
    [ws, ctx],
  );
  const onCreateNote = useCallback(
    () => createIntoNewTab(() => createNote(null)),
    [createIntoNewTab],
  );
  const onCreateDrawing = useCallback(
    () => createIntoNewTab(() => createDrawing()),
    [createIntoNewTab],
  );

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
          onCreateDrawing={onCreateDrawing}
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
    if (isTasks && leaf.activeTab !== null) {
      return <TasksPane paneId={leaf.id} item={leaf.activeTab} />;
    }
    if (loading) {
      return <PaneLoading />;
    }
    if (isDrawing) {
      // The Excalidraw canvas surface (SF2). Scene loads from the note body and
      // re-serializes on change back into `content`, which the existing autosave
      // (above) debounces + persists — no separate save path. RUNTIME-FLAGGED:
      // the canvas round-trip + onChange debounce need a `pnpm tauri dev` check.
      return (
        <div
          data-testid="editor.content-frame"
          style={{ height: "100%", minHeight: 0 }}
        >
          <DrawingCanvasLazy
            // Key by note id so switching to a different drawing remounts the
            // canvas with the new scene (initialData is read once at mount).
            key={activeId ?? "drawing"}
            initialSceneJson={extractSceneJson(content) ?? undefined}
            onSceneChange={(json) => setContent(writeSceneJson(content, json))}
          />
        </div>
      );
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
            // Set only by the autosave `updated:` echo; undefined for every
            // authoritative writer, so those still apply unconditionally.
            valueBase={buffer.base}
            onChange={setContent}
            onBlur={handleBlur}
            onSelectionChange={handleSelectionChange}
            noteSet={notes}
            vaultHeadings={vaultHeadings}
            vaultBlockAnchors={vaultBlockAnchors}
            onOpenWikilink={handleOpenWikilink}
            // MYND-617: the task-query blocks in this document. Absent entries
            // render as loading, never as an empty result.
            taskQueryResults={taskQueryResults}
            onTaskQueryToggle={handleTaskQueryToggle}
            onTaskQueryOpen={handleTaskQueryOpen}
            // MYND-651: the inline tag-suggestion band. Empty (the default, and
            // the state of every note while auto-tag is off) renders no band at
            // all, so an idle note is not shifted by a strip of chrome. Only the
            // editable primary editor gets it — the reading companion below is
            // a mirror, and a second band offering the same accept would write
            // through this same document twice.
            tagSuggestions={tagSuggestions}
            onAcceptTagSuggestion={handleAcceptTagSuggestion}
            onDismissTagSuggestion={handleDismissTagSuggestion}
            scrollAnchor={activeScrollAnchor}
            // outline-scroll-tracking: hand the live view to the pane so it can
            // watch the scroller and report the top heading to the Outline tab.
            onReady={handleEditorReady}
            // persistent-view swap (MYND-534): the pane drives note switches on
            // this one long-lived view via the swap API; null while unmounted.
            onSwapReady={(api) => {
              swapApiRef.current = api;
            }}
            // writing-assistant task 6: surface the AI slash commands only in the
            // editable editor, gated on ai_enabled + the excluded-folder check
            // (SYNC-14). The reading-view instance below leaves it default-false.
            aiEnabled={aiSlashEnabled}
            // MYND-592: an independent, opt-OUT switch. Not ANDed with the
            // excluded-folder rule above — that rule is about ambient AI
            // reading of note content, while transcribing is a per-file action
            // the user explicitly asks for.
            transcriptionEnabled={prefs.transcription_enabled}
            // editor-line-numbers (MYND-314): default OFF (prose-first); the open
            // editor reconfigures its line-number compartment live when the pref
            // flips (no remount). `prefs` is already a useMemo dep below.
            lineNumbers={prefs.editor_line_numbers === true}
            // vim-keyboard-mode (MYND-313): default OFF (modal editing is opt-in).
            // The open editor reconfigures its vim compartment live when the pref
            // flips (no remount), and the engine is only downloaded on the first
            // enable — a user who never turns vim on never pays for it.
            // Reading view is read-only and never holds a text cursor, so modal
            // editing is meaningless there — and an indicator would be actively
            // misleading. Vim is mounted only for the editable modes.
            vimMode={prefs.editor_vim_mode === true && effectiveViewMode !== "reading"}
            // #184: the user keymap overrides (vault.prefs.keymap). The editor
            // reconfigures its rebindable-keymap compartment live when a Hotkeys
            // rebind of an editor command lands (no remount).
            keymapOverrides={prefs.keymap}
            // MYND-634: inline `![[Drawing]]` embeds — read/save the referenced
            // drawing note's scene + create a sibling drawing for /drawing.
            drawingIo={drawingIo}
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
            style={{ flex: 1, minWidth: 0, borderInlineStart: "1px solid var(--line-1)", paddingInlineStart: 16 }}
          >
            <CMEditor
              value={content}
              // Deliberately NO `valueBase`: this mirror holds no local edits,
              // so it must adopt every value unconditionally. Handing it the
              // primary's baseline would make it silently skip `updated:`
              // stamps whenever the primary's buffer had moved on.
              onChange={NOOP_ON_CHANGE}
              noteSet={notes}
              vaultHeadings={vaultHeadings}
              vaultBlockAnchors={vaultBlockAnchors}
              // The reading companion renders query blocks too, and its
              // checkboxes stay live: reading mode makes the HOST note
              // read-only, but a row's write targets a different note entirely.
              taskQueryResults={taskQueryResults}
              onTaskQueryToggle={handleTaskQueryToggle}
              onTaskQueryOpen={handleTaskQueryOpen}
              // MYND-634: render inline drawing thumbnails in the reading mirror
              // too (reading mode never opens the edit-in-place canvas — it stays a
              // static thumbnail — but it still needs the seam to read the scene).
              drawingIo={drawingIo}
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
    isTasks,
    onPickNote,
    onCreateNote,
    onCreateDrawing,
    clearPending,
    leaf.tabs.length,
    loading,
    content,
    // Paired with `content` on the primary editor: a `valueBase` left behind by
    // a stale memo would describe a `value` that is no longer rendered.
    buffer.base,
    handleBlur,
    handleSelectionChange,
    notes,
    vaultHeadings,
    vaultBlockAnchors,
    handleOpenWikilink,
    taskQueryResults,
    handleTaskQueryToggle,
    handleTaskQueryOpen,
    activeScrollAnchor,
    handleEditorReady,
    isDrawing,
    setContent,
    drawingIo,
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
          if (it.kind === "graph") return t("notes.pane.graphTab");
          if (it.kind === "tasks") return t("notes.pane.tasksTab");
          // View tab: label by the saved view's name (MYND-274), not its raw id.
          // A blank name shows "Untitled view" (the sidebar's label rule); an
          // unknown id (a stale tab for a deleted view) falls back to null.
          const view = prefs.saved_views.find((v) => v.id === it.id);
          if (view === undefined) return null;
          return view.name.trim() === ""
            ? t("notes.pane.untitledView")
            : view.name;
        }}
        colorOf={(key) => {
          // Only real notes carry a colour label; views / graph tabs have none.
          const it = parseItemKey(key);
          // `item_colors` (MYND-184) is keyed by note UUID; views and graph
          // tabs are not colourable, so they resolve to undefined.
          return it.kind === "note" ? prefs.item_colors[it.id] : undefined;
        }}
        iconOf={(key) => {
          const it = parseItemKey(key);
          if (it.kind === "view") return "layout-grid";
          if (it.kind === "graph") return "share-2";
          if (it.kind === "tasks") return "list-todo";
          // url-bookmark (SYNC-16): a note carrying an unmanaged `source:`
          // provenance key is a clipped link-only bookmark → bookmark glyph;
          // every ordinary note keeps the default `file-text`.
          // Drawing note (kind: drawing) → a pencil glyph so a canvas tab reads
          // distinctly from a markdown note in the tab strip (SF2, MYND-499).
          if (ctx.cache.get(it.id)?.kind === "drawing") return "pencil";
          // Note-task (kind: task, MYND-613) → the same muted list glyph its
          // sidebar row carries, so the user's declaration is visible without
          // opening the note. Deliberately NOT a check: the marker says "this
          // is a task", not "this task is done", and the canon prohibits a
          // green check badge.
          if (prefs.show_task_marker && ctx.cache.get(it.id)?.kind === TASK_KIND_VALUE)
            return "list";
          if (ctx.cache.get(it.id)?.hasSource === true) return "bookmark";
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
        ref={outlineScrollerRef}
        style={{
          flex: 1,
          minHeight: 0,
          // A drawing needs a full-bleed, EXPLICIT-height, non-scrolling frame:
          // Excalidraw has no intrinsic height (it fills its parent) and pans
          // internally, so the markdown scroll + gutter padding would collapse it
          // to a 0-height (invisible) canvas. Markdown keeps the scroll + padding.
          overflow: isDrawing ? "hidden" : "auto",
          // No TOP padding here: this div is the scroll parent of the in-note
          // find bar's sticky top panel, and a top padding leaves a band above the
          // bar where scrolled text bleeds through (MYND-299 QA). The 12px top
          // breathing-room moves onto the inner wrapper below, so it scrolls UNDER
          // the now-flush sticky bar instead of opening a gap above it.
          padding: isDrawing ? 0 : "0 24px 32px",
        }}
      >
        <div style={isDrawing ? { height: "100%" } : { paddingTop: 12 }}>
          {editorEl}
        </div>
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
  const { t } = useTranslation();
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
      {t("notes.pane.loading")}
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
