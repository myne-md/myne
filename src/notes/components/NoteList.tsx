// `<NoteList>` — Notes sidebar container.
//
// Visual canon: Penpot frames `screen------notes-sidebar--empty` (boş
// vault) + `screen------notes-sidebar--populated` (Notes header +
// "+ New Note" button + virtualized rows). Tokens per
// `colors_and_type.css`.
//
// PRD stories: 1 (empty state placeholder), 2 (sidebar populates after
// unlock), 78 (container), 81 (empty CTA).

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import { SECTION_HEADING_STYLE } from "./sharedStyles";
import { noteRead } from "../readNote";
import {
  liveCache,
  trashedCount,
  useSelectedNote,
  type NoteId,
  type UseSelectedNoteReturn,
} from "../sidebarState";
import { TrashPanel } from "./TrashPanel";
import { DeleteConfirmModal } from "./DeleteConfirmModal";
import { deriveFolderTree, type FolderNode } from "../folderTree";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import {
  noteExportOptions,
  runNoteExportFlow,
  runNotePdfExportFlow,
  type NoteExportUiHooks,
} from "../exportFlow";
import { DecorationPopover } from "./DecorationPopover";
import { Toast } from "../../components/Toast";
import { FolderRow } from "./FolderRow";
import { NoteRow } from "./NoteRow";
import type { TitleRecord } from "../loadNoteBatch";
import { VirtualList } from "./VirtualList";
import { useWorkspace } from "../workspaceContext";
import { IconButton } from "../../components/primitives/IconButton";
import { ViewsSection } from "./ViewsSection";
import { FilterBuilder, type FolderOption } from "./FilterBuilder";
import { ViewSettings, type ViewDisplayPatch } from "./ViewSettings";
import { useViewResult } from "../views/useViewResult";
import {
  draftToFilterNode,
  filterNodeToDraft,
  type FilterDraft,
} from "../filterDraft";
import { usePrefs } from "../../hooks/usePrefs";
import {
  deleteSavedView,
  setViewOrder,
  upsertSavedView,
  type SavedView,
} from "../../lib/prefs";
import { moveInOrder } from "../reorderViewOrder";
import {
  buildFavoriteRows,
  flattenVisibleRows,
  visibleNoteIds,
  type VisibleRow,
} from "./folderTreeRows";
import { dragEdge, insertionLineStyle } from "./reorderDnd";
import {
  useFolderManagement,
  type FolderManagement,
} from "./useFolderManagement";
import { Icon } from "../../components/primitives/Icon";
import { useCenterView } from "../../screens/centerView";

/**
 * Compute the adjacent note to select after deleting `victimId` from
 * `sortedIds`. Picks the next row in sort order, falling back to the
 * previous row, falling back to `null` (empty list).
 *
 * Exported for unit tests (`triggerHandlers.test.ts`).
 */
export function pickAdjacentAfterDelete(
  sortedIds: readonly NoteId[],
  victimId: NoteId,
): NoteId | null {
  const idx = sortedIds.indexOf(victimId);
  if (idx === -1) return null;
  const next = sortedIds[idx + 1];
  if (next !== undefined) return next;
  const prev = sortedIds[idx - 1];
  if (prev !== undefined) return prev;
  return null;
}

/**
 * Document-level F2 keyboard handler — global keymap for "enter inline-
 * rename on the currently-selected sidebar row". Fires only when:
 *
 * - `selectedId !== null` (there's a row to rename).
 * - `renamingId === null` (not already in rename mode; F2-while-renaming
 *   would no-op since the input is already focused).
 *
 * Returning the inner handler from a factory keeps it directly unit-
 * testable (`tests/notes/triggerHandlers.test.ts`).
 */
export function makeF2KeydownHandler(
  ctx: Pick<UseSelectedNoteReturn, "selectedId" | "renamingId" | "startRename">,
): (e: KeyboardEvent) => void {
  return (e: KeyboardEvent) => {
    if (e.key !== "F2") return;
    if (ctx.selectedId === null) return;
    if (ctx.renamingId !== null) return;
    e.preventDefault();
    ctx.startRename(ctx.selectedId);
  };
}

/**
 * Keyboard navigation handler factory for the sidebar — covers PRD
 * stories 12-17 (↑/↓ selection move, Enter open, Home/End jump,
 * PgUp/PgDn viewport jump, Esc unfocus).
 *
 * The factory takes the current sorted-IDs array and the context's
 * selection + open/select callbacks, and returns a single keydown
 * handler bound at document level. The `pageSize` parameter is the
 * approximate visible-row count used for Page Up/Down jumps (defaults
 * to 10 — close to a 4K-sized viewport's row capacity).
 *
 * Skips events originating inside editable targets (input / textarea /
 * contenteditable) so the editor body doesn't receive sidebar nav.
 */
export function makeKeyboardNavHandler(opts: {
  sortedIds: readonly NoteId[];
  selectedId: NoteId | null;
  renamingId: NoteId | null;
  select: (id: NoteId | null) => void;
  open: (id: NoteId) => Promise<unknown>;
  pageSize?: number;
  /** Collapse the multi-selection (MYND-367) — cursor-moving keys and Escape
   *  drop the set, mirroring Finder. Optional so isolated callers can omit it. */
  clearMultiSelection?: () => void;
}): (e: KeyboardEvent) => void {
  const {
    sortedIds,
    selectedId,
    renamingId,
    select,
    open,
    pageSize = 10,
    clearMultiSelection,
  } = opts;
  // Cursor-moving keys collapse any multi-selection before they move the
  // single cursor — arrow-nav after a multi-select returns to single mode.
  const moveSelect = (id: NoteId | null): void => {
    clearMultiSelection?.();
    select(id);
  };

  const isEditableTarget = (target: EventTarget | null): boolean => {
    const el = target as HTMLElement | null;
    if (el === null) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return true;
    if (el.isContentEditable) return true;
    return false;
  };

  return (e: KeyboardEvent) => {
    if (renamingId !== null) return; // rename mode owns keys
    if (isEditableTarget(e.target)) return;
    if (sortedIds.length === 0) return;
    const idx = selectedId === null ? -1 : sortedIds.indexOf(selectedId);

    switch (e.key) {
      case "ArrowDown": {
        e.preventDefault();
        const next = idx < 0 ? 0 : Math.min(idx + 1, sortedIds.length - 1);
        moveSelect(sortedIds[next] ?? null);
        return;
      }
      case "ArrowUp": {
        e.preventDefault();
        const next = idx <= 0 ? 0 : idx - 1;
        moveSelect(sortedIds[next] ?? null);
        return;
      }
      case "Home": {
        e.preventDefault();
        moveSelect(sortedIds[0] ?? null);
        return;
      }
      case "End": {
        e.preventDefault();
        moveSelect(sortedIds[sortedIds.length - 1] ?? null);
        return;
      }
      case "PageDown": {
        e.preventDefault();
        const target = Math.min(
          idx < 0 ? pageSize - 1 : idx + pageSize,
          sortedIds.length - 1,
        );
        moveSelect(sortedIds[target] ?? null);
        return;
      }
      case "PageUp": {
        e.preventDefault();
        const target = idx < 0 ? 0 : Math.max(idx - pageSize, 0);
        moveSelect(sortedIds[target] ?? null);
        return;
      }
      case "Enter": {
        if (selectedId !== null) {
          e.preventDefault();
          void open(selectedId);
        }
        return;
      }
      case "Escape": {
        // Drop a multi-selection (MYND-367); leave `selectedId` so the editor
        // keeps the open note. No-op when nothing is multi-selected.
        clearMultiSelection?.();
        return;
      }
      default:
        return;
    }
  };
}

/**
 * Inline-rename trigger orchestrator — derives current bytes via
 * `noteRead` and dispatches `commitRename` (Q9 helper). Extracted so
 * unit tests can verify the read-then-commit composition without
 * rendering a tree.
 */
export async function executeRenameCommit(
  noteId: NoteId,
  newTitle: string,
  ctx: Pick<UseSelectedNoteReturn, "commitRename">,
  read: (id: NoteId) => Promise<string> = noteRead,
): Promise<void> {
  const currentBytes = await read(noteId);
  await ctx.commitRename(noteId, currentBytes, newTitle);
}

const HEADER_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "14px 14px 6px",
  flexShrink: 0,
};

const HEADER_BUTTON_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  fontWeight: 500,
  color: "var(--fg-3)",
  background: "transparent",
  border: 0,
  padding: "2px 6px",
  borderRadius: 3,
  cursor: "pointer",
};

/** Right-aligned cluster holding the header's "+ Folder" / "+ New Note" buttons. */
const HEADER_ACTIONS_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 2,
};

/** Leading group: the collapse chevron + the "Notes" eyebrow, kept together
 *  so the header stays a clean two-group `space-between` row (MYND-137). */
const HEADER_LEAD_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
};

/** "Favorites" eyebrow row — pinned above the "Notes" header (MYND-183). Same
 *  eyebrow treatment as the Notes header, no action icons. */
const FAV_HEADER_STYLE: CSSProperties = {
  padding: "14px 14px 6px",
  flexShrink: 0,
};

/** Hairline divider between the Favorites section and the Notes tree below. */
const FAV_DIVIDER_STYLE: CSSProperties = {
  height: 1,
  background: "var(--line-1)",
  opacity: 0.65,
  margin: "6px 14px 0",
  flexShrink: 0,
};

const EMPTY_WRAPPER_STYLE: CSSProperties = {
  display: "flex",
  flex: 1,
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  padding: "0 20px 40px",
  textAlign: "center",
  gap: 14,
  minWidth: 0,
};

const EMPTY_COPY_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  color: "var(--fg-3)",
};

const EMPTY_CTA_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  fontWeight: 500,
  color: "var(--accent-on)",
  background: "var(--accent)",
  border: 0,
  padding: "10px 14px",
  borderRadius: 6,
  cursor: "pointer",
};

const SIDEBAR_OUTER_STYLE: CSSProperties = {
  // Fills the layout-seam wrapper, which owns the resizable width (MYND-137).
  // `flex: 1` lets it fill the height below the ribbon header in the
  // sidebar column (MYND-166); harmless outside a flex parent.
  width: "100%",
  flex: 1,
  background: "var(--paper-2)",
  borderRight: "1px solid var(--line-1)",
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
};

// Sidebar footer wrapper — pins the nav entries (Attachments + Trash) to
// the bottom of the sidebar (MYND-133 / MYND-170).
const FOOTER_WRAP_STYLE: CSSProperties = {
  marginTop: "auto",
  flexShrink: 0,
};

// Footer nav entry — full-width row with a leading icon (MYND-133 / MYND-170).
const FOOTER_ENTRY_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  width: "100%",
  padding: "var(--space-3) var(--space-4)",
  border: "none",
  borderTop: "1px solid var(--line-1)",
  background: "transparent",
  color: "var(--fg-2)",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  cursor: "pointer",
  textAlign: "left",
};

const TRASH_COUNT_BADGE_STYLE: CSSProperties = {
  marginLeft: "auto",
  fontSize: 11,
  color: "var(--fg-3)",
};

const LIST_OUTER_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
};

/** Horizontal indent applied to a note row per tree depth level (matches the
 *  folder-row indent). */
const NOTE_INDENT_PER_LEVEL = 18;

// Folder disclosure animation (expand/collapse). Each revealed/hidden
// descendant row plays a staggered enter/exit keyframe. `BASE_MS` mirrors
// `--duration-base` (tokens.css); the JS deferral timer must outlast the
// slowest row (base + the capped stagger) so the fold/cleanup fires only after
// the motion is done. Stagger is capped so a folder with many children doesn't
// drag the cleanup out indefinitely.
const TREE_ANIM_BASE_MS = 180;
const TREE_ANIM_STAGGER_MS = 18;
const TREE_ANIM_MAX_STAGGER = 8;
const TREE_ANIM_TOTAL_MS =
  TREE_ANIM_BASE_MS + TREE_ANIM_MAX_STAGGER * TREE_ANIM_STAGGER_MS + 60;

const NEW_FOLDER_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 14px",
};

const NEW_FOLDER_INPUT_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  fontWeight: 600,
  color: "var(--fg-1)",
  background: "var(--paper-1)",
  border: "1px solid var(--accent)",
  borderRadius: 3,
  padding: "3px 6px",
  outline: "none",
};

const BLOCK_NOTICE_STYLE: CSSProperties = {
  margin: "6px 10px",
  padding: "8px 10px",
  background: "var(--warning-soft, var(--paper-1))",
  borderLeft: "2px solid var(--line-3)",
  borderRadius: 3,
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  color: "var(--fg-2)",
  flexShrink: 0,
};

const CASE_MERGE_STYLE: CSSProperties = {
  margin: "6px 10px",
  padding: "10px",
  background: "var(--accent-soft)",
  borderRadius: 4,
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  color: "var(--fg-2)",
  flexShrink: 0,
};

const CASE_MERGE_ACTIONS_STYLE: CSSProperties = {
  display: "flex",
  gap: 8,
  justifyContent: "flex-end",
  marginTop: 8,
};

/** Optional props. `onNewFromTemplate` wires the new-note caret that opens
 *  the template flow (MYND-190); omitted → the caret is not rendered.
 *
 *  The sidebar collapse toggle moved to a floated `TitleBarToggle` in the
 *  editor's top-left corner, and the vault switcher to the
 *  `SidebarVaultSwitcher` header above this list (MYND-166); neither is
 *  hosted here. */
interface NoteListProps {
  onNewFromTemplate?: () => void;
  /** UI hooks for the per-note export flow (MYND-116) — the Editor's
   *  structured toast sink + the pre-flight "Include N attachments"
   *  modal hook. Optional so isolated NoteList renders stay inert. */
  exportHooks?: NoteExportUiHooks;
}

/** Filter-builder open state (MYND-282): creating a new view, or editing an
 *  existing one (carrying the parsed draft — `null` when its filter is outside
 *  the builder's representable set, so it opens read-only). */
type BuilderState =
  | { mode: "new" }
  | { mode: "edit"; view: SavedView; draft: FilterDraft | null };

const EMPTY_DRAFT: FilterDraft = { combinator: "and", groups: [] };

export function NoteList({ onNewFromTemplate, exportHooks }: NoteListProps = {}) {
  const ctx = useSelectedNote();
  // SYNC-9: opening a note via keyboard nav (Enter) also returns the center
  // pane to the editor — covers the Enter-on-already-selected edge the
  // `selectedId` effect can't see. No-op outside the Editor provider.
  const { setView } = useCenterView();
  const openNote = useCallback(
    (id: NoteId): Promise<unknown> => {
      setView("editor");
      return ctx.open(id);
    },
    [ctx, setView],
  );
  // Folder-management state + handlers (deliberate_folders set, context menu,
  // create / rename / delete / drag-drop). Owns the deliberate set.
  const fm = useFolderManagement(ctx);

  // Saved Views (MYND-274): the sidebar "Views" section reads the saved-view
  // list from prefs and opens a view as a workspace tab. `ws.openView` is the
  // task-2 entry. Views are rendered in display order (view_order first, then
  // any not-yet-ordered).
  const ws = useWorkspace();
  // The saved-view list. Refresh is handled centrally: the saved-view prefs
  // writers bump the prefs nonce at the IPC chokepoint and `usePrefs` re-reads
  // on that bump — so the mutations below don't reload explicitly (no per-write
  // double read, and a save from a sibling surface like the Tag browser lands
  // here too).
  const { prefs: viewsPrefs } = usePrefs();
  const orderedViews = useMemo<SavedView[]>(() => {
    const byId = new Map(viewsPrefs.saved_views.map((v) => [v.id, v]));
    const ordered: SavedView[] = [];
    for (const id of viewsPrefs.view_order) {
      const v = byId.get(id);
      if (v !== undefined) {
        ordered.push(v);
        byId.delete(id);
      }
    }
    for (const v of viewsPrefs.saved_views) {
      if (byId.has(v.id)) ordered.push(v);
    }
    return ordered;
  }, [viewsPrefs.saved_views, viewsPrefs.view_order]);
  // Filter builder (MYND-282): "+ New view" no longer creates a blank view
  // immediately — it opens the builder empty. "Edit filter…" (ViewsSection
  // context menu) reopens it seeded with an existing view's filter, parsed back
  // into the draft. Saving with no conditions yields an all-pages view (the prior
  // behavior as the empty case); any conditions compose a `FilterNode` via the
  // pure `filterDraft` core. An unrepresentable filter (`draft === null`) opens
  // read-only (fail-safe) rather than silently dropping conditions.
  const [builder, setBuilder] = useState<BuilderState | null>(null);
  const handleNewView = useCallback(() => setBuilder({ mode: "new" }), []);
  const handleEditFilter = useCallback(
    (id: string) => {
      const view = viewsPrefs.saved_views.find((v) => v.id === id);
      if (view === undefined) return;
      setBuilder({ mode: "edit", view, draft: filterNodeToDraft(view.filters) });
    },
    [viewsPrefs.saved_views],
  );
  const handleSaveFilter = useCallback(
    (draft: FilterDraft) => {
      const current = builder;
      setBuilder(null);
      const filters = draftToFilterNode(draft);
      void (async () => {
        try {
          if (current?.mode === "edit") {
            await upsertSavedView({ ...current.view, filters });
          } else {
            const id = crypto.randomUUID();
            await upsertSavedView({ id, name: "New view", view_type: "cards", filters });
            ws.openView(id);
          }
        } catch {
          // Save failure surfaces via backend tracing; the user can retry.
        }
      })();
    },
    [builder, ws],
  );
  // View display settings (cards cover image / aspect ratio / card size). A
  // sibling of the filter builder: a separate modal opened from the ViewsSection
  // context menu ("View settings…", cards-only). Kept off `BuilderState` (which
  // is `FilterDraft`-typed) — it edits the cards-render fields, not the filter.
  const [viewSettings, setViewSettings] = useState<SavedView | null>(null);
  const handleViewSettings = useCallback(
    (id: string) => {
      const view = viewsPrefs.saved_views.find((v) => v.id === id);
      if (view === undefined) return;
      setViewSettings(view);
    },
    [viewsPrefs.saved_views],
  );
  const handleSaveViewSettings = useCallback(
    (patch: ViewDisplayPatch) => {
      const current = viewSettings;
      setViewSettings(null);
      if (current === null) return;
      // Spread merges the patch onto the view; a field cleared to `undefined`
      // overrides the stored value and drops off the wire (JSON omits undefined),
      // matching the Rust `skip_serializing_if = "None"` on these fields.
      void (async () => {
        try {
          await upsertSavedView({ ...current, ...patch });
        } catch {
          /* surfaced via backend tracing */
        }
      })();
    },
    [viewSettings],
  );
  // Property-name suggestions for the cover-image field: the frontmatter keys
  // present in the open settings view's current result (no new IPC — same
  // projection the cards render). `""` id → the hook yields no result (inert).
  const settingsViewResult = useViewResult(viewSettings?.id ?? "");
  const viewPropertySuggestions = useMemo<string[]>(() => {
    const keys = new Set<string>();
    for (const group of settingsViewResult.result?.groups ?? []) {
      for (const row of group.rows) {
        for (const key of Object.keys(row.values)) keys.add(key);
      }
    }
    return [...keys].sort();
  }, [settingsViewResult.result]);

  // Task 6 — view management: rename / delete / reorder, each persisted via
  // #3's prefs API then reflected immediately by re-reading prefs. A deleted
  // view's open tab is left as a generic view host (the "shown-missing" pinned
  // choice — no crash; the user closes it).
  const handleRenameView = useCallback(
    (id: string, name: string) => {
      const view = viewsPrefs.saved_views.find((v) => v.id === id);
      if (view === undefined) return;
      void (async () => {
        try {
          await upsertSavedView({ ...view, name });
        } catch {
          /* surfaced via backend tracing */
        }
      })();
    },
    [viewsPrefs.saved_views],
  );
  const handleDeleteView = useCallback(
    (id: string) => {
      void (async () => {
        try {
          await deleteSavedView(id);
        } catch {
          /* surfaced via backend tracing */
        }
      })();
    },
    [],
  );
  const handleMoveView = useCallback(
    (id: string, dir: -1 | 1) => {
      const nextOrder = moveInOrder(
        orderedViews.map((v) => v.id),
        id,
        dir,
      );
      void (async () => {
        try {
          await setViewOrder(nextOrder);
        } catch {
          /* surfaced via backend tracing */
        }
      })();
    },
    [orderedViews],
  );

  // Ephemeral collapse state — folded folder keys. Default empty = all
  // expanded; reset on app restart (folder paths are AS3 → no persistence).
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  // Mirror the latest committed value so `toggleFolder` can read it
  // synchronously (decide expand-vs-collapse) without a stale closure.
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  // Active disclosure animation, if any. `nonce` guards against a stale timer
  // clearing a newer animation. `mode` picks the enter vs exit keyframe applied
  // to the toggled folder's descendant rows.
  const [treeAnim, setTreeAnim] = useState<{
    folderKey: string;
    mode: "in" | "out";
    nonce: number;
  } | null>(null);
  const treeAnimNonce = useRef(0);
  const treeAnimTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Folder key of a collapse whose fold is deferred until its exit animation
  // ends. If a new toggle interrupts it, we flush this fold immediately so the
  // interrupted folder doesn't get stuck visually-open.
  const pendingCollapse = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (treeAnimTimer.current) clearTimeout(treeAnimTimer.current);
    },
    [],
  );
  const toggleFolder = useCallback((key: string) => {
    const collapsing = !collapsedRef.current.has(key);
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    if (treeAnimTimer.current) {
      clearTimeout(treeAnimTimer.current);
      treeAnimTimer.current = null;
    }
    // Flush any interrupted deferred collapse before starting a new operation.
    if (pendingCollapse.current !== null && pendingCollapse.current !== key) {
      const stuck = pendingCollapse.current;
      setCollapsed((prev) => {
        const next = new Set(prev);
        next.add(stuck);
        return next;
      });
    }
    pendingCollapse.current = null;
    // Reduced motion (or any non-animated path): flip immediately.
    if (reduce) {
      setTreeAnim(null);
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (collapsing) next.add(key);
        else next.delete(key);
        return next;
      });
      return;
    }
    treeAnimNonce.current += 1;
    const nonce = treeAnimNonce.current;
    if (collapsing) {
      // Defer the actual fold until the exit animation finishes — the
      // descendant rows stay in `rows` and play `myne-tree-row-out` meanwhile.
      pendingCollapse.current = key;
      setTreeAnim({ folderKey: key, mode: "out", nonce });
      treeAnimTimer.current = setTimeout(() => {
        pendingCollapse.current = null;
        setCollapsed((prev) => {
          const next = new Set(prev);
          next.add(key);
          return next;
        });
        setTreeAnim((a) => (a?.nonce === nonce ? null : a));
        treeAnimTimer.current = null;
      }, TREE_ANIM_TOTAL_MS);
    } else {
      // Expand now — the descendant rows mount and play `myne-tree-row-in`.
      setCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setTreeAnim({ folderKey: key, mode: "in", nonce });
      treeAnimTimer.current = setTimeout(() => {
        setTreeAnim((a) => (a?.nonce === nonce ? null : a));
        treeAnimTimer.current = null;
      }, TREE_ANIM_TOTAL_MS);
    }
  }, []);

  // The folder tree is a derived view of each note's `folder:` field unioned
  // with the deliberate-folder set (Task 3 `deriveFolderTree`). Memo on cache
  // identity (mutations replace the Map) + the deliberate set.
  // Trashed notes (value-strict `trashed:` marker) are excluded from the live
  // sidebar everywhere — tree, rows, favorites — via a single derived
  // `live` view of the cache (MYND-133). The Trash panel reads the complement
  // (`trashedRecords`). Restore clears the marker → the note re-enters `live`.
  const live = useMemo(() => liveCache(ctx.cache), [ctx.cache]);
  const tree = useMemo(
    () =>
      deriveFolderTree(
        Array.from(live.values()).map((r) => ({
          noteUuid: r.noteUuid,
          folder: r.folder,
        })),
        fm.deliberate,
      ),
    [live, fm.deliberate],
  );
  // Keep the handlers' tree reference current (delete-emptiness, case-merge).
  fm.treeRef.current = tree;
  // Flat folder choices for the filter builder's folder-condition picker, in
  // tree order, indented by depth (the canonical path is the stored value; the
  // engine folds it via `folderKey`).
  const folderOptions = useMemo<FolderOption[]>(() => {
    const out: FolderOption[] = [];
    const walk = (nodes: readonly FolderNode[]) => {
      for (const n of nodes) {
        out.push({ path: n.path, label: `${" ".repeat(n.depth - 1)}${n.name}` });
        walk(n.children);
      }
    };
    walk(tree.roots);
    return out;
  }, [tree]);
  // Unified manual order (item_order) interleaves folders + loose notes per
  // container (MYND-183); flatten owns all display ordering.
  const rows = useMemo(
    () => flattenVisibleRows(tree, live, collapsed, fm.itemOrder),
    [tree, live, collapsed, fm.itemOrder],
  );
  // Per-row disclosure-animation lookup: when `treeAnim` is active, the toggled
  // folder's contiguous descendant rows (depth > the folder's, until the depth
  // returns to its level) get a staggered enter/exit treatment. Keyed by
  // VirtualList row key so `renderItem` can hand each row's `mode` + `delay` to
  // its `DisclosureWrapper` without prop-drilling.
  const treeAnimRows = useMemo(() => {
    const map = new Map<string, { mode: "in" | "out"; delay: number }>();
    if (treeAnim === null) return map;
    const anchor = rows.findIndex((r) => r.key === `f-${treeAnim.folderKey}`);
    if (anchor < 0) return map;
    const folderDepth = rows[anchor]!.depth;
    let i = 0;
    for (let r = anchor + 1; r < rows.length; r++) {
      if (rows[r]!.depth <= folderDepth) break;
      const delay = Math.min(i, TREE_ANIM_MAX_STAGGER) * TREE_ANIM_STAGGER_MS;
      map.set(rows[r]!.key, { mode: treeAnim.mode, delay });
      i++;
    }
    return map;
  }, [treeAnim, rows]);
  // Favorites section rows (MYND-183) — note rows keyed `fav-<id>`, rendered
  // above the tree. Stale-UUID GC (render half) is in `buildFavoriteRows`; a
  // trashed favorite is absent from `live` so it is hidden until restore.
  const favRows = useMemo(
    () => buildFavoriteRows(fm.favorites, live),
    [fm.favorites, live],
  );
  // Keyboard navigation: Favorites first, then the tree; `visibleNoteIds`
  // dedupes a note shown in both down to its (reachable) Favorites copy.
  const navIds = useMemo(
    () => visibleNoteIds([...favRows, ...rows]),
    [favRows, rows],
  );
  const isEmpty = rows.length === 0 && favRows.length === 0;

  // Trash entry (MYND-133): a sidebar footer showing the trashed-note count,
  // opening the Trash panel. Visible in both the empty + populated states so a
  // user can always reach the trash. The count comes from the same value-strict
  // `trashed:` marker that excludes these notes from the live tree above.
  const [trashOpen, setTrashOpen] = useState(false);
  // Count the value-strict `trashed:` set directly: `live` now also excludes
  // templates (MYND-186), so the old `cache.size - live.size` delta would
  // over-count the trash by the template population. Memoized on cache identity
  // (like `live`) so the scan runs once per mutation, not on every re-render
  // (NoteList re-renders on selection / rename-toggle, which don't touch cache).
  const trashCount = useMemo(() => trashedCount(ctx.cache), [ctx.cache]);

  // F2 global keymap → enter inline-rename on the selected row.
  useEffect(() => {
    const handler = makeF2KeydownHandler(ctx);
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [ctx]);

  // Keyboard nav (↑/↓/Enter/Home/End/PgUp/PgDn) — document-level so the
  // editor body can stay focused naturally; handler bails out on
  // editable targets so it doesn't fight CM6 / textarea key handling.
  useEffect(() => {
    const handler = makeKeyboardNavHandler({
      sortedIds: navIds,
      selectedId: ctx.selectedId,
      renamingId: ctx.renamingId,
      select: ctx.select,
      open: openNote,
      clearMultiSelection: ctx.clearMultiSelection,
    });
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [navIds, ctx, openNote]);

  const handleCreate = useCallback(() => {
    void ctx.createAndStartRename().catch((err) => {
      // Surface in dev console; production UX uses BottomBar toast (T27)
      // once the save-status pipeline is wired. Silent-fail here is
      // acceptable — the IPC failure is the rare path.
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn("[NoteList] createNote failed:", err);
      }
    });
  }, [ctx]);

  return (
    <aside style={SIDEBAR_OUTER_STYLE}>
      {isEmpty ? (
        <EmptyState
          onCreate={handleCreate}
          fm={fm}
          onNewFromTemplate={onNewFromTemplate}
        />
      ) : (
        <PopulatedList
          rows={rows}
          favRows={favRows}
          navIds={navIds}
          treeAnimRows={treeAnimRows}
          folderOptions={folderOptions}
          onToggleFolder={toggleFolder}
          onCreate={handleCreate}
          fm={fm}
          onNewFromTemplate={onNewFromTemplate}
          exportHooks={exportHooks}
          showTimestamps={viewsPrefs.show_note_timestamps}
        />
      )}
      <ViewsSection
        views={orderedViews}
        onOpenView={(id) => ws.openView(id)}
        onNewView={handleNewView}
        onEditFilter={handleEditFilter}
        onViewSettings={handleViewSettings}
        onRename={handleRenameView}
        onDelete={handleDeleteView}
        onMoveView={handleMoveView}
      />
      {viewSettings !== null && viewSettings.view_type === "cards" && (
        <ViewSettings
          title={
            viewSettings.name.trim() === ""
              ? "View settings"
              : viewSettings.name
          }
          initial={{
            image: viewSettings.image,
            image_aspect_ratio: viewSettings.image_aspect_ratio,
            card_size: viewSettings.card_size,
          }}
          propertySuggestions={viewPropertySuggestions}
          onCancel={() => setViewSettings(null)}
          onSave={handleSaveViewSettings}
        />
      )}
      {builder !== null && (
        <FilterBuilder
          title={builder.mode === "edit" ? "Edit filter" : "New view"}
          initialDraft={
            builder.mode === "edit" ? (builder.draft ?? EMPTY_DRAFT) : EMPTY_DRAFT
          }
          representable={builder.mode === "new" || builder.draft !== null}
          folderOptions={folderOptions}
          onCancel={() => setBuilder(null)}
          onSave={handleSaveFilter}
        />
      )}
      <div style={FOOTER_WRAP_STYLE}>
        <AttachmentsNavEntry />
        <button
          type="button"
          style={FOOTER_ENTRY_STYLE}
          data-testid="notes.trash-open"
          onClick={() => setTrashOpen(true)}
          title="Open the trash"
        >
          <Icon name="trash-2" size={15} />
          <span>Trash</span>
          {trashCount > 0 && (
            <span style={TRASH_COUNT_BADGE_STYLE}>{trashCount}</span>
          )}
        </button>
      </div>
      <TrashPanel open={trashOpen} onClose={() => setTrashOpen(false)} />
    </aside>
  );
}

function EmptyState({
  onCreate,
  fm,
  onNewFromTemplate,
}: {
  onCreate: () => void;
  fm: FolderManagement;
  onNewFromTemplate?: () => void;
}) {
  return (
    <div style={LIST_OUTER_STYLE}>
      <div style={HEADER_ROW_STYLE}>
        <div style={HEADER_LEAD_STYLE}>
          <div style={SECTION_HEADING_STYLE}>Notes</div>
        </div>
        <div style={HEADER_ACTIONS_STYLE}>
          <IconButton
            icon="folder-plus"
            label="New folder"
            testId="notes.new-folder"
            onClick={() => fm.startNewFolder("")}
          />
          <IconButton
            icon="file-plus"
            label="New note"
            testId="notes.create"
            onClick={onCreate}
          />
          {onNewFromTemplate && (
            <IconButton
              icon="chevron-down"
              label="New note from template…"
              onClick={onNewFromTemplate}
            />
          )}
        </div>
      </div>
      {fm.newFolder !== null && (
        <NewFolderInput
          parentPath={fm.newFolder.parentPath}
          onCommit={fm.commitNewFolder}
          onCancel={fm.cancelNewFolder}
        />
      )}
      <div style={EMPTY_WRAPPER_STYLE}>
        <div style={EMPTY_COPY_STYLE}>No notes yet.</div>
        <button type="button" onClick={onCreate} style={EMPTY_CTA_STYLE}>
          + Create your first note
        </button>
      </div>
    </div>
  );
}

/**
 * Wraps a folder-tree row during an expand/collapse so the row's HEIGHT
 * collapses (`grid-template-rows` 1fr↔0fr) alongside the opacity fade. The
 * VirtualList's per-row ResizeObserver picks up the shrinking height each frame
 * and reflows its spacers, so the fold reads as a smooth glide instead of the
 * rows fading in place and the list snapping shut once they're finally removed.
 *
 * Idle (`anim === null`): a plain 1fr grid with no transition and overflow
 * visible — structurally identical to the animating state so the row never
 * remounts (a remount would flash at the end of an expand) and the rename
 * input's focus ring isn't clipped. Entering/exiting flips `open` on the frame
 * AFTER the resting "from" state paints, giving the browser a value to
 * transition from. `overflow: hidden` is applied only while animating (a
 * collapse/expand never coincides with a rename). Reduced motion zeroes
 * transition-duration globally (tokens.css) and NoteList skips the deferred
 * path, so this resolves instantly there.
 */
function DisclosureWrapper({
  anim,
  delay,
  children,
}: {
  anim: "in" | "out" | null;
  delay: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(anim !== "in");
  useLayoutEffect(() => {
    if (anim === null) {
      setOpen(true);
      return;
    }
    // Paint the resting "from" state (in → closed, out → open), then flip to the
    // target on the next frame so the property change actually transitions.
    setOpen(anim === "out");
    const frame = requestAnimationFrame(() => setOpen(anim !== "out"));
    return () => cancelAnimationFrame(frame);
  }, [anim]);

  const animating = anim !== null;
  const easing = anim === "in" ? "var(--ease-out)" : "var(--ease-standard)";
  return (
    <div
      style={{
        display: "grid",
        gridTemplateRows: open ? "1fr" : "0fr",
        opacity: open ? 1 : 0,
        transition: animating
          ? `grid-template-rows var(--duration-base) ${easing} ${delay}ms, opacity var(--duration-base) ${easing} ${delay}ms`
          : undefined,
        willChange: animating ? "grid-template-rows, opacity" : undefined,
      }}
    >
      <div style={{ minHeight: 0, overflow: animating ? "hidden" : "visible" }}>
        {children}
      </div>
    </div>
  );
}

type ContextMenuState = { id: NoteId; x: number; y: number } | null;

function PopulatedList({
  rows,
  favRows,
  navIds,
  treeAnimRows,
  folderOptions,
  onToggleFolder,
  onCreate,
  fm,
  onNewFromTemplate,
  exportHooks,
  showTimestamps,
}: {
  rows: VisibleRow[];
  favRows: VisibleRow[];
  navIds: NoteId[];
  /** Flat folder choices (tree order, depth-indented label) for the bulk
   *  "Move N notes to…" target submenu (MYND-367). Reuses the parent's memo. */
  folderOptions: FolderOption[];
  /** Per-row folder disclosure-animation descriptors, keyed by VirtualList row
   *  key (empty when no expand/collapse is animating). Computed in the parent so
   *  it shares `treeAnim` state with the toggle handler; each entry's `mode` +
   *  `delay` drive that row's `DisclosureWrapper`. */
  treeAnimRows: ReadonlyMap<string, { mode: "in" | "out"; delay: number }>;
  onToggleFolder: (key: string) => void;
  onCreate: () => void;
  fm: FolderManagement;
  onNewFromTemplate?: () => void;
  exportHooks?: NoteExportUiHooks;
  /** Sidebar per-note timestamp visibility (sidebar-note-timestamps), read from
   *  `PrefsView.show_note_timestamps` in the parent. Threaded into every
   *  `<NoteRow>` (tree + Favorites) via `renderNoteRow`. */
  showTimestamps: boolean;
}) {
  const ctx = useSelectedNote();
  // SYNC-9 exclusive active-state (MYND-164): opening a note from the sidebar
  // returns the center pane to the editor. The `selectedId`-keyed effect in
  // Editor.tsx covers note-to-note switches; this explicit reset also handles
  // re-clicking the ALREADY-selected note while the Attachments view is open
  // (no `selectedId` change → that effect wouldn't fire). No-op fallback
  // outside the Editor provider, so isolated NoteList renders stay inert.
  const { view, setView } = useCenterView();
  const ws = useWorkspace();
  // Open a note from the sidebar into the workspace (MYND-166). Modifiers /
  // context-menu choose the target: Alt → split to the side; Cmd/Ctrl or
  // middle → new tab; plain → reuse the focused tab. `setView("editor")` also
  // covers the re-click-the-already-selected-note-while-Attachments-open edge
  // the `selectedId` effect can't see (no `selectedId` change → no fire). The
  // editor mirrors the focused pane's active note back into `selectedId` for
  // row highlight (Editor.tsx bridge B). No-op fallback outside the providers.
  const openNote = useCallback(
    (id: NoteId, opts?: { newTab?: boolean; toSide?: boolean }) => {
      setView("editor");
      // Plain click → open in the focused pane's CURRENT active tab (reuse);
      // Cmd/Ctrl-click (or middle) → a new tab; Alt-click → split to the
      // side. Re-opening an already-open note reveals it (duplicate-forbid).
      if (opts?.toSide) ws.openToSide(id);
      else if (opts?.newTab) ws.openNewTabInFocused(id);
      else ws.openInFocused(id);
    },
    [ws, setView],
  );
  // SYNC-9 exclusive active-state (MYND-164 Fix 1): while the Attachments view
  // owns the center pane, NO sidebar note row renders its selected highlight —
  // the Attachments footer entry is the sole active surface. The selection is
  // preserved in `ctx.selectedId` (so returning to the editor restores it); it
  // just isn't *shown* as active here. Exactly one of {a note, Attachments} is
  // highlighted at any time.
  const noteHighlightActive = view !== "attachments";
  // Row activation intent router (MYND-166 open modifiers + MYND-367 multi-
  // select). Toggle / range gestures only mutate the selection SET (they never
  // open — see `SidebarState.selectedIds`); every open action first collapses
  // the set back to a single selection so the editor and the highlight agree.
  const activateRow = useCallback(
    (
      id: NoteId,
      opts?: {
        newTab?: boolean;
        toSide?: boolean;
        toggle?: boolean;
        range?: boolean;
      },
    ) => {
      if (opts?.range) {
        // Range pivots on anchorId ?? selectedId ?? target, so a plain-click
        // selection is already included as the anchor (no seeding needed).
        ctx.selectRange(navIds, id);
        return;
      }
      if (opts?.toggle) {
        // Seed the set with the currently-open note when starting a fresh
        // multi-selection (Finder intuition: click A, cmd-click B → {A, B}).
        // selectedId is the open-bridge surface; fold it into the bulk set so
        // the open note isn't silently excluded from the operation.
        if (
          ctx.selectedIds.size === 0 &&
          ctx.selectedId !== null &&
          ctx.selectedId !== id
        ) {
          ctx.replaceSelection([ctx.selectedId, id]);
        } else {
          ctx.toggleInSelection(id);
        }
        return;
      }
      ctx.clearMultiSelection();
      openNote(id, opts);
    },
    [ctx, navIds, openNote],
  );
  const [menu, setMenu] = useState<ContextMenuState>(null);
  // Bulk "Move N notes to…" target submenu anchor (MYND-367) — opened from the
  // bulk context menu, lists folder options + Vault root.
  const [moveTarget, setMoveTarget] = useState<{ x: number; y: number } | null>(
    null,
  );
  // Undo target for a bulk trash (MYND-367) — the ids just moved to Trash, so
  // "Undo" can restore the whole set (parity with the single-note undo toast).
  const [bulkUndo, setBulkUndo] = useState<readonly NoteId[] | null>(null);
  // Undo-toast target: the id of the note just moved to the trash. "Undo"
  // restores it (MYND-133). Replaced when another note is trashed.
  const [undoToast, setUndoToast] = useState<NoteId | null>(null);
  // Non-blocking error toast shown when a trash IPC fails after rollback.
  const [trashError, setTrashError] = useState<string | null>(null);
  // Right-click on the sidebar background (not a row) → root-level menu
  // ("New folder" / "New note"). Story F2. A row's own context-menu handler
  // calls `preventDefault`, so we bail when the event was already handled.
  const [bgMenu, setBgMenu] = useState<{ x: number; y: number } | null>(null);
  const handleBackgroundContextMenu = useCallback((e: MouseEvent) => {
    if (e.defaultPrevented) return; // a note / folder row already handled it
    e.preventDefault();
    setBgMenu({ x: e.clientX, y: e.clientY });
  }, []);
  // Click on the empty sidebar background → drop the multi-selection (MYND-367).
  // A click that landed on a note/folder row or inside an open menu is handled
  // by that surface (a row's own activation already collapses or extends the
  // set), so skip those — only a genuine empty-space click clears.
  const handleBackgroundClick = useCallback(
    (e: MouseEvent) => {
      if (ctx.selectedIds.size === 0) return;
      const el = e.target as HTMLElement | null;
      if (
        el !== null &&
        el.closest(
          '[data-testid="notes.row"],[data-testid="notes.folder-row"],[role="menu"]',
        ) !== null
      ) {
        return;
      }
      ctx.clearMultiSelection();
    },
    [ctx],
  );
  const closeBgMenu = useCallback(() => setBgMenu(null), []);
  // Decoration picker (MYND-184 color labels / MYND-185 folder icons) — an
  // anchored popover opened from a flat "Color…" / "Customize…" context-menu
  // item (so ContextMenu itself stays lean). `folderPath` is set for a folder
  // (the icon section keys on it, MYND-185), null for a note (color only).
  const [decoPopover, setDecoPopover] = useState<{
    x: number;
    y: number;
    key: string;
    folderPath: string | null;
  } | null>(null);
  const closeDecoPopover = useCallback(() => setDecoPopover(null), []);

  const handleContextMenu = useCallback(
    (id: NoteId, pos: { x: number; y: number }) => {
      // Do NOT select the right-clicked row. Under the MYND-166 workspace
      // model a selection change drives Editor.tsx's bridge A, which OPENS
      // the note in the focused pane — so a Finder-style "right-click also
      // selects" would open the note on every right-click and, worse, leave
      // it already-open so "Open in new tab" degrades to a reveal. Right-
      // click only surfaces the menu; every menu item already acts on
      // `menu.id`, not the selection.
      setMenu({ id, x: pos.x, y: pos.y });
    },
    [],
  );

  // Favorite-membership lookup — one Set shared by the tree rows + the context
  // menu (avoids a per-row `favorites.includes` array scan).
  const favSet = useMemo(() => new Set(fm.favorites), [fm.favorites]);

  // Shared <NoteRow> renderer — the Favorites section and the tree render an
  // identical NoteRow (only the `favorited` flag + the surrounding drag wrapper
  // differ). Keeping the prop wiring in one place stops the two sites drifting.
  const renderNoteRow = useCallback(
    (record: TitleRecord, id: NoteId, favorited: boolean) => (
      <NoteRow
        record={record}
        selected={noteHighlightActive && ctx.selectedId === id}
        multiSelected={noteHighlightActive && ctx.selectedIds.has(id)}
        renaming={ctx.renamingId === id}
        onSelect={(noteId, opts) => activateRow(noteId, opts)}
        onStartRename={ctx.startRename}
        onContextMenu={handleContextMenu}
        onCommitRename={async (noteId, newTitle) => {
          await executeRenameCommit(noteId, newTitle, ctx);
        }}
        onCancelRename={ctx.cancelRename}
        favorited={favorited}
        onToggleFavorite={fm.toggleFavorite}
        colorSlot={fm.itemColors[id]}
        showTimestamps={showTimestamps}
      />
    ),
    [
      ctx,
      activateRow,
      handleContextMenu,
      fm.toggleFavorite,
      noteHighlightActive,
      fm.itemColors,
      showTimestamps,
    ],
  );

  const closeMenu = useCallback(() => setMenu(null), []);

  // Move a note to the trash (MYND-133). Reversible — no confirmation modal;
  // an undo toast offers immediate restore. If the trashed note was open, move
  // selection to an adjacent row (or clear it) so the editor doesn't dwell on a
  // note that just left the live tree. `pickAdjacentAfterDelete` runs against
  // the pre-trash nav list (the victim is still live at click time).
  const handleTrash = useCallback(
    async (id: NoteId) => {
      const wasSelected = ctx.selectedId === id;
      const adjacent = wasSelected ? pickAdjacentAfterDelete(navIds, id) : null;
      setMenu(null);
      try {
        await ctx.trashWithRollback(id);
        setUndoToast(id);
        if (wasSelected) {
          if (adjacent !== null) {
            void ctx.open(adjacent).catch(() => {
              /* editor body load failure surfaces via its own UX */
            });
          } else {
            ctx.select(null);
          }
        }
      } catch (err) {
        // Rollback already restored the row inside trashWithRollback; surface
        // a non-blocking error so the user knows it didn't take.
        setTrashError("Couldn't move the note to Trash.");
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn("[NoteList] trashWithRollback failed:", err);
        }
      }
    },
    [ctx, navIds],
  );

  // "Undo" on the trash toast → restore the just-trashed note.
  const handleUndoTrash = useCallback(() => {
    if (undoToast === null) return;
    const id = undoToast;
    setUndoToast(null);
    void ctx.restoreWithRollback(id).catch((err) => {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn("[NoteList] restore (undo) failed:", err);
      }
    });
  }, [undoToast, ctx]);

  // Bulk move (MYND-367): move the whole multi-selection to `folder` (or root)
  // best-effort, then collapse the set. Reads `selectedIds` at call time (not
  // inside the async closure) so a concurrent clear can't shrink the payload.
  const runBulkMove = useCallback(
    async (folder: string | null) => {
      const ids = [...ctx.selectedIds];
      setMoveTarget(null);
      setMenu(null);
      if (ids.length === 0) return;
      try {
        await ctx.bulkMoveWithSync(ids, folder);
      } catch (err) {
        // bulkMoveNotes never rejects (best-effort); guard defensively anyway.
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn("[NoteList] bulkMoveWithSync failed:", err);
        }
      }
      ctx.clearMultiSelection();
    },
    [ctx],
  );

  // Bulk trash (MYND-367): soft-trash the whole multi-selection (reversible via
  // the undo toast), then collapse the set. If the OPEN note is among the
  // victims, move the editor to the first surviving nav row (or clear).
  const handleBulkDelete = useCallback(async () => {
    const ids = [...ctx.selectedIds];
    setMenu(null);
    if (ids.length === 0) return;
    const victims = new Set(ids);
    const openIsVictim =
      ctx.selectedId !== null && victims.has(ctx.selectedId);
    const survivor = openIsVictim
      ? (navIds.find((nid) => !victims.has(nid)) ?? null)
      : null;
    try {
      await ctx.bulkTrashWithSync(ids);
      setBulkUndo(ids);
      if (openIsVictim) {
        if (survivor !== null) {
          void ctx.open(survivor).catch(() => {
            /* editor body load failure surfaces via its own UX */
          });
        } else {
          ctx.select(null);
        }
      }
    } catch (err) {
      setTrashError("Couldn't move the notes to Trash.");
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn("[NoteList] bulkTrashWithSync failed:", err);
      }
    }
    ctx.clearMultiSelection();
  }, [ctx, navIds]);

  // "Undo" on the bulk-trash toast → restore every just-trashed note.
  const handleUndoBulk = useCallback(() => {
    const ids = bulkUndo;
    setBulkUndo(null);
    if (ids === null) return;
    void Promise.allSettled(
      ids.map((id) => ctx.restoreWithRollback(id)),
    ).catch(() => {});
  }, [bulkUndo, ctx]);

  // Bulk "Move N notes to…" submenu: Vault root + every folder (depth-indented).
  // Folder path is the item id → addressable by `data-item-id` in E2E.
  const moveMenuItems: ContextMenuItem[] = useMemo(
    () => [
      {
        id: "__vault_root__",
        label: "Vault root",
        onSelect: () => void runBulkMove(null),
      },
      ...folderOptions.map((o) => ({
        id: o.path,
        label: o.label,
        onSelect: () => void runBulkMove(o.path),
      })),
    ],
    [folderOptions, runBulkMove],
  );

  const menuItems: ContextMenuItem[] = useMemo(() => {
    if (menu === null) return [];
    // Bulk mode: the right-clicked row is part of a multi-selection of >1 — the
    // menu acts on the whole set, not the single row under the cursor (MYND-367).
    const selCount = ctx.selectedIds.size;
    if (selCount > 1 && ctx.selectedIds.has(menu.id)) {
      return [
        {
          id: "bulk-move",
          label: `Move ${selCount} notes to…`,
          onSelect: () => setMoveTarget({ x: menu.x, y: menu.y }),
        },
        {
          id: "bulk-delete",
          label: `Delete ${selCount} notes`,
          destructive: true,
          onSelect: () => void handleBulkDelete(),
        },
      ];
    }
    return [
      {
        id: "open-in-new-tab",
        label: "Open in new tab",
        onSelect: () => openNote(menu.id, { newTab: true }),
      },
      {
        id: "open-to-side",
        label: "Open to the side",
        onSelect: () => openNote(menu.id, { toSide: true }),
      },
      {
        id: "rename",
        label: "Rename",
        onSelect: () => ctx.startRename(menu.id),
      },
      {
        // Clone the note in place (MYND-332) — new id + "(kopya)" title;
        // the copy opens in the focused pane.
        id: "duplicate",
        label: "Duplicate",
        onSelect: () => void ctx.duplicateAndOpen(menu.id),
      },
      {
        id: "favorite",
        label: favSet.has(menu.id)
          ? "Remove from favorites"
          : "Add to favorites",
        onSelect: () => fm.toggleFavorite(menu.id),
      },
      {
        id: "color",
        label: "Color…",
        onSelect: () =>
          setDecoPopover({
            x: menu.x,
            y: menu.y,
            key: menu.id,
            folderPath: null,
          }),
      },
      {
        // Per-note plaintext egress (MYND-116) — live tree note rows only;
        // Trash / Templates surfaces deliberately don't carry it.
        id: "export-markdown",
        label: "Export as Markdown…",
        onSelect: () =>
          void runNoteExportFlow(
            noteExportOptions(
              menu.id,
              ctx.cache.get(menu.id)?.title ?? null,
              exportHooks,
            ),
          ),
      },
      {
        // Sibling PDF egress (MYND-255) — same export group, same shared-
        // flow discipline (runNotePdfExportFlow is the palette's flow too).
        id: "export-pdf",
        label: "Export as PDF…",
        onSelect: () =>
          void runNotePdfExportFlow(
            noteExportOptions(
              menu.id,
              ctx.cache.get(menu.id)?.title ?? null,
              exportHooks,
            ),
          ),
      },
      {
        id: "delete",
        label: "Delete",
        destructive: true,
        onSelect: () => void handleTrash(menu.id),
      },
    ];
  }, [menu, ctx, handleTrash, handleBulkDelete, fm, favSet, openNote, exportHooks]);

  // Folder context-menu items (right-click a folder row).
  const folderMenuItems: ContextMenuItem[] = useMemo(() => {
    const menuPos = fm.menu;
    const node = menuPos?.node;
    if (node === undefined || menuPos === null) return [];
    return [
      { id: "rename", label: "Rename", onSelect: () => fm.startRenameFolder(node) },
      {
        id: "new-note",
        label: "New note here",
        onSelect: () => fm.newNoteHere(node.path),
      },
      {
        id: "new-subfolder",
        label: "New subfolder",
        onSelect: () => fm.startNewFolder(node.path),
      },
      {
        id: "color",
        label: "Customize…",
        onSelect: () =>
          setDecoPopover({
            x: menuPos.x,
            y: menuPos.y,
            key: node.path,
            folderPath: node.path,
          }),
      },
      {
        id: "delete",
        label: "Delete",
        destructive: true,
        onSelect: () => void fm.deleteFolderAction(node),
      },
    ];
  }, [fm]);

  // Background (root-level) context-menu items — Story F2.
  const bgMenuItems: ContextMenuItem[] = useMemo(
    () => [
      { id: "new-folder", label: "New folder", onSelect: () => fm.startNewFolder("") },
      { id: "new-note", label: "New note", onSelect: onCreate },
    ],
    [fm, onCreate],
  );

  // Delete/Backspace keyboard trigger on the selected row.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (ctx.renamingId !== null) return; // don't trigger mid-rename
      // Skip when the event originated in an editable target — text
      // input, textarea, or contenteditable. Otherwise typing inside
      // the editor's body would also pop a delete dialog.
      const target = e.target as HTMLElement | null;
      if (target !== null) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        if (target.isContentEditable) return;
      }
      // A multi-selection takes priority — Delete trashes the whole set
      // (MYND-367). Otherwise fall back to the single open note.
      if (ctx.selectedIds.size > 0) {
        e.preventDefault();
        void handleBulkDelete();
        return;
      }
      if (ctx.selectedId === null) return;
      e.preventDefault();
      void handleTrash(ctx.selectedId);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [ctx.selectedId, ctx.selectedIds, ctx.renamingId, handleTrash, handleBulkDelete]);

  return (
    <div
      style={LIST_OUTER_STYLE}
      onContextMenu={handleBackgroundContextMenu}
      onClick={handleBackgroundClick}
    >
      {favRows.length > 0 && (
        <div
          style={{
            flexShrink: 0,
            boxShadow: fm.favoritesDropActive
              ? "inset 0 0 0 2px var(--accent-soft)"
              : undefined,
          }}
          onDragOver={(e) => {
            // Drop in the section's non-row area = add to favorites. A favorite
            // row that handled the drag already called preventDefault (reorder),
            // so skip when over a row.
            if (e.defaultPrevented) return;
            if (fm.dragKind !== "note") return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            fm.setFavoritesDropActive(true);
          }}
          onDragLeave={() => fm.setFavoritesDropActive(false)}
          onDrop={(e) => {
            if (e.defaultPrevented) return; // a favorite row reorder handled it
            if (fm.dragKind !== "note") return;
            e.preventDefault();
            void fm.onFavoritesDropNote();
          }}
        >
          <div style={FAV_HEADER_STYLE}>
            <div style={SECTION_HEADING_STYLE}>Favorites</div>
          </div>
          {favRows.map((row) => {
            if (row.kind !== "note") return null;
            const record = ctx.cache.get(row.id);
            if (record === undefined) return null;
            const id = row.id;
            const favPlace =
              fm.favReorderTarget?.id === id ? fm.favReorderTarget.place : null;
            return (
              <div
                key={row.key}
                style={{ position: "relative" }}
                draggable={ctx.renamingId === null}
                onDragStart={(e) => fm.onNoteDragStart(e, id)}
                onDragEnd={fm.onDragEndCleanup}
                onDragOver={(e) => {
                  // Drop on a favorite row edge = place (add-or-reorder) at that
                  // slot. preventDefault stops the section's add-at-end handler.
                  if (fm.dragKind !== "note") return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  fm.updateFavReorderTarget(id, dragEdge(e));
                }}
                onDragLeave={() => fm.clearFavReorderTarget(id)}
                onDrop={(e) => {
                  if (fm.dragKind !== "note") return;
                  e.preventDefault();
                  void fm.reorderFavorite(id, dragEdge(e));
                }}
              >
                {favPlace && (
                  <div style={insertionLineStyle(favPlace)} aria-hidden="true" />
                )}
                {renderNoteRow(record, id, true)}
              </div>
            );
          })}
          <div style={FAV_DIVIDER_STYLE} aria-hidden="true" />
        </div>
      )}
      <div style={HEADER_ROW_STYLE}>
        <div style={HEADER_LEAD_STYLE}>
          <div style={SECTION_HEADING_STYLE}>Notes</div>
        </div>
        <div style={HEADER_ACTIONS_STYLE}>
          <IconButton
            icon="folder-plus"
            label="New folder"
            testId="notes.new-folder"
            onClick={() => fm.startNewFolder("")}
          />
          <IconButton
            icon="file-plus"
            label="New note (⌘N)"
            testId="notes.create"
            onClick={onCreate}
          />
          {onNewFromTemplate && (
            <IconButton
              icon="chevron-down"
              label="New note from template…"
              onClick={onNewFromTemplate}
            />
          )}
        </div>
      </div>
      {fm.newFolder !== null && (
        <NewFolderInput
          parentPath={fm.newFolder.parentPath}
          onCommit={fm.commitNewFolder}
          onCancel={fm.cancelNewFolder}
        />
      )}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          boxShadow: fm.rootDropActive
            ? "inset 0 0 0 2px var(--accent-soft)"
            : undefined,
        }}
        onDragOver={(e) => {
          // Empty root AREA drop = unfile (folder:null). A row that handled the
          // drag already called preventDefault, so skip when over a row.
          if (e.defaultPrevented) return;
          if (fm.dragKind !== "note") return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          fm.setRootDropActive(true);
        }}
        onDragLeave={() => fm.setRootDropActive(false)}
        onDrop={(e) => {
          if (e.defaultPrevented) return; // a row handled the drop
          if (fm.dragKind !== "note") return;
          e.preventDefault();
          void fm.onRootDrop();
        }}
      >
        <VirtualList
          items={rows}
          keyOf={(row) => row.key}
          estimatedRowHeight={showTimestamps ? 44 : 30}
          heightResetToken={showTimestamps}
          renderItem={(row) => {
            const anim = treeAnimRows.get(row.key);
            if (row.kind === "folder") {
              return (
                <DisclosureWrapper
                  anim={anim?.mode ?? null}
                  delay={anim?.delay ?? 0}
                >
                  <FolderRow
                    node={row.node}
                    depth={row.depth}
                    collapsed={row.collapsed}
                    empty={row.empty}
                    dropTarget={fm.dropTargetKey === row.node.key}
                    renaming={fm.renamingFolderKey === row.node.key}
                    dragKind={fm.dragKind}
                    reorderPlace={
                      fm.folderReorderTarget?.key === row.node.key
                        ? fm.folderReorderTarget.place
                        : null
                    }
                    onToggle={onToggleFolder}
                    onContextMenu={fm.openMenu}
                    colorSlot={fm.itemColors[row.node.path]}
                    iconName={fm.folderIcons[row.node.path]}
                    onDragTarget={fm.setDropTargetKey}
                    onDropNote={(folderPath) =>
                      void fm.onFolderDropNote(folderPath)
                    }
                    onDragStartFolder={fm.onFolderDragStart}
                    onFolderReorderOver={(node, place) =>
                      fm.updateFolderReorderTarget(node.key, place)
                    }
                    onFolderReorderLeave={fm.clearFolderReorderTarget}
                    onFolderReorderDrop={(node, place) =>
                      void fm.onFolderReorder(node, place)
                    }
                    onDragEnd={fm.onDragEndCleanup}
                    onCommitRename={(node, newName) =>
                      void fm.commitRenameFolder(node, newName)
                    }
                    onCancelRename={fm.cancelRenameFolder}
                  />
                </DisclosureWrapper>
              );
            }
            const record = ctx.cache.get(row.id);
            if (record === undefined) return null;
            const id = row.id;
            const reorderPlace =
              fm.reorderTarget?.id === id ? fm.reorderTarget.place : null;
            return (
              <DisclosureWrapper
                anim={anim?.mode ?? null}
                delay={anim?.delay ?? 0}
              >
                <div
                  style={{
                    position: "relative",
                    paddingLeft: row.depth * NOTE_INDENT_PER_LEVEL,
                  }}
                  draggable={ctx.renamingId === null}
                  onDragStart={(e) => fm.onNoteDragStart(e, id)}
                  onDragEnd={fm.onDragEndCleanup}
                  onDragOver={(e) => {
                    // Accept both kinds: a note reorders here; a folder reorders
                    // past this loose note (same-container). MYND-183 Task 6b.
                    if (fm.dragKind === null) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    fm.updateReorderTarget(id, dragEdge(e));
                  }}
                  onDragLeave={() => fm.clearReorderTarget(id)}
                  onDrop={(e) => {
                    if (fm.dragKind === null) return;
                    e.preventDefault();
                    void fm.onNoteReorder(id, dragEdge(e));
                  }}
                >
                  {reorderPlace && (
                    <div
                      style={insertionLineStyle(reorderPlace)}
                      aria-hidden="true"
                    />
                  )}
                  {renderNoteRow(record, id, favSet.has(id))}
                </div>
              </DisclosureWrapper>
            );
          }}
        />
      </div>
      {fm.blockNotice !== null && (
        <div
          style={BLOCK_NOTICE_STYLE}
          role="status"
          onClick={fm.dismissBlock}
        >
          {fm.blockNotice}
        </div>
      )}
      {fm.caseMerge !== null && (
        <div style={CASE_MERGE_STYLE} role="alertdialog">
          <div>
            A folder named “{fm.caseMerge.existingDisplay}” already exists.
            These will merge — rename one to keep them separate?
          </div>
          <div style={CASE_MERGE_ACTIONS_STYLE}>
            <button
              type="button"
              style={HEADER_BUTTON_STYLE}
              onClick={fm.cancelCaseMerge}
            >
              Rename
            </button>
            <button
              type="button"
              style={{ ...HEADER_BUTTON_STYLE, color: "var(--fg-1)" }}
              onClick={fm.confirmCaseMerge}
            >
              Merge anyway
            </button>
          </div>
        </div>
      )}
      {fm.confirmFolderDelete !== null && (
        <DeleteConfirmModal
          title="Delete this folder?"
          body={`“${fm.confirmFolderDelete.node.name}” and its ${fm.confirmFolderDelete.noteCount} note${
            fm.confirmFolderDelete.noteCount === 1 ? "" : "s"
          }`}
          warning="The notes move to Trash — you can restore them later."
          confirmLabel="Delete folder"
          onCancel={fm.cancelFolderDelete}
          onConfirm={fm.confirmFolderDeleteAction}
        />
      )}
      {menu !== null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={closeMenu}
        />
      )}
      {moveTarget !== null && (
        <ContextMenu
          x={moveTarget.x}
          y={moveTarget.y}
          items={moveMenuItems}
          onClose={() => setMoveTarget(null)}
        />
      )}
      {fm.menu !== null && (
        <ContextMenu
          x={fm.menu.x}
          y={fm.menu.y}
          items={folderMenuItems}
          onClose={fm.closeMenu}
        />
      )}
      {bgMenu !== null && (
        <ContextMenu
          x={bgMenu.x}
          y={bgMenu.y}
          items={bgMenuItems}
          onClose={closeBgMenu}
        />
      )}
      {decoPopover !== null && (
        <DecorationPopover
          x={decoPopover.x}
          y={decoPopover.y}
          color={fm.itemColors[decoPopover.key] ?? null}
          onSelectColor={(slot) => fm.setItemColor(decoPopover.key, slot)}
          icon={
            decoPopover.folderPath !== null
              ? {
                  value: fm.folderIcons[decoPopover.folderPath] ?? null,
                  onSelect: (name) =>
                    fm.setFolderIcon(decoPopover.folderPath as string, name),
                }
              : undefined
          }
          onClose={closeDecoPopover}
        />
      )}
      <Toast
        message={undoToast === null ? null : "Note moved to Trash"}
        onDone={() => setUndoToast(null)}
        durationMs={6000}
        action={{ label: "Undo", onAction: handleUndoTrash }}
      />
      <Toast
        message={
          bulkUndo === null
            ? null
            : `${bulkUndo.length} note${bulkUndo.length === 1 ? "" : "s"} moved to Trash`
        }
        onDone={() => setBulkUndo(null)}
        durationMs={6000}
        action={{ label: "Undo", onAction: handleUndoBulk }}
      />
      <Toast message={trashError} onDone={() => setTrashError(null)} />
    </div>
  );
}

/**
 * Sidebar footer nav entry that opens the attachments library (MYND-170,
 * SYNC-9). The library is a full-pane center-pane view, not a Stage; this
 * entry highlights when that view is active. `useCenterView` returns a
 * no-op fallback outside the Editor's provider, so this row is inert in any
 * isolated NoteList render (tests) rather than crashing.
 */
function AttachmentsNavEntry() {
  const { view, setView } = useCenterView();
  const active = view === "attachments";
  return (
    <button
      type="button"
      style={{
        ...FOOTER_ENTRY_STYLE,
        color: active ? "var(--fg-1)" : "var(--fg-2)",
        background: active ? "var(--paper-3)" : "transparent",
        fontWeight: active ? 600 : 400,
      }}
      onClick={() => setView("attachments")}
      title="Open attachments"
      aria-current={active ? "page" : undefined}
    >
      <Icon name="paperclip" size={15} />
      <span>Attachments</span>
    </button>
  );
}

/** Inline name input for creating a new folder (auto-focuses; Enter commits,
 *  Esc cancels, blur commits a non-empty name). */
function NewFolderInput({
  parentPath,
  onCommit,
  onCancel,
}: {
  parentPath: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const commit = () => {
    const v = ref.current?.value.trim() ?? "";
    if (v.length > 0) onCommit(v);
    else onCancel();
  };
  return (
    <div style={NEW_FOLDER_ROW_STYLE}>
      <input
        ref={ref}
        type="text"
        data-testid="notes.new-folder-input"
        placeholder={parentPath === "" ? "New folder" : `New folder in ${parentPath}`}
        style={NEW_FOLDER_INPUT_STYLE}
        onContextMenu={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={commit}
      />
    </div>
  );
}
