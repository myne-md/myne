// `<PaneView>` - one leaf pane of the editor workspace (MYND-166, Task 4).
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
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { CMEditor, type ScrollAnchorRequest, type CMEditorProps, type EditorSwapApi } from "../../editor/CMEditor";
import { noteBecameActive, recentNoteIds } from "../recentNotes";
import {
  evictClosedTabs,
  isRestoringScroll,
  recallScroll,
  rememberScroll,
} from "../scrollMemory";
import { applyScrollAnchor } from "../scrollAnchorApply";
import type { EditorState } from "@codemirror/state";
import { resolveDefaultViewMode, type ViewMode } from "../../editor/view-mode";
import { headingSections } from "../../dialect";

/** Stable no-op onChange for the read-only preview companion (MYND-299) - a fresh
 *  arrow each render would rebuild nothing here, but a module const keeps it tidy. */
const NOOP_ON_CHANGE = (_next: string): void => {};
import { hasAnchor, type WikilinkAnchor } from "../../editor/wikilink/anchor";
import { noteRead } from "../readNote";
import { saveNote } from "../saveNote";
import {
  closeLiveNote,
  isLiveNote,
  openLiveNote,
  patchEpoch,
  readLiveNote,
  reportLivePresence,
  settledPatches,
  takeRemoteSplices,
} from "../liveNote";
import { PRESENCE_JUMP_EVENT, presenceRevealFor, type PresenceJumpDetail } from "../collab/presenceJump";
import { resolveIdentity } from "../../lib/identity";
import { listen } from "../../platform/event";
import { remoteDispatchSpec } from "@myne/editor/live-bridge";
import {
  applySplicesToText,
  installRemoteMergeDrain,
  type RemoteMergeDrain,
} from "@myne/editor/live-remote-merge";
import {
  AWARENESS_GRACE_MS,
  awarenessOnDrop,
  awarenessNotePeers,
  awarenessSweep,
  awarenessUpsert,
  getAwarenessSnapshot,
  setAwareness,
  subscribeAwareness,
  type PresenceUpdate,
} from "../collab/awarenessStore";
import { colorVarForIndex } from "../collab/participant";
import { identityLabelText } from "../collab/identityLabel";
import { resolvePeerLabels } from "../collab/presenceLabels";
import { handleBaseMismatch, productionBaseMismatchDeps } from "../baseMismatch";
import { runPaneResync } from "../liveResync";
import { useSyncStatus } from "../../hooks/useSyncStatus";
import { peekRevealHeading, useRevealHeadingNonce } from "../views/revealHeadingSignal";
import { peekRevealTask, useRevealTaskNonce } from "../views/revealTaskSignal";
import { peekRevealMatch, useRevealMatchNonce } from "../views/revealMatchSignal";
import { setActiveHeading } from "../views/activeHeadingSignal";
import { createNote } from "../createNote";
import { createDrawing } from "../createDrawing";
import { nextDrawingTitle } from "../drawingEmbedTitle";
import { useSelectedNote, type NoteId } from "../sidebarState";
import { settleFrontmatterWrite } from "../settleFrontmatterWrite";
import { useLiveResolverNotes } from "../resolverNotes";
import { useIndexNonce } from "../indexNonce";
import { useVaultHeadings } from "../useVaultHeadings";
import { useVaultBlockAnchors } from "../useVaultBlockAnchors";
import { useWorkspace } from "../workspaceContext";
import { usePrefs } from "../../hooks/usePrefs";
import { listFolderPaths } from "../listFolderPaths";
import { typographyStyle } from "../../editor/typography";
import { useAutosave, type FlushOptions, type SaveStatus, type SavedBodyPatch } from "../useAutosave";
import type { LiveSaveContext } from "../saveNote";
import { dispatchNoteRemoved, isRemovedFromLiveTree } from "../noteRemoved";
import { computeDocStats, statsOfPlain, type DocStats } from "../documentStats";
import { refreshThenOpen } from "../openFreshNote";
import {
  itemKey,
  parseItemKey,
  type LeafPane,
  type SplitDirection,
  type WorkspaceItem,
} from "../workspaceState";
import { tabKindSpec } from "../tabKinds";
import { TAB_DRAG_MIME, readTabDrag } from "../tabDrag";
import { NewTabChooser } from "./NewTabChooser";
import { GraphPane } from "./GraphView";
import { AttachmentsLibrary } from "../../components/attachments/AttachmentsLibrary";
import { TemplatesManager } from "../../components/TemplatesManager";
import { TabStrip, STRIP_HEIGHT, tabDomId } from "./TabStrip";
import { TASK_KIND_VALUE } from "../../dialect";
import { useViewResult } from "../views/useViewResult";
import { ViewRenderHost } from "../views/viewRenderHost";
import type { BoardCardActions } from "../views/boardView";
import { Button } from "../../components/primitives/Button";
import { CalendarPane } from "./CalendarPane";
import { TasksPane } from "./TasksPane";
import { AgentPane } from "../agent/AgentPane";
import { useTaskQueryResults } from "../useTaskQueryResults";
import { useTagSuggestions } from "../useTagSuggestions";
import { acceptTagIntoView } from "../ai/acceptTagIntoView";
import { computeTagRemoveEdit } from "../ai/acceptTag";
import { shouldAutoApply } from "../ai/autoApply";
import { readAutoApplyTags, subscribeAutoApplyTags } from "../../lib/autoApplyTags";
import * as capabilities from "../../platform/capabilities";
import { toggleTaskSwallowingRefusal } from "../toggleTask";
import type { TaskQueryRowEventDetail } from "@myne/editor/decorations/task-query-block";
import { TITLE_FIELD_TESTID } from "@myne/editor/decorations/frontmatter";
import { resolveCoverAttachmentId } from "../views/cardsView";
import { setNoteCover } from "../setNoteCover";
import { saveLocalViewEdit } from "../views/saveViewEdit";
import { isNoteAiExcluded } from "../../lib/aiExcludedFolders";
import { CoverPicker, type CoverChoice } from "../../components/attachments/CoverPicker";
import { Toast } from "../../components/Toast";
import { panesNotSettledMessage } from "../workspaceContext";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { paneDimStyle } from "./sharedStyles";
import { buildCardMenuItems } from "../views/cardMenu";
import { writeText as clipboardWriteText } from "../../platform/clipboardManager";
import { copyText } from "../../lib/clipboard";
import {
  DrawingCanvasLazy,
  extractSceneJson,
  writeSceneJson,
  isDrawingBody,
  type DrawingEmbedIo,
} from "@myne/editor/drawing";
import { ornamentRole } from "@myne/ornaments";

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
// edge the cursor lands on, or - in the center band - adds it as a tab.
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
 *  px of the viewport top (outline-scroll-tracking) - a small lead so the
 *  highlight flips as the heading arrives at the top rather than after. */
const OUTLINE_ACTIVE_OFFSET_PX = 8;

/** How long a scroll has to stop before the reading position is recorded
 *  (myne-md/myne#600). Long enough that a flick records once rather than per
 *  frame, short enough that a pane torn down straight after a scroll still has
 *  its position. The anchor is only ever read on a note switch, an unmount or a
 *  resize, none of which can happen inside this window without the user first
 *  stopping. */
const SCROLL_SETTLE_MS = 120;

/** How long this pane's local caret/selection waits before being reported on the
 *  live channel (`collab-presence-ui`). Matches the awareness coalescing floor
 *  (`SYNC-5`, ~100 ms): a trailing throttle, so a fast caret sends one frame per
 *  window rather than one per keystroke. */
const PRESENCE_REPORT_MS = 100;

/**
 * A trailing-edge debounce that owns its own handle.
 *
 * Both scroll-anchor effects below want the same thing: run this once the user
 * stops, and cancel it if the effect tears down first. Written out, that is a
 * `let timer = 0`, a clear-then-set, a reset inside the callback and a clear in
 * the cleanup, four places that have to agree, twice. The pairing that matters
 * is the last one: forgetting the cleanup leaves a timer holding a `view` and a
 * `scroller` past unmount, which no compiler and no test reports.
 *
 * So the handle is closed over rather than remembered, and `cancel` is the only
 * thing the cleanup has to call.
 */
function trailingEdge(delayMs: number): {
  run: (fn: () => void) => void;
  cancel: () => void;
  flush: () => void;
} {
  let timer = 0;
  let pending: (() => void) | null = null;
  const clear = () => {
    if (timer !== 0) clearTimeout(timer);
    timer = 0;
    pending = null;
  };
  return {
    run: (fn) => {
      if (timer !== 0) clearTimeout(timer);
      pending = fn;
      timer = window.setTimeout(() => {
        timer = 0;
        pending = null;
        fn();
      }, delayMs);
    },
    cancel: clear,
    /**
     * Run the pending callback now instead of dropping it.
     *
     * The two teardowns want opposite things and used to call the same one. A
     * pending RESTORE is worth dropping: it would scroll a pane that is going
     * away. A pending REMEMBER is the opposite, and the effect that owns it says
     * so in its own comment, that a pane can leave without any effect seeing it.
     * Cancelling there threw away the last scroll the reader made inside the
     * settle window, which is precisely the one they would expect back.
     */
    flush: () => {
      const fn = pending;
      clear();
      fn?.();
    },
  };
}

/**
 * What the pane body dispatch resolved to, and which FRAME it needs (myne#534).
 *
 * TWO independent decisions, deliberately not one flag.
 *
 * `fill` picks the HEIGHT regime. A filling body gets an explicit-height,
 * non-scrolling frame and owns its own scrolling; a flowing body grows inside
 * the markdown scroller. A body that renders a `<canvas>` must fill: a canvas
 * has no intrinsic height, pans internally, and inside the scroller's
 * auto-height wrapper its `height: 100%` has nothing to resolve against, so it
 * silently collapses to its intrinsic 2:1 ratio (height = width / 2).
 *
 * `gutters` picks the horizontal INSET, and it is orthogonal. A canvas wants
 * the pane edge to edge. A text body does not, at any height: PRODUCT.md's
 * fourth principle and `docs/design/README.md` both say density is comfortable
 * rather than compact, and the vault-wide task list is a text body that happens
 * to fill. Folding the two into one flag is what dropped that list's inset from
 * 24px to the 8px `TaskListPanel` carries internally, a density authored for the
 * 280px right panel it also renders in, not for a full-width pane.
 *
 * Both verdicts ride WITH the element rather than being re-derived beside the
 * dispatch, because a second expression over the same discriminants is a second
 * thing to keep in step and it was already TWO members short: the graph tab and
 * the vault-wide task tab were both rendering a filling body into the flowing
 * frame. Declared here, a new body kind cannot be added without stating both.
 */
interface PaneBody {
  el: ReactNode;
  /** Explicit height, no outer scroll: the body owns its own scrolling. */
  fill: boolean;
  /** Keep the reading gutters. False only for a full-bleed canvas. */
  gutters: boolean;
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
  const { t, i18n } = useTranslation();
  const ws = useWorkspace();
  const ctx = useSelectedNote();
  const { prefs } = usePrefs();
  // This pane is the note-editor host: it tracks only a NOTE active tab. A
  // view-kind active tab (MYND-274) maps to `null` here (no note body) until
  // the dedicated view host lands in #4 task 2; view tabs cannot yet be opened.
  const activeId: NoteId | null =
    leaf.activeTab?.kind === "note" ? leaf.activeTab.id : null;
  // The title that names this pane's editor body for assistive technology
  // (myne-md/myne#728). Read from the resolver cache, the same source the tab
  // strip's label uses, so the tab and the announcement never disagree.
  // `undefined` and `null` both mean "no title known", which the editor turns
  // into its untitled wording rather than into no name.
  const activeTitle: string | null =
    activeId === null ? null : (ctx.cache.get(activeId)?.title ?? null);
  // A view-kind active tab renders the view host (MYND-274) instead of the
  // note editor; `activeViewId` is non-null exactly then.
  const activeViewId: string | null =
    leaf.activeTab?.kind === "view" ? leaf.activeTab.id : null;
  // reading-source-modes (MYND-299): the effective view mode for this pane's
  // note tab - the tab's own per-tab mode if set, else the global
  // `editor_default_view_mode` pref, else `live`. Drives the CMEditor below
  // (re-mount-free reconfigure on change).
  // vim-keyboard-mode (MYND-313): with vim on and no explicit stored choice,
  // notes open in source view - live preview hides the markdown characters
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
  // place of the note editor - a first-class tab, no longer a modal carve-out.
  const isGraph = leaf.activeTab?.kind === "graph";
  // A tasks-kind active tab renders the vault-wide task list (MYND-616) in place
  // of the note editor - the same first-class-tab pattern the graph established.
  const isTasks = leaf.activeTab?.kind === "tasks";
  // The calendar (myne-md/myne#1037) is a first-class tab for the same reason the
  // task list is: it is a surface you keep open beside a note, not a modal.
  const isCalendar = leaf.activeTab?.kind === "calendar";
  const isAttachments = leaf.activeTab?.kind === "attachments";
  const isTemplates = leaf.activeTab?.kind === "templates";
  // An agent-kind active tab renders the agent hub (myne-md/myne#771) in place of
  // the note editor - the same first-class-tab pattern the graph and tasks tabs
  // established, and what makes "open the agent" a reveal rather than a second tab.
  const isAgent = leaf.activeTab?.kind === "agent";
  // WL-5/WL-6: the live resolver note-set fed into this pane's editor so wikilink
  // chips resolve (broken-link styling + hover R1). The hook re-evaluates on
  // every SYNC-5 index-change nonce - so a note created/renamed/loaded elsewhere
  // re-resolves the chips live, including through the async post-unlock index
  // populate the cache reference alone can miss - but hands back a fresh
  // reference only when the set actually changed, so an unrelated bump no longer
  // reconfigures this pane's editor (myne#217).
  const notes = useLiveResolverNotes();
  // **The same folder derivation the sidebar and every other picker use**
  // (myne-md/myne#913, review round five). This pane and the right panel show the
  // same agent surface, and deriving from notes here while the panel used the
  // shared derivation meant the two offered DIFFERENT folders for the same
  // control: no deliberately created empty folder, no parent that holds no note
  // directly, and a folder that survives only on an archived note still on the
  // list. `listFolderPaths` unions the live note set with `deliberate_folders`,
  // synthesizes ancestors and filters archived ones.
  //
  // Keyed on the note set's FOLDER SIGNATURE rather than on `notes`, which
  // changes identity on every save, plus the prefs that change with no note write
  // at all.
  const [agentFolders, setAgentFolders] = useState<readonly string[]>([]);
  const folderSignature = useMemo(
    () =>
      [...new Set(notes.map((n) => n.folder ?? "").filter((f) => f !== ""))]
        .sort()
        .join("\u0000"),
    [notes],
  );
  const deliberateKey = (prefs.deliberate_folders ?? []).join("\u0000");
  const archivedKey = (prefs.archived_folders ?? []).join("\u0000");
  useEffect(() => {
    // **Gated on the pane kind and given a failure path** (review round seven).
    // Without the gate every plain note pane paid a full folder read per
    // signature change for a prop only `AgentPane` reads; without the catch a
    // rejected read left `[]`, which the picker renders as a vault with no
    // folders, indistinguishable from an empty vault. On failure the note-only
    // list this pane already holds is the honest fallback.
    if (!isAgent) return;
    let cancelled = false;
    void listFolderPaths()
      .then((options) => {
        if (cancelled) return;
        setAgentFolders([...new Set(options.map((option) => option.path))].sort());
      })
      .catch(() => {
        if (cancelled) return;
        setAgentFolders(
          [...new Set(notes.map((n) => n.folder ?? "").filter((f) => f !== ""))].sort(),
        );
      });
    return () => {
      cancelled = true;
    };
    // `notes` is deliberately absent: it changes identity on every save, and the
    // signature above already tracks the only part of it this cares about. The
    // catch reads the render's own , which is correct at the moment the
    // effect fires.
  }, [isAgent, folderSignature, deliberateKey, archivedKey]);
  /** What an agent apply in THIS pane written to disk owes the rest of the app.
   *
   *  **The agent tab had no half of this at all** (myne-md/myne#894, on the
   *  user's report: "I approved the move and the sidebar did not follow it").
   *  `Editor.tsx` builds this handler for the right-panel AI chat and passes it
   *  down its own tree; the centre pane's agent tab is mounted from HERE, and
   *  this call site passed only `folders`, so an apply wrote through the backend
   *  with nothing told the sidebar: its tree is derived from its own
   *  title/folder cache, and a moved note therefore sat under its OLD folder
   *  until something unrelated re-read it. It is the same two obligations the
   *  panel's copy states, the open pane's buffer (an apply writes out of band of
   *  every autosave loop) and the sidebar's slice of each note it changed, and it
   *  differs from that copy in one deliberate way: the refreshes are caught here.
   *  A pane is a leaf whose write path must not carry an unhandled rejection out
   *  of a callback it does not own, and a sidebar re-index that failed is a stale
   *  row rather than a failed apply. */
  const agentNotesWritten = useCallback(
    (ids: readonly string[]) => {
      ctx.reloadOpenNote();
      for (const id of ids) void ctx.refreshOne(id as NoteId).catch(() => {});
    },
    [ctx],
  );
  const indexNonce = useIndexNonce();
  // writing-assistant task 6 / SYNC-14: the AI surface (slash `/devam`,
  // `/başlık` + inline ghost-text) is enabled only when `ai_enabled` AND the
  // open note is not in an `ai_excluded_folders` folder. This flows to CMEditor's
  // `aiEnabled` prop, which reconfigures the live AI compartment - so toggling
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
        // are rewritten to `![[newTitle]]` - a bare title write would orphan them.
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
  // first async build settles - `[[##` simply finds nothing until then.
  const vaultHeadings = useVaultHeadings();
  // MYND-382: the vault-wide imported-block-anchor set the `[[^^` enumerate-only
  // autocomplete searches (read from the persisted vault-indices index via one
  // IPC query; refetched on the index nonce). Empty until the first query
  // settles - `[[^^` simply finds nothing until then.
  const vaultBlockAnchors = useVaultBlockAnchors();
  // Click-to-navigate target for a resolved wikilink chip → open the note, and
  // (MYND-305) carry the GENERIC deep-link anchor so the editor scrolls to the
  // `#heading` / imported `^block-id` AFTER the note body loads. A click focuses
  // this pane (`onMouseDownCapture`), so the resolved note opens HERE; the
  // pending request is consumed by the CMEditor below once `activeId` matches and
  // its body settles. The nonce bumps per click so re-clicking the same anchor
  // re-fires the scroll.
  const [scrollAnchor, setScrollAnchor] = useState<ScrollAnchorRequest>(null);
  // Task-list click-through (myne-md/myne#656 review): scroll to a task's line.
  const [revealLine, setRevealLine] = useState<{
    noteId: string;
    line: number;
    text: string;
    nonce: number;
  } | null>(null);
  const revealTaskNonce = useRevealTaskNonce();
  useEffect(() => {
    const req = peekRevealTask();
    if (req === null || activeId === null) return;
    // NOT gated on `focused`: the click comes from the right-panel / tasks tab,
    // which does not focus this pane, and requiring focus made only the FIRST
    // click scroll (myne-md/myne#656 review). A note is open in one pane only
    // (global duplicate-forbid), so `activeId` matching is unambiguous.
    if (req.noteId !== activeId) return;
    setRevealLine({ noteId: req.noteId, line: req.line, text: req.text, nonce: req.nonce });
  }, [revealTaskNonce, activeId]);
  // reading-source-modes (MYND-299): side-by-side preview companion - a PaneView-
  // local, read-only Reading mirror of the SAME `content` buffer. It is NOT a
  // workspace item (the global duplicate-forbid `(kind,id)` invariant is
  // untouched) and writes nothing (this PaneView stays the single autosave owner).
  // The side-by-side preview companion (MYND-299) is ephemeral per-pane state in
  // the workspace context (shared with the bottom-bar "Preview" toggle). Only
  // meaningful in SOURCE mode - live renders inline, reading IS the rendered view,
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
        // restored cached scroll - flag it for the body-load effect. A same-note
        // re-click keeps the flag clear (CMEditor's scroll effect handles it) so
        // no stale flag leaks into a later plain tab-switch.
        if (noteUuid !== activeIdRef.current) {
          deepLinkOpenTargetRef.current = noteUuid as NoteId;
        }
        setScrollAnchor({ anchor, nonce: Date.now() });
      }
      // Open through the WORKSPACE, not through the sidebar's selection
      // (myne-md/myne#601). `ctx.open` only sets `selectedId` and reads the
      // body; the tab it eventually produces comes from the bridge effect in
      // `screens/Editor.tsx`, which opens one ONLY when the note is not already
      // in a pane, so a link to an already-open note did nothing at all, and so
      // did a link to whatever was already selected. Both are the common case
      // once a few tabs are open, which is what "clicking a backlink does not go
      // to the note" was. `openInFocused` reveals an open note and opens a
      // closed one, which is what a link click means either way.
      ws.openInFocused(noteUuid as NoteId);
    },
    [ws],
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
  // was DERIVED from, and it is set by exactly ONE producer - the autosave
  // `updated:` patch echo (`handleSaveEcho` below). Every other producer is
  // authoritative (disk load, swap restore, out-of-band reload, keep-both
  // adopt, drawing scene write, the editor's own `onChange`) and leaves it
  // undefined, which the `setContent` wrapper guarantees BY CONSTRUCTION -
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
  // is exactly the case where `prev` IS the text the patch was derived from -
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
  // by the primary CMEditor's `onSwapReady` (null while unmounted - e.g. a drawing
  // tab - in which case we fall back to the plain content-mirror path).
  const swapApiRef = useRef<EditorSwapApi | null>(null);
  const stateCacheRef = useRef<Map<NoteId, EditorState>>(new Map());
  const prevActiveIdRef = useRef<NoteId | null>(null);

  // MYND-305 × MYND-534: the target note-id of an in-flight deep-link OPEN (a
  // wikilink chip carrying an anchor that switches to a DIFFERENT note). Set by
  // `handleOpenWikilink`, consumed once by the body-load effect: when the load
  // for that note runs, the anchor owns the scroll, so the note lands at the TOP
  // (anchor `scrollIntoView` / §5.6 not-found fallback take over) instead of its
  // restored cached scrollTop. Only set for cross-note opens so it never leaks a
  // stale flag into a later plain tab-switch (which must restore cached scroll).
  const deepLinkOpenTargetRef = useRef<NoteId | null>(null);

  // myne-md/myne#600: the note whose remembered reading position still has to be
  // put back, once its body is on screen. Set by the disk-read path (a first
  // open in this pane, which is what a SPLIT produces), consumed once by the
  // effect below. The cached-swap path needs none of this: the state it applies
  // already holds the document, so it restores inline.
  const pendingScrollRestoreRef = useRef<NoteId | null>(null);

  // MYND-534: evict cached EditorStates for notes no longer open in this pane (a
  // closed tab), so the cache is bounded by the pane's open-tab count and a
  // reopen starts fresh (grill Q3 - tab-switch-only lifetime).
  const openNoteTabKey = leaf.tabs
    .filter((t) => t.kind === "note")
    .map((t) => t.id)
    .join("\u0000");
  // The pane's note-tab set as of the previous pass. This, and not the state
  // cache, is what makes a CLOSED tab identifiable: `evictClosedTabs` carries
  // the reasoning, including why the cache's keys answer a different question.
  const openNoteIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const open = new Set(
      leaf.tabs.filter((t) => t.kind === "note").map((t) => t.id),
    );
    // The reading position goes with the state (myne-md/myne#600): closing a tab
    // is the reader saying they are done with it.
    evictClosedTabs(openNoteIdsRef.current, open, stateCacheRef.current);
    openNoteIdsRef.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openNoteTabKey]);

  // --- Live outline scroll tracking (outline-scroll-tracking) ------------------
  // The focused pane publishes its topmost visible heading to the panel-level
  // Outline tab (a separate render subtree) through the `activeHeadingSignal`
  // store, so the tab can highlight the current section and keep it in view.
  // Heading positions come from the SAME `headingSections` parser the tab uses,
  // so the `from` offsets join exactly once the buffer matches disk.
  //
  // DEFERRED because this is the whole document parsed on every keystroke.
  // `CMEditor`'s `onChange` mirrors each keystroke straight back into `content`,
  // so a bare `[content]` dep re-parsed the entire note inside the urgent render
  // pass: measured 19.2 ms at 100 KB, 91.5 ms at 531 KB, 406 ms at 2 MB on the
  // typing path, plus the effect below's DOM reads on each of those passes.
  // `useDeferredValue` leaves the urgent render on the previous value and
  // coalesces the parses into one background pass, so the keystroke no longer
  // waits for it. The cost is that the outline highlight can lag the caret by
  // one pass, which is a highlight, not the buffer.
  //
  // Do NOT replace this with a line regex: the parser excludes headings inside
  // frontmatter bodies (the Setext trap `title: … \n ---`) and inside fenced
  // code, which a line scan cannot.
  const deferredContent = useDeferredValue(content);
  const headingFroms = useMemo(
    () => headingSections(deferredContent).map((h) => h.from),
    [deferredContent],
  );
  const headingFromsRef = useRef<number[]>(headingFroms);
  const outlineViewRef = useRef<OutlineTrackView>(null);
  // The same view as `outlineViewRef`, in state - see `handleEditorReady`.
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
  // Close this pane's live session when the pane unmounts (`collab-editor-bridge`
  // task 8). Read through the ref so the effect runs the CURRENT note id and is
  // not re-subscribed on every note switch.
  useEffect(
    () => () => {
      const id = activeIdRef.current;
      if (id !== null) void closeLiveNote(id);
    },
    [],
  );
  // Deliver a merge into the OPEN live note (`collab-editor-bridge` task 7). The
  // cycle merged it into the session; the shared drain reads the session, maps
  // the remote change over this pane's unsaved text and applies it as ONE
  // CodeMirror change, so the buffer catches up WITHOUT the reload a dirty pane
  // skips. It replaced applying the queued body splices at their raw offsets
  // (myne-md/myne#849 review round 4): those are clamped to the body, so a peer's
  // rename, retag, move or trash never reached this buffer and the next autosave
  // wrote the old frontmatter back over it. `@myne/editor/live-remote-merge`
  // carries the full argument; the mobile editor runs the same module.
  //
  // `sessionMirrorRef` is this pane's record of what the session holds as far as
  // the buffer knows: the text it loaded or adopted, the text each of its own
  // autosaves SENT (`liveSaveFor` below), and each merge the drain applied.
  // Another writer's patch does not move it, so the drain still delivers that
  // change; the autosave hands it to the core as `base`, which is what makes a
  // save from a buffer that has not caught up merge rather than replace.
  // Keyed per note rather than holding the open note's alone (myne-md/myne#849
  // review round 5): the note-switch flush saves the OUTGOING note after the
  // incoming one has loaded, and it needs the outgoing note's mirror as its base.
  const sessionMirrorRef = useRef<Map<string, string>>(new Map());
  const drainRef = useRef<RemoteMergeDrain | null>(null);
  const resyncRef = useRef<(id: string) => void>(() => {});
  useEffect(() => {
    const drain = installRemoteMergeDrain({
      listen: (event, handler) => listen<string>(event, handler),
      currentNoteId: () => activeIdRef.current,
      takeSplices: takeRemoteSplices,
      settled: settledPatches,
      patchEpoch,
      readSession: readLiveNote,
      sessionText: (id) => sessionMirrorRef.current.get(id) ?? null,
      setSessionText: (id, text) => {
        sessionMirrorRef.current.set(id, text);
      },
      buffer: () => outlineViewRef.current?.state.doc.toString() ?? contentRef.current,
      deliver: (splices) => {
        const view = outlineViewRef.current;
        if (view !== null) {
          view.dispatch(remoteDispatchSpec(view.state, splices));
          return;
        }
        // No view (a drawing note, or the body still loading): the change goes to
        // the buffer string, so the next save carries it rather than deleting it.
        const next = applySplicesToText(contentRef.current, splices);
        contentRef.current = next;
        setContent(next);
      },
      resync: (id) => resyncRef.current(id),
    });
    drainRef.current = drain;
    return () => {
      drainRef.current = null;
      drain.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The awareness store (`collab-presence-ui` task 3): the peers editing THIS pane's
  // note, fed from the live channel (`sync://awareness`) and pushed into the editor.
  // Reset on a note change (awareness for note A never reaches note B); cleared on
  // unmount, which is how a lock / vault leave reaches a pane.
  //
  // `dropFlushRef` carries THIS pane's durable flush into the drop listener below
  // (`collab-editor-bridge` task 7). It is a ref rather than a captured closure
  // because the flush is defined far below (it needs the autosave hook), while
  // this listener is registered once on mount.
  const dropFlushRef = useRef<(() => Promise<boolean>) | null>(null);
  // Live presence (`collab-presence-ui`): this pane's local caret/selection is
  // reported to the awareness supervisor so peers render its cursor. Trailing-
  // throttled to the awareness coalescing floor (`SYNC-5`) so a fast caret does not
  // flood the IPC; a no-op for a note with no live session.
  const presenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const presenceLastRef = useRef<{ cursor: number | null; selection: [number, number] | null } | null>(
    null,
  );
  const handleCursorChange = useCallback(
    (cursor: number | null, selection: [number, number] | null) => {
      presenceLastRef.current = { cursor, selection };
      if (presenceTimerRef.current !== null) return;
      presenceTimerRef.current = setTimeout(() => {
        presenceTimerRef.current = null;
        const noteId = activeIdRef.current;
        const latest = presenceLastRef.current;
        if (noteId === null || latest === null) return;
        reportLivePresence(noteId, latest.cursor, latest.selection);
      }, PRESENCE_REPORT_MS);
    },
    [],
  );
  useEffect(
    () => () => {
      if (presenceTimerRef.current !== null) clearTimeout(presenceTimerRef.current);
    },
    [],
  );
  const awareness = useSyncExternalStore(subscribeAwareness, getAwarenessSnapshot);
  // The CMEditor `awareness` prop: memoized so it is a STABLE object across renders.
  // A fresh object here re-dispatches the editor's decoration effect on EVERY render
  // of this pane, including renders caused by unrelated state.
  //
  // The label is RESOLVED here, because the editor package's `AwarenessPeer.label` is
  // a plain string (its decoration widget has no translator and rebuilds on editor
  // state, not on a language switch). Resolving at the push keeps i18n out of the
  // shared editor package, and `i18n.language` is in the deps so the one thing that
  // must invalidate the memo, a language change, does: without it the caret label
  // would keep the previous language for as long as the pane stayed mounted, which
  // is the freeze the descriptor exists to prevent one layer up.
  const paneAwareness = useMemo(
    () =>
      activeId !== null
        ? {
            noteId: activeId,
            peers: [...awarenessNotePeers(awareness, activeId).values()].map((p) => ({
              ...p,
              label: p.label === null ? "" : identityLabelText(p.label, t),
              colorVar: colorVarForIndex(p.color),
            })),
          }
        : undefined,
    [awareness, activeId, t, i18n.language],
  );
  // Resolve each un-attributed peer's label through the backend identity resolver
  // (`collab-provenance` task 2, `collab-presence-ui` task 1). A presence frame carries
  // no name THIS STORE MAY USE, and `awarenessUpsert` discards the one the wire carries
  // (`member-devices` task 5), so without this every roster row and caret label renders
  // the degraded device form. The store flips `unAttributed` off once resolved, so
  // this does not re-resolve the same peer.
  //
  // The label RULE is `resolvedIdentityLabel`, shared with the version history
  // (`member-devices` task 5): presence and history must name one device the same
  // way, and the two hand-written switches had already drifted apart. The loop
  // itself lives in `collab/presenceLabels` so it is testable without a pane
  // harness. That loop takes no translator: what it writes into the store is the
  // label DESCRIPTOR, resolved at each surface's own render (`identityLabel.ts`), so
  // a resolved string cannot be frozen into the store for the life of the peer.
  useEffect(() => {
    if (activeId === null) return;
    void resolvePeerLabels(awarenessNotePeers(awareness, activeId).values(), resolveIdentity);
  }, [awareness, activeId]);
  useEffect(() => {
    let disposed = false;
    let unlistenUpdate: (() => void) | null = null;
    let unlistenDrop: (() => void) | null = null;
    let sweepTimer: ReturnType<typeof setTimeout> | null = null;
    void listen<PresenceUpdate>("sync://awareness", (event) => {
      if (disposed) return;
      setAwareness((s) => awarenessUpsert(s, event.payload));
    }).then((fn) => {
      if (disposed) fn();
      else unlistenUpdate = fn;
    });
    // A stream drop starts the grace window; the peers are cleared only if the
    // stream does not come back within it, so a reconnect does not flicker.
    void listen("sync://awareness-dropped", () => {
      if (disposed) return;
      // Eager flush (`collab-editor-bridge` task 7): the live channel may not come
      // back, and a pending durable save must land either way. Firing the pane's
      // own flush here is also what lets the next durable pull's reload run ,
      // `ctx.reloadOpenNote()` early-returns while this pane has pending work, so a
      // dropped channel with an unflushed keystroke would otherwise hold the pane
      // on its stale buffer. The durable blob plane (the `note_update` funnel plus
      // the periodic sync pull) does not depend on the awareness stream, so this
      // flush is the whole of the editor-side fallback. Fire-and-forget; the
      // autosave state machine surfaces any failure in its own status.
      if (dropFlushRef.current !== null) void dropFlushRef.current();
      setAwareness((s) => awarenessOnDrop(s, Date.now()));
      if (sweepTimer !== null) clearTimeout(sweepTimer);
      sweepTimer = setTimeout(() => {
        setAwareness((s) => awarenessSweep(s, Date.now()));
      }, AWARENESS_GRACE_MS);
    }).then((fn) => {
      if (disposed) fn();
      else unlistenDrop = fn;
    });
    // The roster's click-to-jump (`collab-presence-ui` task 4): the "Who's here"
    // row dispatches this event; the pane whose ACTIVE note matches reveals the
    // peer's line. Without this listener the roster's click is inert.
    const onPresenceJump = (e: Event) => {
      if (disposed) return;
      const detail = (e as CustomEvent<PresenceJumpDetail>).detail;
      const id = activeIdRef.current;
      if (detail === undefined || id === null || detail.noteId !== id) return;
      // The shared derivation, the same one the mobile screen calls, so the two
      // cannot drift (myne-md/myne#849 review).
      setRevealLine(presenceRevealFor(id, contentRef.current, detail.offset, Date.now()));
    };
    window.addEventListener(PRESENCE_JUMP_EVENT, onPresenceJump);
    return () => {
      disposed = true;
      if (unlistenUpdate !== null) unlistenUpdate();
      if (unlistenDrop !== null) unlistenDrop();
      window.removeEventListener(PRESENCE_JUMP_EVENT, onPresenceJump);
      if (sweepTimer !== null) clearTimeout(sweepTimer);
      // NO `clearAwareness()` here. The store is MODULE-scope, so an unmount clear
      // would wipe the peers a SURVIVING split pane is still rendering (closing one
      // of two panes unmounts only that one). The vault-leaving paths that must drop
      // it (lock, switch, delete) call `clearAwareness()` themselves, and
      // `check-frontend-lock-teardown.mjs` holds each of them to it.
    };
  }, []);

  // Resolve the heading currently at the top of the viewport: the last heading
  // whose block sits at or above the viewport top. The editor GROWS to fit its
  // content inside an OUTER scroller (`view.scrollDOM` / `.cm-scroller` does not
  // scroll here), so measure in window coords - the content-top rect plus each
  // heading's always-available height-map offset - against the scroller's top.
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
    // at (within 1px of) max scroll, the LAST heading is the active one - this
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

  // myne-md/myne#600: put a first-opened note's remembered line back, once its
  // body is actually on screen. Fires on `content` because that is when the view
  // holds the document the anchor refers to; the pending ref makes it once per
  // open rather than once per keystroke. `editorView` is a dep too: a SPLIT
  // remounts this pane, `content` lands while `outlineViewRef` is still null
  // (the editor child has not mounted), and without a re-run when the view
  // arrives the pending restore is left set and never applied — the pane opens
  // at the top while the anchor sits in the ref. Same shape as MYND-617's
  // ref-vs-state split above: a ref does not re-render, so it cannot re-run
  // this effect.
  //
  // And the pending ref stays set until the scroller HAS a range (myne#600
  // sm2). Clearing it before `scrollIntoView` runs against a host that cannot
  // yet move is a one-shot no-op: CodeMirror has not finished measuring, the
  // tabpanel's `scrollHeight` still equals `clientHeight`, and there is no
  // ResizeObserver arm for a pure height growth (width is unchanged by the
  // measure). The anchor is spent, nothing re-runs, and the pane stays at the
  // top for the life of the open — which is exactly the split symptom. Retry
  // on rAF until there is room to scroll, with a frame budget so a pane that
  // never grows (a short note, a filling body) still settles.
  useEffect(() => {
    const noteId = pendingScrollRestoreRef.current;
    if (noteId === null || noteId !== activeId) return;
    const view = outlineViewRef.current;
    if (view === null || view.state.doc.length === 0) return;

    // Nothing remembered for this note: land at top NOW, outside the
    // stable-wait loop below. A deferred no-anchor apply runs `scrollTop = 0`
    // whenever measure settles, which can land AFTER a scroll already made on
    // this pane (sm2's pre-split `scrollTo(1200)`): the reset fires a scroll
    // event, the settle remember saves pos=0, and every later restore opens
    // the note at the top. A fresh mount is already at 0, so the only write
    // here is clearing a leftover offset from a previous note in this pane.
    const anchorNow = recallScroll(noteId);
    const scroller0 = outlineScrollerRef.current;
    if (anchorNow === undefined) {
      pendingScrollRestoreRef.current = null;
      if (scroller0 !== null) {
        scroller0.dataset.scrollRestore = "none";
        if (scroller0.scrollTop !== 0) scroller0.scrollTop = 0;
      }
      return;
    }

    const apply = (
      v: NonNullable<OutlineTrackView>,
      sc: HTMLElement | null,
    ): void => {
      pendingScrollRestoreRef.current = null;
      const anchor = recallScroll(noteId);
      if (sc !== null) {
        sc.dataset.scrollRestore = anchor === undefined ? "none" : "anchor";
        if (anchor !== undefined) {
          sc.dataset.scrollAnchorApplied = String(anchor.pos);
          sc.dataset.scrollAnchorOffset = String(anchor.offsetPx);
        }
      }
      if (anchor === undefined) {
        if (sc !== null) sc.scrollTop = 0;
        return;
      }
      // **A remembered position of ZERO is the pane's default, so applying it can
      // only ever MOVE somebody.** Every freshly opened note is already at the
      // top, which means a `pos: 0` anchor adds nothing on the open it was
      // recorded for — and it does damage on a later one: a body written through
      // `note_update` re-runs this effect, the anchor from the moment the note was
      // still empty is still `0`, and the deferred apply then fires after the
      // reader (or a scenario) has scrolled, marks the restore window, and
      // suppresses their own write-back for 500 ms.
      //
      // Measured 2026-10-25 on `scroll-memory` sm2: `liveTop=1200|pos=0|
      // write=suppressed|restore=anchor|frames=3|stable=2|applied=0` — the apply
      // landed three frames in over a pane already at 1200, and the position the
      // reader had was never remembered. Skipping it leaves the pane where the
      // reader put it and lets the settle remember write a real anchor.
      if (anchor.pos === 0 && sc !== null && sc.scrollTop > 4) {
        sc.dataset.scrollRestore = "skip-top";
        return;
      }
      applyScrollAnchor(v, anchor, noteId);
    };

    // Wait for CodeMirror's first measure to settle, not merely for a scroll
    // range. On a split remount the view is brand new: `scrollHeight` can
    // already exceed `clientHeight` while line positions are still being
    // measured, and `scrollIntoView` then no-ops or lands a few pixels from
    // the top (sm2's `[4]` with `restore=anchor`). Stability of the outer
    // height across frames is the cheap signal that measure has caught up.
    // Only a real anchor reaches this loop (the no-anchor arm returns above).
    const scroller = outlineScrollerRef.current;
    if (scroller !== null) scroller.dataset.scrollRestore = "pending";

    let frames = 0;
    let lastHeight = -1;
    let stable = 0;
    let raf = 0;
    const tick = (): void => {
      raf = 0;
      // A newer open took the pending ref; this retry is stale.
      if (pendingScrollRestoreRef.current !== noteId) return;
      const v = outlineViewRef.current;
      if (v === null || v.state.doc.length === 0) return; // keep pending; editorView/content will re-run us
      const sc = outlineScrollerRef.current;
      frames += 1;
      const h = sc === null ? 0 : sc.scrollHeight;
      const range = sc !== null && h > sc.clientHeight + 1;
      if (range && h === lastHeight) stable += 1;
      else stable = 0;
      lastHeight = h;
      if (sc !== null) {
        sc.dataset.scrollRestoreFrames = String(frames);
        sc.dataset.scrollStable = String(stable);
      }
      // Two consecutive equal heights with a range: apply. Frame budget keeps
      // a pane that never settles (short note, filling body) from spinning.
      if ((range && stable >= 2) || frames >= 90) {
        apply(v, sc);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, [content, activeId, editorView]);

  // myne-md/myne#600: a width change re-wraps the text, so the pixel the reader
  // was at now points at different content, so put the LINE back instead. This is
  // the second half of the split complaint: the pane that survives a split is
  // not remounted, it is merely narrower.
  useEffect(() => {
    const scroller = outlineScrollerRef.current;
    if (scroller === null || typeof ResizeObserver === "undefined") return;
    let lastWidth = scroller.clientWidth;
    const settle = trailingEdge(SCROLL_SETTLE_MS);
    // myne-md/myne#652: never move the viewport out from under a pointer.
    //
    // The reported symptom was a click that jumped the editor 10-20 lines and
    // selected everything it skipped. This restore is how: `clientWidth` changes
    // for reasons that have nothing to do with the sidebar, most often the
    // vertical scrollbar appearing or disappearing as the rendered height
    // crosses the viewport, which a click can cause on its own by revealing a
    // line's markup and making it taller. The restore then scrolls while the
    // button is still down, and the browser reads the jump as a drag, so the
    // skipped range is selected.
    //
    // Suppressing rather than deferring is the right half: the reader is looking
    // at where they clicked, and putting a remembered line back is exactly what
    // they do not want at that moment. A later resize restores as normal.
    let pointerDown = false;
    const onPointerDown = () => {
      pointerDown = true;
    };
    const onPointerUp = () => {
      pointerDown = false;
    };
    scroller.addEventListener("pointerdown", onPointerDown);
    // On `window`, not the scroller: a drag that ends outside the pane (over the
    // sidebar, past the window edge) never delivers `pointerup` to the scroller,
    // and a flag stuck on would disable the restore for the rest of the session.
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    // Coalesced to the end of the resize, not per observation. Dragging the
    // split divider fires this once per frame, and each firing dispatched a
    // CodeMirror transaction carrying a `scrollIntoView`, whose own scroll then
    // re-entered the handler above. One restore when the drag stops is the whole
    // of what the reader wants anyway.
    const observer = new ResizeObserver(() => {
      const width = scroller.clientWidth;
      if (width === lastWidth) return; // height-only change: nothing re-wrapped
      lastWidth = width;
      scroller.dataset.scrollRoWidth = String(width);
      settle.run(() => {
        if (pointerDown) return; // myne#652, see the listeners above.
        const view = outlineViewRef.current;
        const noteId = activeIdRef.current;
        if (view === null || noteId === null) {
          scroller.dataset.scrollRo = "skip-null";
          return;
        }
        const anchor = recallScroll(noteId);
        scroller.dataset.scrollRo = anchor === undefined ? "no-anchor" : "apply";
        if (anchor !== undefined) applyScrollAnchor(view, anchor, noteId);
      });
    });
    observer.observe(scroller);
    return () => {
      settle.cancel();
      observer.disconnect();
      scroller.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, []);

  // Watch the pane's real scroll container with a rAF-throttled listener. Stable
  // across note switches - the view handle is read live via the ref, so a
  // not-yet-ready view simply no-ops until `onReady` fires.
  useEffect(() => {
    const scroller = outlineScrollerRef.current;
    if (scroller === null) return;
    let raf = 0;
    const settle = trailingEdge(SCROLL_SETTLE_MS);
    // myne-md/myne#600: remember on every SETTLED scroll, not only when the note
    // changes. A pane can leave without any effect seeing it (a split unmounts
    // it outright), and the last thing the reader did before that is exactly
    // what they expect back.
    //
    // On a trailing timeout rather than inside the rAF above, because
    // `rememberScroll` reads two bounding rects and runs a hit test, and the
    // anchor is only ever CONSUMED on a note switch, an unmount or a resize.
    // Per-frame precision buys nothing and cost two forced layout flushes per
    // frame in every mounted pane, including the ones `recomputeActiveHeading`
    // deliberately early-returns for because they are not focused.
    const rememberSoon = () =>
      settle.run(() => {
        const view = outlineViewRef.current;
        const noteId = activeIdRef.current;
        if (view !== null && noteId !== null) rememberScroll(noteId, view, scroller);
      });
    const onScroll = () => {
      // A genuine scroll while a restore is still pending means the reader
      // (or a test) already took the pane over. Apply the pending line later
      // and it yanks them back — measured as sm2's pre-split `liveTop=4`
      // with `write=suppressed`: an early pos=0 anchor from the empty note
      // waited out the stable-measure loop, fired within the settle window of
      // `scrollTo(1200)`, and the user's own remember was then suppressed.
      // A restore's own scroll cannot hit this: `apply` clears `pending`
      // before it dispatches, and that path sits inside the suppression mark.
      const pending = pendingScrollRestoreRef.current;
      if (pending !== null && !isRestoringScroll(pending)) {
        pendingScrollRestoreRef.current = null;
        scroller.dataset.scrollRestore = "cancelled-by-scroll";
      }
      rememberSoon();
      if (raf !== 0) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        recomputeActiveHeading();
      });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      // Flush, not cancel: see `trailingEdge`. The callback null-checks the view
      // and the note, so this is inert on the unmount paths where the editor
      // child has already cleared the ref, and it is the effect re-running (a
      // new `recomputeActiveHeading`) that it reliably saves a scroll from.
      settle.flush();
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

  // myne#653's third criterion: the caret lands in the new note's title field.
  //
  // Creating a note no longer opens the sidebar's inline rename, and a note
  // with a `title:` field that nobody is in is only two thirds of the fix: the
  // user still has to find where the name goes. This puts them there.
  //
  // Keyed on the id rather than on a boolean so it fires once per created note,
  // and guarded on THIS pane showing it so a split does not fight over focus.
  // A `querySelector` rather than a ref because the field is a CodeMirror
  // widget's DOM, rebuilt on every decoration pass, so a ref captured here
  // would be stale by the time the note's body has mounted.
  const focusedCreateRef = useRef<NoteId | null>(null);
  useEffect(() => {
    const created = ctx.justCreatedId;
    if (created === null || created !== activeId || !focused) return;
    if (focusedCreateRef.current === created) return;
    const scroller = outlineScrollerRef.current;
    if (scroller === null) return;
    // Next frame: the body has just been handed to the editor and the
    // frontmatter widget is built during its first measure pass.
    const raf = requestAnimationFrame(() => {
      const field = scroller.querySelector<HTMLInputElement>(
        `[data-testid="${TITLE_FIELD_TESTID}"]`,
      );
      if (field === null) return;
      focusedCreateRef.current = created;
      field.focus();
      field.select();
    });
    return () => cancelAnimationFrame(raf);
  }, [ctx.justCreatedId, activeId, focused, content]);

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
  // AI switches and on the host actually having local AI - the Rust side refuses
  // regardless (task 4), but an off feature should not be arming idle timers or
  // building prompts that carry note text.
  const enabledForTagPass =
    capabilities.has("localAi") &&
    prefs.ai_enabled === true &&
    prefs.auto_tag_enabled === true;
  const { suggestions: tagSuggestions, dismiss: dismissTagSuggestion } = useTagSuggestions({
    noteId: activeId,
    body: content,
    folder: activeNoteFolder,
    enabled: enabledForTagPass,
    excludedFolders: prefs.ai_excluded_folders,
  });

  // A chip click → the ONE accept path (task 6). `false` means nothing was
  // written - the note already carries the tag, or its frontmatter is a shape
  // the writer refuses to touch - and in both cases the user's intent is already
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

  // --- Automatic tagging (myne-md/myne#908) -----------------------------------
  //
  // Writes happen at most ONCE per note per session, and only for a note the
  // user actually edited here. The pass re-fires on every content change, so
  // "write on every pass" is the shape that turns a note into tag confetti: a
  // model that emits a variant each time ("myne", then "myne-app") would keep
  // adding, and nothing would report it. The once-per-session rule costs one Set
  // and needs no number to defend later.
  const [autoApplyTags, setAutoApplyTags] = useState<boolean>(() => readAutoApplyTags());
  useEffect(() => subscribeAutoApplyTags(setAutoApplyTags), []);
  const [autoAppliedRow, setAutoAppliedRow] = useState<{
    noteId: NoteId;
    tags: string[];
  } | null>(null);
  const autoAppliedNotesRef = useRef<Set<NoteId>>(new Set());
  const editedNotesRef = useRef<Set<NoteId>>(new Set());

  // A user edit, and ONLY a user edit: this is the CMEditor `onChange` handler,
  // not the buffer's authoritative writers, so a disk load or a save echo cannot
  // mark a note as edited and make it eligible for an automatic write.
  const handleUserChange = useCallback(
    (next: string | ((prev: string) => string)) => {
      const id = activeIdRef.current;
      if (id !== null) editedNotesRef.current.add(id);
      setContent(next);
    },
    [setContent],
  );

  useEffect(() => {
    if (activeId === null) return;
    const view = editorView;
    if (view === null) return;
    const allowed = shouldAutoApply({
      enabled: autoApplyTags,
      passEnabled: enabledForTagPass,
      hasSuggestions: tagSuggestions.length > 0,
      editedThisSession: editedNotesRef.current.has(activeId),
      alreadyApplied: autoAppliedNotesRef.current.has(activeId),
      readOnly: view.state.readOnly,
    });
    if (!allowed) return;
    const tags = tagSuggestions.map((chip) => chip.tag);
    const landed: string[] = [];
    for (const tag of tags) {
      if (acceptTagIntoView(view, tag)) landed.push(tag);
    }
    autoAppliedNotesRef.current.add(activeId);
    // Nothing landed: every tag was already present or the frontmatter is a
    // shape the writer refuses. Leave the chips up, which is the reader's only
    // way to see why.
    if (landed.length > 0) setAutoAppliedRow({ noteId: activeId, tags: landed });
  }, [autoApplyTags, enabledForTagPass, tagSuggestions, activeId, editorView]);

  // Undo recomputes the removal against the CURRENT document, so it still works
  // after further typing, and a tag the user already removed by hand resolves to
  // null rather than sitting there as a dead button.
  const handleUndoAutoApplied = useCallback(() => {
    const row = autoAppliedRow;
    const view = editorView;
    if (row === null || view === null) return;
    let removed = false;
    for (const tag of row.tags) {
      const edit = computeTagRemoveEdit(view.state.doc.toString(), tag);
      if (edit === null) continue;
      view.dispatch({
        changes: { from: edit.from, to: edit.to, insert: edit.insert },
        userEvent: "ai.undo-auto-tag",
      });
      removed = true;
    }
    if (removed) setAutoAppliedRow(null);
  }, [autoAppliedRow, editorView]);

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
    // NEVER break the switch - on failure we drop the swap API and reload.
    if (api !== null && prevId !== null && prevId !== activeId) {
      try {
        cache.set(prevId, api.captureState());
        // myne-md/myne#600: the reading position is remembered as a DOCUMENT
        // anchor, in a module-level map, so it survives the split that unmounts
        // this pane and the re-wrap that a narrower pane causes. The pixel the
        // cache used to carry alongside the state survived neither.
        const outgoingView = outlineViewRef.current;
        if (outgoingView !== null && scroller !== null) {
          rememberScroll(prevId, outgoingView, scroller);
        }
      } catch {
        swapApiRef.current = null;
        api = null;
      }
    }
    prevActiveIdRef.current = activeId;
    // myne-md/myne#601: becoming a pane's active note IS the "touched" signal
    // the `[[` picker orders by. Recorded here because this effect is where
    // every way of opening a note converges, whatever opened it.
    if (activeId !== null) noteBecameActive(activeId);

    // Live-session lifecycle (`collab-editor-bridge` task 8): the incoming note
    // opens a session (idempotent, a second pane showing the same note ATTACHES
    // to the one session), and the outgoing note's session is closed AFTER its
    // buffer is flushed, in the `flushOutgoing().then` blocks below. Best-effort:
    // a drawing note or a locked vault stays on the durable path.
    const opened = activeId !== null ? openLiveNote(activeId) : null;
    // Once the session is open AND the buffer is baselined, drain once with no
    // event: a durable pull that landed between the body's read and the session's
    // open is in the session and raised no merge event for this pane.
    const catchUpOnceOpen = (id: NoteId) => {
      void opened?.then(() => drainRef.current?.catchUp(id));
    };

    if (activeId === null) {
      setContent("");
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    // MYND-305 × MYND-534: is THIS open driven by a deep-link (a wikilink chip
    // carrying an anchor that switched to this note)? If so the anchor owns the
    // scroll - restoring the note's cached scrollTop would clobber both the
    // anchor's `scrollIntoView` AND the §5.6 not-found fallback, which relies on
    // the note opening at the TOP (a not-found anchor scrolls nowhere). Consumed
    // once here so a later plain tab-switch restores the note's own cached scroll.
    const anchorDrivenOpen = deepLinkOpenTargetRef.current === activeId;
    if (anchorDrivenOpen) deepLinkOpenTargetRef.current = null;

    // Cached + swap API live → try an instant restore (no disk read, no loading
    // gate). ANY failure degrades to the disk-reload path below, which always
    // clears `loading` - so a bad swap can never strand the pane in a loading
    // state (the MYND-534 pane-op regression).
    const cached = api !== null ? cache.get(activeId) : undefined;
    if (api !== null && cached !== undefined) {
      let swapped = false;
      try {
        api.applyState(cached);
        swapped = true;
      } catch {
        swapApiRef.current = null; // view unusable → force a clean reload
      }
      if (swapped) {
        const doc = cached.doc.toString();
        setContent(doc);
        // The cached state was flushed when the pane left this note, so it is
        // what the session was opened from; the catch-up brings in anything since.
        sessionMirrorRef.current.set(activeId, doc);
        catchUpOnceOpen(activeId);
        // myne#288 - flush the OUTGOING note before baselining the incoming one.
        //
        // This effect is registered before `useAutosave`'s own note-change
        // effect, so it runs first: `acceptReloadedBody` used to clear `dirtyRef`
        // and re-baseline `savedBodyRef` while the hook still believed it was
        // editing the previous note. By the time the hook noticed the switch
        // there was nothing left to flush, and up to ~10 s of typing was gone -
        // silently, because the cached EditorState put the text back on screen
        // and the status read `clean`.
        //
        // `flushOutgoing` saves for whatever note the hook still holds, which at
        // this point is the previous one.
        // Flush the outgoing note, THEN refresh its row title: a title/H1 edit
        // made just before the switch flushes here (not through the saved-status
        // path), so without this its sidebar cache title stays stale and the row
        // (and every view over it) reads "Untitled".
        const outgoingId = prevId;
        void autosaveRef.current?.flushOutgoing().then(() => {
          // Flush the outgoing buffer through its live session FIRST, then close
          // the session (task 8). Closing before the flush would drop the session
          // before the autosave lands and fall the save back to the stateless path.
          if (outgoingId !== null) void closeLiveNote(outgoingId);
          if (outgoingId !== null && outgoingId !== activeIdRef.current) {
            sessionMirrorRef.current.delete(outgoingId);
          }
          if (outgoingId !== null) void ctx.refreshOne(outgoingId).catch(() => {});
        });
        autosaveRef.current?.acceptReloadedBody(doc);
        setLoading(false);
        // Anchor-driven open → land at the top and let the anchor effect take it
        // to the heading; otherwise put the note's own remembered line back.
        const remembered = anchorDrivenOpen ? undefined : recallScroll(activeId);
        const swappedView = outlineViewRef.current;
        if (remembered === undefined) {
          requestAnimationFrame(() => {
            if (!cancelled && scroller !== null) scroller.scrollTop = 0;
          });
        } else if (swappedView !== null) {
          applyScrollAnchor(swappedView, remembered, activeId);
        }
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
        sessionMirrorRef.current.set(activeId, body);
        catchUpOnceOpen(activeId);
        // Same ordering hazard as the cached-swap path above (myne#288).
        // Flush the outgoing note, THEN refresh its row title: a title/H1 edit
        // made just before the switch flushes here (not through the saved-status
        // path), so without this its sidebar cache title stays stale and the row
        // (and every view over it) reads "Untitled".
        const outgoingId = prevId;
        void autosaveRef.current?.flushOutgoing().then(() => {
          // Flush the outgoing buffer through its live session FIRST, then close
          // the session (task 8). Closing before the flush would drop the session
          // before the autosave lands and fall the save back to the stateless path.
          if (outgoingId !== null) void closeLiveNote(outgoingId);
          if (outgoingId !== null && outgoingId !== activeIdRef.current) {
            sessionMirrorRef.current.delete(outgoingId);
          }
          if (outgoingId !== null) void ctx.refreshOne(outgoingId).catch(() => {});
        });
        autosaveRef.current?.acceptReloadedBody(body);
        // myne-md/myne#600: a note read from disk has no view holding it yet, so
        // the loading gate rebuilds one and the body arrives through the value
        // mirror. Hand the restore to the effect below, which fires once the
        // content is on screen. This is the SPLIT path: the new pane has no
        // cached state, but the reading position is remembered outside the pane.
        pendingScrollRestoreRef.current = anchorDrivenOpen ? null : activeId;
        if (anchorDrivenOpen) {
          requestAnimationFrame(() => {
            if (!cancelled && scroller !== null) scroller.scrollTop = 0;
          });
        }
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
  // that MOUNTS with an active note (a split/remount - the initial single pane
  // mounts with no selection) otherwise burns useAutosave's "first body change
  // is loaded content" token on the transient empty body, so the real body's
  // arrival registered as a user edit and γ1 silently REWROTE the note ~1s
  // later - a no-op body with a fresh nonce + fresh `updated:`, which the sync
  // engine can only read as a local edit (false-conflict fodder; caught by the
  // unfocused-split-pane E2E). The id flip to `null` resets the token; the
  // loaded body then lands in the same commit as the id flip back, so it is
  // classified as loaded content. Tab switches flush BEFORE the switch (the
  // workspace flush registry), so the transient `null` never drops real edits.
  // §11.3 BaseMismatch keep-both handler: a save rejected because a sync
  // pull-apply re-based the note underneath the editor. Order is load-bearing
  // (copy FIRST - a copy failure leaves the buffer untouched, zero keystroke
  // loss); the orchestration lives in `baseMismatch.ts` (unit-tested). Read
  // The handler resolves the note the REJECTED SAVE was for, which the autosave
  // now names explicitly (myne#335) - not `activeId`, the pane's current note.
  // Those differ whenever a rejection lands after a note switch, and attributing
  // the copy to the current note produced a spurious duplicate while losing the
  // keystrokes the handler exists to preserve.
  const onBaseMismatch = useCallback(
    async (rejected: { readonly noteId: string; readonly body: string }) => {
      await handleBaseMismatch(
        { noteId: rejected.noteId, bufferBody: rejected.body },
        productionBaseMismatchDeps((diskBody) => {
          // Re-base the pane only if it is STILL showing that note. Adopting
          // another note's disk body into this buffer would be the same class of
          // mistake in the other direction.
          if (activeIdRef.current !== rejected.noteId) return;
          // Typing landed while the copy was being made (myne-md/myne#849 review
          // round 5): adopting now would drop it, since the copy holds the body as
          // it was. Keep the buffer; its next save merges or conflicts again, and
          // either way nothing typed is lost.
          if (contentRef.current !== rejected.body) return;
          autosaveRef.current.acceptReloadedBody(diskBody);
          setContent(diskBody);
          sessionMirrorRef.current.set(rejected.noteId, diskBody);
        }, (copyId) => ctx.refreshOne(copyId)),
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeId],
  );
  // §11.3 expected-base guard only makes sense while a sync endpoint is
  // enrolled - a remote pull-apply is the sole writer it defends against. With
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
  // What each autosave hands the live session: the mirror as `base`, so a save
  // from a buffer the drain has not caught up yet merges instead of replacing,
  // and a hook that moves the mirror to the text SENT once the session took it.
  // Not the text the core returns: when the core merged a peer edit into this
  // save the returned text holds it and the buffer does not, so a mirror there
  // would hide it from the next drain and the save after would delete it.
  /** The save's live context — **only while a live session really owns `id`**.
   *
   *  This used to answer for EVERY note, and that answer was a data loss. A
   *  session exists only for an `NC05` note: `live_session_open` decodes the
   *  durable blob and refuses anything else. For a legacy `MY01` note the open
   *  therefore fails, no session exists, and handing `saveNote` a session base
   *  anyway sent the stateless `note_update` to disk with a base taken from the
   *  editor's session MIRROR — a body the file never held. The write came back
   *  `BaseMismatch`, the keep-both handler preserved the keystrokes into a
   *  duplicate note, and the note the user was typing in adopted the pre-edit
   *  body: the text vanished and a copy appeared beside it.
   *
   *  Measured 2026-10-24 on a v0.1 vault, instrumented: `live: "session"` while
   *  `live_session_read` answered `{"kind":"NotOpen"}`, then `BaseMismatch` on
   *  the second save of a freshly created note. `NC05` notes are unaffected —
   *  there the session exists and the base is its own text.
   *
   *  Without a session the stateless path is correct BY CONSTRUCTION: it sends
   *  `sha256(savedBodyRef)`, which is what this hook last saw land.
   */
  const liveSaveFor = useCallback(
    (id: string): LiveSaveContext | undefined =>
      isLiveNote(id)
        ? {
            base: sessionMirrorRef.current.get(id),
            onSent: (sent) => {
              sessionMirrorRef.current.set(id, sent);
            },
          }
        : undefined,
    [],
  );
  const autosave = useAutosave(
    loading ? null : activeId,
    content,
    undefined,
    handleSaveEcho,
    onBaseMismatch,
    syncGuardEnabled,
    liveSaveFor,
  );

  // Render-surface dispatch (drawing-notes SF2, MYND-499; SYNC-2): a value-strict
  // `kind: drawing` in the loaded body routes this pane to the Excalidraw canvas
  // instead of CodeMirror. Derived from `content` (authoritative over the sidebar
  // cache); a note WITHOUT the canonical marker is unaffected (guard is exact).
  const isDrawing = useMemo(() => isDrawingBody(content), [content]);
  // Latest autosave handle for the reload effect, which keys only on the reload
  // nonce (so it must NOT take `autosave` as a dep - its identity changes every
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
  // The drain could not place a merge (it did not know what the session held, or
  // the delivery threw). `runPaneResync` rebuilds a clean buffer from the session,
  // sends a dirty one through the keep-both handler, and on a failure forgets the
  // mirror and says so rather than leaving it silently stale.
  resyncRef.current = (id: string) => {
    void runPaneResync({
      stillOn: () => activeIdRef.current === id,
      hasPendingWork: () => autosaveRef.current.hasPendingWork(),
      keepBoth: () => onBaseMismatch({ noteId: id, body: contentRef.current }),
      readSession: () => readLiveNote(id),
      adopt: (text) => {
        autosaveRef.current.acceptReloadedBody(text);
        setContent(text);
        sessionMirrorRef.current.set(id, text);
      },
      forgetMirror: () => {
        sessionMirrorRef.current.delete(id);
      },
      reportFailure: () => setLiveNotice(t("editor.flow.liveResyncFailed")),
    });
  };
  const [liveNotice, setLiveNotice] = useState<string | null>(null);

  // Re-sync this pane's body when the open note's `.myn` changed out of band -
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
    // disk (content correctness over background-note undo - grill Q5). The active
    // note's own re-read happens just below.
    stateCacheRef.current.clear();
    if (activeId === null) return;
    // Read the body even when the buffer is dirty: a note pulled from another
    // device may have LEFT the live tree, and a dirty pop-out is exactly the
    // resurrection case (its stale buffer would be autosaved back over the
    // just-pulled trash). The removal is detected from the read below and
    // reported before the dirty guard; `noteRead` never clobbers the buffer, so
    // that guard still prevents adopting a body that would discard unsaved work.
    //
    // The dirty guard uses `hasPendingWork()` and NOT `status` (myne#167):
    // `status` is React state written from a passive effect, so it still reads
    // `saved`/`clean` for a whole scheduler slice after the user has typed -
    // long enough for this reload to resolve inside it and overwrite those
    // keystrokes with disk bytes. The predicate reads refs only.
    const before = contentRef.current;
    let cancelled = false;
    void (async () => {
      try {
        const body = await noteRead(activeId);
        if (cancelled) return;
        // The pane must still be showing the note this read was FOR (myne#334).
        //
        // `cancelled` only covers a re-run of THIS effect, which keys on the
        // reload nonce - a plain note switch does not re-run it, so a read
        // started for note A could resolve after the pane had moved to B. Both
        // guards below then passed, and `acceptReloadedBody(bodyA)` re-baselined
        // B's autosave to A's body while the buffer still held B's: the CAS
        // refuses the content swap, and the forced re-render carries an
        // unchanged body so the body-change effect never re-baselines either.
        //
        // From there `hasPendingWork()` reported true forever, so the pane
        // silently ignored every later out-of-band reload; and the next keystroke
        // in B fired a save whose expected-base was `sha256(bodyA)`, which the
        // host rejects against B's own disk bytes - minting a keep-both conflict
        // copy for a note nothing ever conflicted on and relocating the user's
        // in-progress edit into it.
        if (activeIdRef.current !== activeId) return;
        // myne-md/myne#839 (cross-device): a note pulled from another device
        // that has left the live tree (trashed:/archived:/deleted:) must close
        // this pane, not merely reload. The sync pull writes the blob straight
        // to disk and the orchestrator holds no host, so no `notes://deleted`
        // fires for it; this reload is where the removal is observable. Checked
        // BEFORE the dirty guard: a dirty pop-out is the resurrection case (its
        // stale buffer would be autosaved back over the just-pulled trash), and
        // the removal handler flushes that buffer as a conflict copy first.
        if (isRemovedFromLiveTree(body)) {
          dispatchNoteRemoved(activeId);
          return;
        }
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
        // The mirror follows only an ADOPTED body. When the swap is refused the
        // buffer still derives from the old one, and moving the mirror would read
        // this reload's change as something the user typed away.
        if (contentRef.current === before) sessionMirrorRef.current.set(activeId, body);
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
  const lastSaveFailed = autosave.lastSaveFailed;
  // Answer whether the pane SETTLED, not merely whether the flush returned.
  // `fireSave` swallows its own rejection into `saveStatus`, so a failed
  // `note_update` resolves this flush exactly like a successful one.
  //
  // `lastSaveFailed`, NOT `hasPendingWork`, and the difference cost three E2E
  // scenarios before it shipped. `hasPendingWork` is a "do not clobber me" flag:
  // it answers true whenever the live body differs from what the hook believes
  // is on disk, which is the ORDINARY state right after a save whose buffer
  // moved on, and for a clean pane `flushIfDirty` returns without saving at all.
  // Reporting that as "did not settle" made `flushAll` reject after a perfectly
  // normal save, so the cover write behind it was refused and the user got a
  // write-failed toast. What a caller about to read-patch-write this note needs
  // to know is only whether the flush it just awaited actually persisted.
  // `saveInFlight` is the THIRD thing this has to ask, and leaving it out was a
  // silent hole rather than a simplification. `flushIfDirty` awaits two levels
  // on its in-flight branch because a hand-off re-registers `inFlightRef`; its
  // `await fireSave()` branch does not re-check at all, and on a hand-off
  // `fireSave` resolves EARLY (it nulls `inFlightRef`, marks `handedOff`, fires
  // the follow-up and returns). The follow-up's first statement clears the
  // failure flag, so `lastSaveFailed()` reads clean for a save that has not
  // landed, and this reported SETTLED. What that costs is the whole reason the
  // flush exists: the caller reads the pre-typing disk bytes, patches its
  // field, writes, and the in-flight follow-up lands on top and reverts it.
  // With the section 11.3 hash on it is worse, because the follow-up declares
  // the first save's body as its expected base while disk now holds the
  // caller's, so it is refused `BaseMismatch` and mints a keep-both conflict
  // copy for a note no remote writer ever touched.
  const saveInFlight = autosave.saveInFlight;
  const flushAndReport = useCallback(
    async (opts?: FlushOptions) => {
      await flushIfDirty(opts);
      return !lastSaveFailed() && !saveInFlight();
    },
    [flushIfDirty, lastSaveFailed, saveInFlight],
  );
  useEffect(() => {
    registerFlush(leaf.id, flushAndReport);
    return () => unregisterFlush(leaf.id);
  }, [leaf.id, flushAndReport, registerFlush, unregisterFlush]);
  // Publish this pane's flush to the awareness-drop listener above
  // (`collab-editor-bridge` task 7): an eager flush on live-channel disconnect so
  // no pending durable save is stranded if the stream does not return, and so the
  // next durable pull's reload is not skipped by the pending-work gate.
  useEffect(() => {
    dropFlushRef.current = flushAndReport;
    return () => {
      dropFlushRef.current = null;
    };
  }, [flushAndReport]);

  // Surgical sidebar refresh after a successful save (title/H1 edits
  // propagate to the row label). Tracks the `saved.at` identity.
  const lastRefreshedAt = useRef<number>(0);
  useEffect(() => {
    if (autosave.status.status !== "saved") return;
    const at = autosave.status.at.getTime();
    if (at === lastRefreshedAt.current) return;
    lastRefreshedAt.current = at;
    // Refresh the note the save was FOR, not the pane's current one: a title
    // edit saved as the user switches notes must still reach the outgoing row's
    // cache title, or that note shows "Untitled" in the sidebar and in any view
    // (measured: three createNote calls back to back left saved-views-cards
    // rendering three "Untitled" cards while every body was on disk).
    const savedId = autosave.status.noteId ?? activeId;
    if (savedId === null) return;
    void ctx.refreshOne(savedId).catch(() => {});
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
    // A drawing note is an Excalidraw scene stored as fenced JSON - a word/char
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
  // creates a note - it opens an empty "New tab" whose body lets the user
  // search/pick an existing note or create a fresh one. A tabless pane shows
  // the same chooser. Pending state lives in the WORKSPACE (`ws.beginNewTab`)
  // - not PaneView-local - so a sidebar click (routed through
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

  // Mint a note via `mint` (createNote / createDrawing - NOT
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
  // is ALWAYS displayed (MYND-166) - an empty/not-yet-focused pane just shows
  // it in its New-tab state.
  // Empty/chooser only when there is NO active tab at all - a view-active tab
  // is NOT a new-tab state (it renders the view host below).
  const inNewTabState = pendingNewTab || leaf.activeTab === null;

  // Tabs <-> panel pairing (myne#728). One panel per pane, named after the tab
  // the user picked; `null` while the pane is in its new-tab/empty state, where
  // the strip has no selected tab to borrow a name from.
  const panelDomId = `pane-panel-${leaf.id}`;
  const activeTabDomId =
    inNewTabState || leaf.activeTab === null
      ? null
      : tabDomId(leaf.id, itemKey(leaf.activeTab));

  const paneBody = useMemo<PaneBody>(() => {
    if (inNewTabState) {
      return {
        fill: false,
        gutters: true,
        el: (
          <NewTabChooser
            onPick={onPickNote}
            onCreate={onCreateNote}
            onCreateDrawing={onCreateDrawing}
            cancellable={leaf.tabs.length > 0}
            onCancel={clearPending}
          />
        ),
      };
    }
    if (activeViewId !== null) {
      return { fill: false, gutters: true, el: <ViewHost viewId={activeViewId} /> };
    }
    if (isGraph) {
      return { fill: true, gutters: false, el: <GraphPane /> };
    }
    // The attachment library (myne-md/myne#773). `fill` with no gutters, like
    // the graph: the library owns its own padding and its grid has to reach the
    // pane edge to fit a sensible number of thumbnails at a narrow split.
    //
    // It no longer renders its own title row. That row existed because the
    // library replaced the whole pane tree, tab strip included, so it had to
    // reproduce a header; as a tab, the tab strip already carries the paperclip
    // and the word, and a second copy directly beneath it was the surface
    // announcing itself twice.
    if (isAttachments) {
      return {
        fill: true,
        gutters: false,
        // The flex COLUMN is load-bearing and its absence was a real bug: the
        // library scrolled nowhere as a tab (reported on the running build).
        //
        // A filling body is wrapped in `<div style={{ height: "100%" }}>`, which
        // is a BLOCK. The library is written as a flex child — its root is
        // `flex: 1; minHeight: 0` and its scroller is `flex: 1; minHeight: 0;
        // overflowY: auto` — so with no flex parent neither gets a bounded
        // height, the root grows to content, and the scroller has nothing to
        // scroll inside. `GraphPane` never exposed this because a canvas fills
        // `height: 100%` on its own.
        //
        // Fixed here rather than by making the generic wrapper a flex column,
        // which would change the height regime under the graph and the task
        // list too — a wider blast radius than the bug warrants.
        el: (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              height: "100%",
              minHeight: 0,
            }}
          >
            <AttachmentsLibrary />
          </div>
        ),
      };
    }
    // The template library (myne-md/myne#779). Gutters STAY: unlike the graph
    // and the attachment grid, this is a text list, and a text list 8px from
    // the edge of a full-width pane is the compact this product says it is not.
    if (isTemplates) {
      return {
        fill: true,
        gutters: true,
        el: (
          <TemplatesManager
            open
            onClose={() => {}}
            onOpenNote={(id) => {
              // Opening a template REPLACES this tab with it, which is what
              // "open" means in a pane. No separate close.
              //
              // Refresh it into the cache FIRST. A template created moments ago
              // is not in `ctx.cache` yet, and the open bridge treats an id that
              // is not live as a DELETED note and refuses to open it (myne#655) —
              // which is why a freshly created template could not be opened for
              // editing, and why it also slipped through the palette's
              // `isTemplate` filter (myne-md/myne#820). The ordering lives in
              // `refreshThenOpen` so a test can pin it (myne-md/myne#824).
              void refreshThenOpen(ctx, id).catch(() => {});
            }}
          />
        ),
      };
    }
    if (isTasks && leaf.activeTab !== null) {
      // The third member of #534's family, found while fixing the graph.
      // `TaskListPanel`'s root is written as a filling body (`height: 100%` over
      // an inner `flex: 1 1 auto; min-height: 0; overflow-y: auto`), so in the
      // flowing frame its percentage resolved to `auto`, the inner scroller
      // never got a box to scroll inside, and the filter strip slid away with
      // the list instead of pinning. Milder than the graph, since nothing became
      // unreachable, and the same cause.
      //
      // Gutters STAY. The strip and every `TaskRow` carry `6px 8px` of their
      // own, but that is the density this component was authored at as a 280px
      // right-panel body, which it still is under `NoteTasksPanel`. A text list
      // 8px from the edge of a full-width pane is the compact this product says
      // it is not.
      return {
        fill: true,
        gutters: true,
        el: <TasksPane paneId={leaf.id} item={leaf.activeTab} />,
      };
    }
    if (isCalendar && leaf.activeTab !== null) {
      // The calendar fills its pane and takes NO gutters: a month grid is the
      // widest surface in the product, and `tabKinds` gives it the whole surface
      // on entry (both sidebars close) so the reading measure would only take
      // width back off it — 48px of a layout that is already all grid. The task
      // list keeps its gutters because it is a list of lines; this is the second
      // full-bleed body beside the graph.
      return {
        fill: true,
        gutters: false,
        el: (
          <CalendarPane
            paneId={leaf.id}
            item={leaf.activeTab as Extract<WorkspaceItem, { kind: "calendar" }>}
          />
        ),
      };
    }
    if (isAgent && leaf.activeTab !== null) {
      // The agent hub (myne-md/myne#771). It fills like the tasks pane and
      // takes NO gutters.
      //
      // **The pane owns its own inset, and it cannot while this is true.** The
      // gutter here is `0 24px`, which is the reading measure a flowing note
      // wants and is far too much for a surface whose left column is a 248px
      // rail: 48px of the pane's width goes to nothing, on the narrowest thing
      // in the app. Worse, it is invisible from the pane's own stylesheet —
      // two rounds of editing `.myne-agent`'s padding changed nothing on
      // screen, because the value being looked at was never the one producing
      // the gutter. So the inset lives in ONE place, `components.css`, where
      // the rail's and the conversation's own paddings are, and the pane is
      // handed the full width to spend.
      //
      // **`folders` is not optional here, whatever its type says.** It was
      // omitted, so the agent tab's scope picker offered exactly one entry —
      // "This note" — and in the agent tab there usually IS no open note: the
      // tab is the focused pane. So the scope resolved to `null`, the host
      // refuses a run without one, Send sat disabled, and the only alternative
      // scope the picker exists to offer was not in it. A dead end reachable by
      // opening the tab and typing.
      return {
        fill: true,
        gutters: false,
        el: (
          <AgentPane
            paneId={leaf.id}
            item={leaf.activeTab}
            folders={agentFolders}
            onNotesWritten={agentNotesWritten}
            // An undo rewrites notes out-of-band too, the same shape a sync pull
            // has, so it takes the same blanket reload the panel's own copy uses.
            onRunUndone={() => ctx.reloadOpenNote()}
          />
        ),
      };
    }
    if (loading) {
      return { fill: false, gutters: true, el: <PaneLoading /> };
    }
    if (isDrawing) {
      // The Excalidraw canvas surface (SF2). Scene loads from the note body and
      // re-serializes on change back into `content`, which the existing autosave
      // (above) debounces + persists, with no separate save path. RUNTIME-FLAGGED:
      // the canvas round-trip + onChange debounce need a `pnpm tauri dev` check.
      return {
        fill: true,
        gutters: false,
        el: (
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
        ),
      };
    }
    // Assigned rather than inlined into the return object so the JSX below keeps
    // its indentation. This branch is ~130 lines and re-nesting it would bury
    // the change in whitespace.
    const markdownBody = (
      // Editor-typography: the content max-width + the three CSS custom
      // properties (`--editor-text-size` / `--editor-line-spacing` /
      // `--editor-font-family`) come from `typographyStyle(prefs)`. The vars
      // inherit into the child `.cm-editor`, which reads them via
      // `var(--editor-*)` in `theme.ts` - so a preset change re-renders this
      // wrapper and updates the editor live (no CodeMirror remount).
      <div
        data-testid="editor.content-frame"
        // THE WRITING PANE IS A SURFACE (myne#394 task 11).
        //
        // It is the element `texture` and `ruled` were designed for - the
        // stylesheet's dotted rule says "the dots land where the writing does,
        // and they grow when the text does", and the whole opacity ceiling
        // exists because these primitives render behind body text. The role was
        // never declared here: `surface` reached only the sidebar panes and
        // `ModalShell`, so a theme asking for notebook rules got them on the
        // file tree and none on the page.
        //
        // Safe against the paint-layer rule's one real risk (`position:
        // relative` re-anchoring an absolutely-positioned descendant): every
        // editor overlay is `position: fixed` and mounted to `document.body`
        // (`editor/src/floating-styles.ts`), the one `absolute` rule anchors to
        // a fixed backdrop, and CodeMirror's own absolutes anchor to
        // `.cm-editor`, which sets `position: relative` itself.
        {...ornamentRole("surface")}
        style={
          companionVisible
            ? { ...typographyStyle(prefs), maxWidth: "none", margin: 0, display: "flex", gap: "var(--space-4)" }
            : { ...typographyStyle(prefs), margin: "0 auto" }
        }
      >
        <div style={{ minWidth: 0, flex: companionVisible ? 1 : undefined }}>
          <CMEditor
            value={content}
            // myne-md/myne#520: which note this pane is holding. The cover
            // banner's controls name their target with it instead of leaving
            // the shell to infer one from focus, which was wrong the moment
            // the banner pressed was in a pane that is not the focused one.
            // Pushed live rather than keyed, because this view is long-lived
            // and notes are swapped through it.
            noteId={activeId}
            noteTitle={activeTitle}
            // Set only by the autosave `updated:` echo; undefined for every
            // authoritative writer, so those still apply unconditionally.
            valueBase={buffer.base}
            onChange={handleUserChange}
            onBlur={handleBlur}
            onSelectionChange={handleSelectionChange}
            // Live presence (`collab-presence-ui`): report this pane's local caret
            // so peers see it. The reading companion below is a mirror and reports
            // nothing.
            onCursorChange={handleCursorChange}
            noteSet={notes}
            vaultHeadings={vaultHeadings}
            vaultBlockAnchors={vaultBlockAnchors}
            onOpenWikilink={handleOpenWikilink}
            // The module function itself, not a snapshot of it. Stable across
            // renders, so the editor installs it once and asks when the picker
            // opens; a mirrored array made every pane rank off the order from
            // the last time THAT pane switched notes.
            recentNotes={recentNoteIds}
            // MYND-617: the task-query blocks in this document. Absent entries
            // render as loading, never as an empty result.
            taskQueryResults={taskQueryResults}
            onTaskQueryToggle={handleTaskQueryToggle}
            onTaskQueryOpen={handleTaskQueryOpen}
            // MYND-651: the inline tag-suggestion band. Empty (the default, and
            // the state of every note while auto-tag is off) renders no band at
            // all, so an idle note is not shifted by a strip of chrome. Only the
            // editable primary editor gets it - the reading companion below is
            // a mirror, and a second band offering the same accept would write
            // through this same document twice.
            tagSuggestions={tagSuggestions}
            onAcceptTagSuggestion={handleAcceptTagSuggestion}
            onDismissTagSuggestion={handleDismissTagSuggestion}
            // collab-presence-ui task 3: the peers editing THIS note. Empty once the
            // store is reset/cleared, which renders nothing (never stale). Only the
            // editable primary editor gets it - the read-only mirror below draws no
            // cursors.
            awareness={paneAwareness}
            scrollAnchor={activeScrollAnchor}
            revealLine={revealLine}
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
            // excluded-folder rule above - that rule is about ambient AI
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
            // enable - a user who never turns vim on never pays for it.
            // Reading view is read-only and never holds a text cursor, so modal
            // editing is meaningless there - and an indicator would be actively
            // misleading. Vim is mounted only for the editable modes.
            vimMode={prefs.editor_vim_mode === true && effectiveViewMode !== "reading"}
            // #184: the user keymap overrides (vault.prefs.keymap). The editor
            // reconfigures its rebindable-keymap compartment live when a Hotkeys
            // rebind of an editor command lands (no remount).
            keymapOverrides={prefs.keymap}
            // MYND-634: inline `![[Drawing]]` embeds - read/save the referenced
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
              // Same note as the primary editor above: the reading mirror draws
              // its own cover banner, so its controls need the same target.
              noteId={activeId}
              noteTitle={activeTitle}
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
              // too (reading mode never opens the edit-in-place canvas - it stays a
              // static thumbnail - but it still needs the seam to read the scene).
              drawingIo={drawingIo}
              readOnly
              viewMode="reading"
              style={{ width: "100%", minHeight: 360, color: "var(--fg-1)" }}
            />
          </div>
        )}
      </div>
    );
    return { fill: false, gutters: true, el: markdownBody };
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
    // **The peer set, and its absence was a whole feature that never drew.** The
    // editor element is built INSIDE this memo, so `awareness={paneAwareness}`
    // only reaches it when the memo recomputes — and this array did not name it.
    // A remote awareness frame updated the store, re-rendered the pane, mapped
    // the peer (the Who's-here roster showed it) and then handed the editor the
    // SAME old prop object, so the decoration effect never fired: the caret
    // appeared only after an unrelated render invalidated one of the deps above.
    //
    // Measured 2026-10-24 on `collab-presence`, instrumented on both sides: the
    // pane re-rendered with `peers: 1`, and the editor's awareness effect logged
    // NO dispatch for that frame (`peers: 0` twice, then nothing).
    paneAwareness,
    // **The suggestion chips, and their absence is the same failure one band
    // over (myne-md/myne#651).** The editor element is built inside this memo,
    // so `tagSuggestions={tagSuggestions}` only reaches it when the memo
    // recomputes. A dismissal updated the hook's `hidden` set and re-rendered
    // the pane, and the editor then received the SAME old array, so its
    // `setTagSuggestions` push never fired and the chip the reader had just
    // crossed out stayed on screen until an unrelated render invalidated one of
    // the deps above. Measured 2026-10-24 on `tag-suggestion-band` tsb1: the
    // band still read `[stub-tag, notes]` 30 s after the dismiss click, while
    // `useTagSuggestions`' own unit tests passed because they never involve
    // this memo.
    tagSuggestions,
    // Both chip handlers are read here too, and one of them closes over
    // `editorView`: naming them keeps the memo from handing the editor a
    // callback that targets a view this pane has already swapped out.
    handleAcceptTagSuggestion,
    handleDismissTagSuggestion,
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
        // Flex min-height:auto would size this to CONTENT, so a long body
        // grows the section past `role=main` instead of giving the tabpanel
        // below a bounded box to scroll in: tabpanel keeps overflow-y:auto
        // but clientHeight === scrollHeight, and every ancestor that HAS a
        // range is overflow:visible (not a scrollport) or overflow:hidden
        // (app chrome). minHeight:0 is the standard flexbox trap fix — same
        // as Editor.tsx's attachments arm.
        minHeight: 0,
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
        // Brightness, not a wash: see `paneDimStyle`. The one treatment that
        // reads as "not the active one" on light, dark and true-black alike.
        ...(paneDimStyle(focused, ws.leaves.length) ?? {}),
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
          // A singleton kind (the graph, the task list) carries a fixed label
          // key in the tab-kind registry, so this arm covers every one of them
          // and a new singleton needs no edit here (myne-md/myne#773).
          const labelKey = tabKindSpec(it.kind).labelKey;
          if (labelKey !== undefined) return t(labelKey);
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
          // Every non-note kind takes its glyph straight from the registry
          // (myne-md/myne#773). `note` falls through, because a note's glyph
          // depends on the NOTE (drawing, task, bookmark) rather than on its
          // tab kind — which is exactly the distinction the registry's default
          // cannot make and the lines below can.
          if (it.kind !== "note") return tabKindSpec(it.kind).icon;
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
        onDetachNote={ws.detachNote}
        panelId={panelDomId}
      />
      {/* Automatic tagging reports what it wrote, and offers the inverse
          (myne-md/myne#908).

          **As a toast, not a bar** (issue #970, item 7). It used to be a strip
          in the band's own layout row, above the note: a 28px band that pushed
          the whole document down for six seconds and then pulled it back, on a
          surface whose entire job is holding a caret in place. The report is
          transient feedback with an action, which is exactly what the shared
          toast stack exists for: the same surface that reports a failed write
          two hundred lines below, in the same place on screen, with the same
          pause-on-hover and dismissal rules.

          The report itself is not weakened: the row names the tags and the
          action removes exactly those, and the tags remain visible in the note's
          properties afterwards, so the write is not invisible when the toast
          leaves. RAM-only and note-scoped, so switching notes drops it, matching
          the suggestion set's lifetime. */}
      <Toast
        message={
          autoAppliedRow !== null && autoAppliedRow.noteId === activeId
            ? t("notes.autoTag.applied", { tags: autoAppliedRow.tags.join(", ") })
            : null
        }
        // `editor.auto-tag-applied` and `editor.auto-tag-undo` are kept as the
        // ids the scenario and the specs already reach for: the surface moved,
        // its identity in a test did not.
        testId="editor.auto-tag-applied"
        action={{
          label: t("notes.autoTag.undo"),
          onAction: handleUndoAutoApplied,
          testId: "editor.auto-tag-undo",
        }}
        onDone={() => setAutoAppliedRow(null)}
      />
      <div
        ref={outlineScrollerRef}
        // The pane body is the strip's `role="tabpanel"` (myne#728). Without
        // it the tabs were a tablist controlling nothing, so a screen reader
        // announced the switch and then had no region to move into. Named by
        // the ACTIVE tab rather than by a label of its own, which is the
        // WAI-ARIA tabs pattern: the panel's name IS the tab you picked.
        //
        // The role is conditional because a pane in the new-tab state (or with
        // every tab closed) has no active tab, and a `tabpanel` with nothing
        // labelling it is worse than a plain scroller.
        id={panelDomId}
        role={activeTabDomId === null ? undefined : "tabpanel"}
        aria-labelledby={activeTabDomId ?? undefined}
        style={{
          flex: 1,
          minHeight: 0,
          // Which frame this is, and why, is on `PaneBody` above.
          //
          // Vertical only (myne-md/myne#630). `overflow: auto` is both axes, so
          // this div was a horizontal scroll container in its own right, sitting
          // outside `.cm-scroller` and reachable even after the editor stopped
          // scrolling sideways. A pane is a fixed-width column by construction,
          // one of a split, so there is nothing here that should be reached by
          // scrolling right.
          overflowX: "hidden",
          overflowY: paneBody.fill ? "hidden" : "auto",
          // No TOP padding here: this div is the scroll parent of the in-note
          // find bar's sticky top panel, and a top padding leaves a band above the
          // bar where scrolled text bleeds through (MYND-299 QA). The 12px top
          // breathing-room moves onto the inner wrapper below, so it scrolls UNDER
          // the now-flush sticky bar instead of opening a gap above it.
          //
          // No BOTTOM padding on a filling body either: it is the scroll-past
          // slack a flowing body wants at the end of its text, and under one that
          // fills there is no end to scroll past, so it would read as a dead
          // strip below a list that is already scrolling internally.
          padding: paneBody.gutters ? (paneBody.fill ? "0 var(--pane-gutter-inline, 24px) 0" : "0 var(--pane-gutter-inline, 24px) 32px") : 0,
          // The inline gutter is declared ONCE here and read by the find bar's
          // panel, which cancels it with a negative margin so its bottom hairline
          // reaches this container's edges instead of stopping at the text
          // column (myne#952). Written as a custom property rather than 24px in
          // both places so the two cannot drift apart: a theme that widens the
          // gutter would otherwise leave the divider floating mid-strip.
          ["--pane-gutter-inline" as string]: paneBody.gutters ? "24px" : "0px",
          // And the find bar needs a second number it cannot read any other way:
          // how far this container is wider than the writing column centred
          // inside it. `cqi` units answer that in CSS, against THIS pane rather
          // than the window (a split view is as narrow as a phone and has the
          // same problem). Without a container the panel's hairline can only
          // reach the column, which is the "it still doesn't go edge to edge"
          // the owner reported after the gutter was already cancelled.
          //
          // Safe against the one hazard of layout containment: every surface
          // that relies on `position: fixed` is mounted to `document.body`
          // (task-field menu, attachment menus, floating styles), outside this
          // subtree, so none of them gets re-anchored here.
          containerType: "inline-size",
        }}
      >
        <div style={paneBody.fill ? { height: "100%" } : { paddingTop: "var(--space-3)" }}>
          {paneBody.el}
        </div>
      </div>
      {dragActive && (
        // Capture overlay - only mounted during a tab/note drag, covering the
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
      <Toast message={liveNotice} onDone={() => setLiveNotice(null)} variant="error" />
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
        fontSize: "var(--text-sm)",
        fontFamily: "var(--font-sans)",
      }}
    >
      {t("notes.pane.loading")}
    </div>
  );
}

/** The centred quiet body a view host falls back to: a stale view id, a result
 *  still in flight, or a definition this device has not approved. One shape for
 *  all three so the surface does not jump between them. */
const QUIET_WRAP_STYLE: CSSProperties = {
  maxWidth: 420,
  margin: "12vh auto 0",
  padding: "0 var(--space-5)",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "var(--space-3)",
  textAlign: "center",
  fontFamily: "var(--font-sans)",
  lineHeight: 1.6,
};

const QUIET_TITLE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-base)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  color: "var(--fg-1)",
};

const QUIET_BODY_STYLE: CSSProperties = {
  margin: 0,
  maxWidth: 360,
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
};

/**
 * Host for an open saved-view tab (MYND-275, Saved Views #5). Resolves the
 * `viewId` to its `SavedView` def via prefs, runs the query engine over the
 * sidebar caches (`useViewResult`), and renders via the viewType dispatch
 * (`ViewRenderHost` → cards / table / list). No autosave / flush - views are
 * read-only projections, not editable buffers. Keeps the `editor.view-host`
 * testid wrapper (E2E #4 contract). While the result is loading (or the view id
 * is stale) the wrapper holds a calm, quiet body - no spinner churn.
 */
function ViewHost({ viewId }: { viewId: string }) {
  const { t } = useTranslation();
  const { def, result, approved, approve } = useViewResult(viewId);
  const ws = useWorkspace();
  const sidebar = useSelectedNote();
  const [cardMenu, setCardMenu] = useState<{
    noteId: string;
    x: number;
    y: number;
  } | null>(null);
  // Card navigation reuses the workspace open seam - the same matrix NoteList
  // wires for a sidebar row (toSide → split, newTab → new tab, else focused).
  const onOpenNote = useCallback(
    (noteId: string, intent: { newTab: boolean; toSide: boolean }) => {
      if (intent.toSide) ws.openToSide(noteId);
      else if (intent.newTab) ws.openNewTabInFocused(noteId);
      else ws.openInFocused(noteId);
    },
    [ws],
  );
  // A card the BOARD creates is outside the editor's autosave path, so nothing
  // else tells the sidebar cache about it and the board that just added the card
  // would be the one surface that cannot see it (its rows are built from this
  // cache). The "+ New Note" action calls `refreshOne` after create for exactly
  // this reason.
  const onNoteCreated = useCallback(
    (noteId: string) => sidebar.refreshOne(noteId as NoteId),
    [sidebar],
  );
  const onCardContextMenu = useCallback(    (noteId: string, pos: { x: number; y: number }) =>
      setCardMenu({ noteId, x: pos.x, y: pos.y }),
    [],
  );
  // Cover-image picker (Saved Views follow-on): a card's "Set cover" affordance
  // opens this picker for that note; the choice is written to the note's cover
  // frontmatter property. The property NAME is the view's `image` setting,
  // defaulting to `cover` on first use (and recorded onto the view so the cards
  // render reads it back).
  const [coverNoteId, setCoverNoteId] = useState<string | null>(null);
  // A refused or failed cover write, shown as a toast. Before this the catch
  // below was bare, so the two rejection classes the fix introduced were
  // reported nowhere and a refused write looked exactly like a successful one.
  const [coverError, setCoverError] = useState<string | null>(null);
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
          // Settle FIRST, and the order is the whole point rather than a
          // preference. It used to sit after `upsertSavedView`, which is a
          // `vault.prefs` write that can reject, so a failed prefs write took
          // the settle down with it and landed in the catch below as a cover
          // failure. That reintroduces exactly what the paragraph beneath says
          // this call exists to prevent, on the call site it names as the one
          // most at risk, and it does so while telling the user the cover write
          // failed when the note write had already succeeded.
          //
          // Settle (`src/AGENTS.md`, "A backend write made OUTSIDE a pane's
          // autosave loop leaves that pane holding a stale buffer"). This call
          // site is the one that needs it most and had none: the target is a
          // note in a VIEW RESULT, so by definition it is not the note this
          // pane is showing and it is the likeliest of all cover writers to be
          // open, and dirty, somewhere else. Without the re-read that pane's
          // buffer still has no `cover:` line and its next keystroke autosaves
          // the cover away. `setNoteCover`'s flush closed the race; this closes
          // the staleness, which is the other half. The recipe is called rather
          // than copied: it used to be a closure in `Editor.tsx` and this site
          // hand-copied its two lines.
          await settleFrontmatterWrite(sidebar, noteId as NoteId);
          // First cover on a view with no image property → adopt `cover` as the
          // view's cover property so the card render picks it up. This is a LOCAL
          // EDIT like any other (view-manifests task 8), so it goes through the
          // one save helper: the version moves forward with the definition, and
          // the approval of the version this device is already showing rides
          // along in the same write.
          if (choice !== null && def !== null && def.image === undefined) {
            // `approved` is this device's verdict on the definition in hand,
            // already read by the hook that resolved it, so the adoption does not
            // open a second prefs read to ask the same question.
            await saveLocalViewEdit(def, { ...def, image: coverPropertyKey }, approved);
          }
        } catch (err) {
          // The two NEW rejection classes are constructed in the WebView and
          // never reach backend tracing, so the old bare catch reported them
          // nowhere: `setNoteCover` now opens with `flushBeforeFrontmatterWrite`
          // (which throws `PanesNotSettledError`) and `settleFrontmatterWrite`
          // deliberately propagates a failed record refresh. This is the call
          // site `flushBeforeFrontmatterWrite`'s own header names as most at
          // risk, and it was the only cover caller with no outcome at all while
          // the editor screen shows `editor.cover.writeFailed` for the same
          // failure. A refused cover write was byte-identical to a successful
          // one here.
          setCoverError(
            panesNotSettledMessage(err, {
              unsettled: t("notes.unsettledSave"),
              failed: t("editor.cover.writeFailed"),
            }),
          );
        }
      })();
    },
    [coverNoteId, coverPropertyKey, def, sidebar, approved],
  );
  // The non-mutating card context menu (task 8) - the CLOSED four-item set
  // (`buildCardMenuItems`): Open · Open in new tab · Reveal in folder · Copy
  // link. NO delete / move / trash / rename (a saved view is a read-only
  // projection; deletion stays at the note's own location, the sidebar).
  // Reveal selects the note in the sidebar; Copy link writes a `[[title]]`
  // wikilink via the existing clipboard plugin (no new capability).
  // Copying a card's link is the one menu action with no workspace seam of its
  // own: it writes a `[[title]]` wikilink through the existing clipboard plugin
  // (no new capability). Shared by the host's menu and the board's, so the two
  // doors cannot disagree about what "copy link" puts on the clipboard.
  const copyCardLink = useCallback(
    (id: string) => {
      const title = sidebar.cache.get(id)?.title ?? "";
      // TRANSPORT MIGRATION ONLY (myne-md/myne#390). Both arms are silent
      // because that is what this menu item does today: the rejection used to
      // be dropped by a bare `void`, and an empty title is a no-op the user
      // also never sees. Recorded rather than deleted so the follow-up task
      // that gives it a toast is editing a decision, not discovering an
      // absence.
      if (title !== "") {
        void copyText(clipboardWriteText, `[[${title}]]`, {
          onSuccess: { kind: "silent", reason: "pre-fix behaviour (myne 390): the card menu reported nothing" },
          onFailure: { kind: "silent", reason: "pre-fix behaviour (myne 390): the rejection was dropped by `void`" },
        });
      }
    },
    [sidebar],
  );
  const cardMenuItems: ContextMenuItem[] = useMemo(() => {
    if (cardMenu === null) return [];
    const id = cardMenu.noteId;
    return buildCardMenuItems({
      open: () => ws.openInFocused(id),
      openInNewTab: () => ws.openNewTabInFocused(id),
      revealInFolder: () => sidebar.select(id),
      copyLink: () => copyCardLink(id),
    });
  }, [cardMenu, ws, sidebar, copyCardLink]);
  // The board's card actions (myne-md/myne#922 task 8). The board draws its own
  // menu because it is the surface that offers the lifecycle verb, but every
  // handler is the host's own path: opening goes through the workspace seam, and
  // archive/trash go through the sidebar's rollback writers, which write the
  // reserved markers the host owns. A manifest cannot ask for either.
  const boardCardActions: BoardCardActions = useMemo(
    () => ({
      open: (id) => ws.openInFocused(id),
      openInNewTab: (id) => ws.openNewTabInFocused(id),
      revealInFolder: (id) => sidebar.select(id as NoteId),
      copyLink: (id) => copyCardLink(id),
      archive: (id) => sidebar.archiveWithRollback(id as NoteId),
      trash: (id) => sidebar.trashWithRollback(id as NoteId),
    }),
    [ws, sidebar, copyCardLink],
  );
  return (
    <div data-testid="editor.view-host" data-view-id={viewId}>
      {def !== null && !approved ? (
        // A definition this device has not approved. The tab stays open and says
        // so rather than closing or hiding, because a view the reader cannot see
        // is a decision they cannot make, and `useViewResult` has already
        // refused to run the query, so nothing has been read on their behalf.
        <div style={QUIET_WRAP_STYLE} data-testid="editor.view-pending">
          <p style={QUIET_TITLE_STYLE}>
            {t("notes.views.manager.pendingTitle", {
              name: def.name.trim() === "" ? t("notes.views.untitledView") : def.name,
            })}
          </p>
          <p style={QUIET_BODY_STYLE}>{t("notes.views.manager.pendingBody")}</p>
          <Button
            variant="primary"
            data-testid="editor.view-pending-approve"
            onClick={() => {
              void approve(def.id, def.version);
            }}
          >
            {t("notes.views.manager.approve")}
          </Button>
        </div>
      ) : def !== null && result !== null ? (
        <ViewRenderHost
          def={def}
          result={result}
          onOpenNote={onOpenNote}
          onCardContextMenu={onCardContextMenu}
          onSetCover={onSetCover}
          onNoteCreated={
            def.view_type === "board" ? onNoteCreated : undefined
          }
          approved={approved}
          cardActions={def.view_type === "board" ? boardCardActions : undefined}
        />
      ) : (
        <div style={QUIET_WRAP_STYLE} />
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
      <Toast message={coverError} onDone={() => setCoverError(null)} variant="error" />
    </div>
  );
}
