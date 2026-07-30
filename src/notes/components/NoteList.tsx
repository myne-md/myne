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
import { useTranslation } from "react-i18next";
import { SECTION_HEADING_STYLE } from "./sharedStyles";
import { noteRead } from "../readNote";
import {
  archivedRecords,
  liveCache,
  trashedCount,
  useSelectedNote,
  type NoteId,
  type UseSelectedNoteReturn,
} from "../sidebarState";
import {
  archivedFolderKeys,
  filterVisibleDeliberate,
  isNoteFolderArchived,
  topLevelArchivedFolders,
} from "../archivedFolders";
import { ArchivePanel } from "./ArchivePanel";
import { TrashPanel } from "./TrashPanel";
import { sidebarCommands } from "../sidebarCommands";
import { DeleteConfirmModal } from "./DeleteConfirmModal";
import { deriveFolderTree, type FolderNode } from "../folderTree";
import {
  ancestorPaths,
  foldSegment,
  folderKey,
  normalizeFolderPath,
} from "../../dialect/folderPath";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import {
  noteExportOptions,
  runNoteExportFlow,
  runNoteHtmlExportFlow,
  runNotePdfExportFlow,
  runNoteTxtExportFlow,
  type NoteExportUiHooks,
} from "../exportFlow";
import { has as hasCapability } from "../../platform/capabilities";
import { DecorationPopover } from "./DecorationPopover";
import { Toast } from "../../components/Toast";
import { FolderRow } from "./FolderRow";
import { NoteRow } from "./NoteRow";
import { TreeRails } from "./TreeRails";
import { importDroppedMarkdown } from "../dropImport";
import { BASE_PADDING_LEFT as TREE_BASE_PADDING_LEFT } from "./FolderRow";
import {
  createFolderNote,
  setFolderIndex,
  unsetFolderIndex,
} from "../folderNote";
import type { TitleRecord } from "../loadNoteBatch";
import { VirtualList } from "./VirtualList";
import { useWorkspace } from "../workspaceContext";
import { IconButton } from "../../components/primitives/IconButton";
import { ViewsSection } from "./ViewsSection";
import { FilterBuilder, type FolderOption } from "./FilterBuilder";
import { ViewSettings, type ViewDisplayPatch } from "./ViewSettings";
import { vaultIndicesPropertyKeys } from "../vaultIndices";
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
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useUnsyncedEdits } from "../../hooks/useUnsyncedEdits";

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
    // A modal dialog (e.g. the keyboard-delete confirm gate) owns the keyboard
    // while open — don't start an inline rename underneath it. `typeof document`
    // keeps the handler node-testable (triggerHandlers.test.ts has no DOM).
    if (typeof document !== "undefined" && document.querySelector('[role="alertdialog"]') !== null) {
      return;
    }
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
    // A modal dialog (role="alertdialog", e.g. the keyboard-delete confirm gate)
    // owns the keyboard while open: its own Enter/Escape handlers must win, and
    // background list nav (arrows / Enter-open) must not run underneath it.
    // Without this bail-out the nav handler's `case "Enter"` preventDefault()s
    // the event and opens the selected note, swallowing the modal's confirm-on-
    // Enter (Escape was unaffected because nav ignores it) — the MYND-487 E2E
    // regression. `typeof document` keeps the factory node-testable.
    if (typeof document !== "undefined" && document.querySelector('[role="alertdialog"]') !== null) {
      return;
    }
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
/**
 * Total time the cascade is allowed to span, independent of row count
 * (MYND-622).
 *
 * The stagger used to be a fixed 18ms per row, clamped at the 8th. That reads
 * fine for a small folder and badly for a populated one: the first eight rows
 * tick down in sequence and then every remaining row arrives at once, so a long
 * nested folder opens as a short cascade followed by a wall. Spreading a FIXED
 * budget across however many rows there are keeps the motion continuous at any
 * size — a handful of rows stay near-simultaneous and snappy, a hundred rows
 * flow evenly instead of slamming.
 */
const TREE_ANIM_STAGGER_SPAN_MS = 144;
const TREE_ANIM_TOTAL_MS = TREE_ANIM_BASE_MS + TREE_ANIM_STAGGER_SPAN_MS + 60;

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
  const { t } = useTranslation();
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
  // The vault's frontmatter property-key universe — the option set for the view
  // settings' group / sort / column pickers + cover-image suggestions. Loaded
  // from the `vault_indices_property_keys` accessor when the modal opens (fresh
  // each open, so the pickers reflect the current index).
  const [viewPropertyKeys, setViewPropertyKeys] = useState<string[]>([]);
  useEffect(() => {
    if (viewSettings === null) return;
    let cancelled = false;
    void vaultIndicesPropertyKeys()
      .then((keys) => {
        if (!cancelled) setViewPropertyKeys(keys);
      })
      .catch(() => {
        /* index hiccup → empty pickers; the free-text cover field still works */
      });
    return () => {
      cancelled = true;
    };
  }, [viewSettings]);

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

  // Expansion state — the folded keys of folders the user has OPENED. Default
  // empty = every folder collapsed; a folder that first appears is absent here,
  // so it comes in closed (a fresh vault, a newly-created folder, and an Obsidian
  // import all open collapsed rather than sprawling). PERSISTED across restart
  // (MYND-455): the set is carried at the container level of the workspace blob
  // (MYW1, §9.7 — window-global session/view state, AS3, already inside the AEAD
  // envelope). The container is the SINGLE owner — the sidebar renders straight
  // off it rather than mirroring it into local state. That is what makes the two
  // invariants structural rather than bookkeeping: the async restore simply
  // replaces the value (nothing to "hydrate"), and there is no initial empty
  // local set that could clobber the persisted one before restore lands.
  const expanded = useMemo<ReadonlySet<string>>(
    () => new Set(ws.expandedFolders),
    [ws.expandedFolders],
  );
  const setExpanded = ws.setExpandedFolders;
  // Mirror the latest committed value so `toggleFolder` can read it
  // synchronously (decide expand-vs-collapse) without a stale closure.
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
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
    // `expanded` holds opened folders — a key present means open. Toggling an
    // open folder collapses it (delete the key); a closed one expands (add it).
    const collapsing = expandedRef.current.has(key);
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
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(stuck);
        return next;
      });
    }
    pendingCollapse.current = null;
    // Reduced motion (or any non-animated path): flip immediately.
    if (reduce) {
      setTreeAnim(null);
      setExpanded((prev) => {
        const next = new Set(prev);
        if (collapsing) next.delete(key);
        else next.add(key);
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
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
        setTreeAnim((a) => (a?.nonce === nonce ? null : a));
        treeAnimTimer.current = null;
      }, TREE_ANIM_TOTAL_MS);
    } else {
      // Expand now — the descendant rows mount and play `myne-tree-row-in`.
      setExpanded((prev) => {
        const next = new Set(prev);
        next.add(key);
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
  // Folder-archived subtrees (archived_folders) leave the working set as a UNIT
  // — folded keys computed once, threaded into `liveCache` (excludes their
  // notes) and the deliberate filter (drops archived empty folders so they
  // don't re-surface as empty nodes). resolverCache is untouched (folder-
  // archived notes stay backlink/graph/search targets — folder-archive).
  const archivedKeys = useMemo(
    () => archivedFolderKeys(fm.archivedFolders),
    [fm.archivedFolders],
  );
  const live = useMemo(
    () => liveCache(ctx.cache, archivedKeys),
    [ctx.cache, archivedKeys],
  );
  const tree = useMemo(
    () =>
      deriveFolderTree(
        Array.from(live.values()).map((r) => ({
          noteUuid: r.noteUuid,
          folder: r.folder,
          folderIndex: r.folderIndex,
        })),
        filterVisibleDeliberate(fm.deliberate, archivedKeys),
      ),
    [live, fm.deliberate, archivedKeys],
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
  // Folders are closed unless opened. The flatten pass consumes a `collapsed`
  // set, so derive it as every folder key NOT in `expanded` — keeping the pure
  // `flattenVisibleRows` contract while making "closed" the default. A key that
  // lingers in `expanded` for a folder that has since vanished is harmless (it
  // matches no node); we never prune, so a folder that briefly drops out of the
  // tree during async note loading keeps its opened state.
  const collapsed = useMemo(() => {
    const out = new Set<string>();
    const walk = (nodes: readonly FolderNode[]): void => {
      for (const n of nodes) {
        if (!expanded.has(n.key)) out.add(n.key);
        walk(n.children);
      }
    };
    walk(tree.roots);
    return out;
  }, [tree, expanded]);
  // Open a folder (and its ancestors) so a child created inside it — a new note
  // or a new subfolder — is visible under the default-collapsed tree. Root
  // ("" / null) has no ancestor to open.
  const revealFolder = useCallback((path: string) => {
    const norm = normalizeFolderPath(path);
    if (norm === null) return;
    const keys = ancestorPaths(norm).map(foldSegment);
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const k of keys) next.add(k);
      return next;
    });
  }, []);
  // A note entering inline-rename must be VISIBLE — but under the default-
  // collapsed tree its folder may be shut. The context-menu "new note here"
  // reveals synchronously; this catches the rest: the root-level create entry
  // points (Cmd+N, palette, top-bar, new tab) resolve their target folder from
  // prefs ("current"/"specific" note location) and settle it into the cache a
  // beat AFTER `renamingId` is set, plus a plain rename of an existing filed
  // note. Reveal once per rename session (keyed by the note id) so a manual
  // collapse mid-rename is not fought; the `folder === null` (root) case reveals
  // nothing and needs nothing.
  const revealedRenameId = useRef<NoteId | null>(null);
  useEffect(() => {
    const id = ctx.renamingId;
    if (id === null) {
      revealedRenameId.current = null;
      return;
    }
    if (revealedRenameId.current === id) return;
    const folder = ctx.cache.get(id)?.folder ?? null;
    if (folder !== null) {
      revealFolder(folder);
      revealedRenameId.current = id;
    }
  }, [ctx.renamingId, ctx.cache, revealFolder]);
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
    // Count the affected rows first so the stagger can be spread across them
    // rather than clamped after the eighth (see TREE_ANIM_STAGGER_SPAN_MS).
    let end = anchor + 1;
    while (end < rows.length && rows[end]!.depth > folderDepth) end++;
    const count = end - (anchor + 1);
    // One row needs no cascade; `count - 1` divisions put the last row exactly
    // at the end of the budget.
    const step = count > 1 ? TREE_ANIM_STAGGER_SPAN_MS / (count - 1) : 0;
    for (let r = anchor + 1; r < end; r++) {
      const delay = Math.round((r - anchor - 1) * step);
      map.set(rows[r]!.key, { mode: treeAnim.mode, delay });
    }
    return map;
  }, [treeAnim, rows]);
  // Folder-index lookup (MYND-370): note-id → its role in its folder. The
  // authoritative winner (`indexNoteId`, pinned by `deriveFolderTree`) reads
  // "index"; every claimant that lost the tiebreak (`indexConflictIds`) reads
  // "conflict". Threaded into every NoteRow so the badge / conflict indicator
  // come from the FolderNode, not the per-note `folderIndex` flag alone (which
  // can't tell the winner from a loser).
  const folderIndexRoles = useMemo(() => {
    const map = new Map<NoteId, "index" | "conflict">();
    const walk = (nodes: readonly FolderNode[]): void => {
      for (const n of nodes) {
        if (n.indexNoteId !== null) map.set(n.indexNoteId, "index");
        for (const id of n.indexConflictIds) map.set(id, "conflict");
        walk(n.children);
      }
    };
    walk(tree.roots);
    return map;
  }, [tree]);
  // Folder-key → its index note id (MYND-370). Drives the single-folder-note
  // guard: the per-note "Set as folder note" action is offered only when the
  // note's folder has NO index yet, so a second one can never be designated.
  const folderIndexByKey = useMemo(() => {
    const map = new Map<string, NoteId>();
    const walk = (nodes: readonly FolderNode[]): void => {
      for (const n of nodes) {
        if (n.indexNoteId !== null) map.set(n.key, n.indexNoteId);
        walk(n.children);
      }
    };
    walk(tree.roots);
    return map;
  }, [tree]);
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
  // Archive entry (MYND-331): sibling to Trash in the footer, opening the
  // Archive panel. Count from the value-strict `archived:` set (the disjoint
  // archive raft); memoized on cache identity like `trashCount`.
  const [archiveOpen, setArchiveOpen] = useState(false);
  // Palette-gap Wave 4: register the sidebar-owned surfaces so the command
  // palette (a separate subtree) can open them. Cleared on unmount so a
  // non-editor stage's actions no-op.
  useEffect(() => {
    sidebarCommands.openTrash = () => setTrashOpen(true);
    sidebarCommands.openArchive = () => setArchiveOpen(true);
    sidebarCommands.newFolder = () => fm.startNewFolder("");
    return () => {
      sidebarCommands.openTrash = undefined;
      sidebarCommands.openArchive = undefined;
      sidebarCommands.newFolder = undefined;
    };
  }, [fm]);
  // Footer badge = standalone archived notes (value-strict `archived:`, NOT
  // also inside an archived folder — those show under the folder row) + the
  // top-level archived folder rows (folder-archive; each counts as one row).
  const archiveCount = useMemo(() => {
    const standalone = archivedRecords(ctx.cache).filter(
      (r) => !isNoteFolderArchived(r.folder, archivedKeys),
    ).length;
    return standalone + topLevelArchivedFolders(fm.archivedFolders).length;
  }, [ctx.cache, archivedKeys, fm.archivedFolders]);
  // Archive-feature disable toggle (archive-disable, MYND-…): when on, the
  // archive entry points (footer button, context-menu actions) are hidden. The
  // viewer footer stays available while any archived note still exists so a note
  // can never be stranded — but disabling auto-empties the archive, so in the
  // normal flow `archiveCount` is already 0. `viewsPrefs` is nonce-aware, so the
  // toggle re-renders these surfaces live.
  const archiveDisabled = viewsPrefs.archive_disabled ?? false;

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
          folderIndexRoles={folderIndexRoles}
          folderIndexByKey={folderIndexByKey}
          onToggleFolder={toggleFolder}
          onRevealFolder={revealFolder}
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
      {viewSettings !== null && (
        <ViewSettings
          title={
            viewSettings.name.trim() === ""
              ? t("notes.list.viewSettingsTitle")
              : viewSettings.name
          }
          initial={{
            view_type: viewSettings.view_type,
            group_by: viewSettings.group_by,
            sort: viewSettings.sort,
            columns: viewSettings.columns,
            image: viewSettings.image,
            image_aspect_ratio: viewSettings.image_aspect_ratio,
            card_size: viewSettings.card_size,
          }}
          propertyKeys={viewPropertyKeys}
          onCancel={() => setViewSettings(null)}
          onSave={handleSaveViewSettings}
        />
      )}
      {builder !== null && (
        <FilterBuilder
          title={
            builder.mode === "edit"
              ? t("notes.list.editFilterTitle")
              : t("notes.list.newViewTitle")
          }
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
          title={t("notes.list.openTrash")}
        >
          <Icon name="trash-2" size={15} />
          <span>{t("notes.list.trash")}</span>
          {trashCount > 0 && (
            <span style={TRASH_COUNT_BADGE_STYLE}>{trashCount}</span>
          )}
        </button>
        {(!archiveDisabled || archiveCount > 0) && (
          <button
            type="button"
            style={FOOTER_ENTRY_STYLE}
            data-testid="notes.archive-open"
            onClick={() => setArchiveOpen(true)}
            title={t("notes.list.openArchive")}
          >
            <Icon name="archive" size={15} />
            <span>{t("notes.list.archive")}</span>
            {archiveCount > 0 && (
              <span style={TRASH_COUNT_BADGE_STYLE}>{archiveCount}</span>
            )}
          </button>
        )}
      </div>
      <TrashPanel open={trashOpen} onClose={() => setTrashOpen(false)} />
      <ArchivePanel
        open={archiveOpen}
        onClose={() => setArchiveOpen(false)}
        archivedFolders={fm.archivedFolders}
        onRestoreFolder={fm.restoreFolder}
        onDeleteFolderToTrash={fm.deleteArchivedFolderToTrash}
      />
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
  const { t } = useTranslation();
  return (
    <div style={LIST_OUTER_STYLE}>
      <div style={HEADER_ROW_STYLE}>
        <div style={HEADER_LEAD_STYLE}>
          <div style={SECTION_HEADING_STYLE}>{t("notes.list.notesHeading")}</div>
        </div>
        <div style={HEADER_ACTIONS_STYLE}>
          <IconButton
            icon="folder-plus"
            label={t("notes.list.newFolder")}
            testId="notes.new-folder"
            onClick={() => fm.startNewFolder("")}
          />
          <IconButton
            icon="file-plus"
            label={t("notes.list.newNote")}
            testId="notes.create"
            onClick={onCreate}
          />
          {onNewFromTemplate && (
            <IconButton
              icon="chevron-down"
              label={t("notes.list.newNoteFromTemplate")}
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
        <div style={EMPTY_COPY_STYLE}>{t("notes.list.emptyState")}</div>
        <button type="button" onClick={onCreate} style={EMPTY_CTA_STYLE}>
          {t("notes.list.createFirstNote")}
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
  railDepth = 0,
  children,
}: {
  anim: "in" | "out" | null;
  delay: number;
  /**
   * Ancestor depth whose indent rails belong to this row (MYND-622).
   *
   * The rails are drawn HERE, on the wrapper's outer box, rather than inside the
   * row. Each rail overhangs its row by `ROW_GAP` px so it meets the next row's
   * rail and the tree reads as one continuous line down a sibling group — but
   * the inner box clips to `overflow: hidden` while a disclosure animates, which
   * cut exactly that overhang off. Every expand/collapse therefore shredded the
   * tree lines into per-row dashes, worst on a deep tree where the most rails
   * are in flight at once. The outer box never clips, so the rails survive.
   *
   * `0` renders nothing (root rows have no ancestors).
   */
  railDepth?: number;
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
        // Anchors the indent rails below, which must sit outside the clipped
        // inner box (see `railDepth`).
        position: "relative",
        gridTemplateRows: open ? "1fr" : "0fr",
        // Bound the single column to the container (min 0 = shrinkable below the
        // row's content, max 1fr = fill). Without this the implicit `auto` column
        // grows to a long note title's max-content, so the row (and its hover /
        // active pill) overflowed the sidebar under the editor. With it, the row
        // is constrained and the title ellipsizes.
        gridTemplateColumns: "minmax(0, 1fr)",
        minWidth: 0,
        opacity: open ? 1 : 0,
        transition: animating
          ? `grid-template-rows var(--duration-base) ${easing} ${delay}ms, opacity var(--duration-base) ${easing} ${delay}ms`
          : undefined,
        willChange: animating ? "grid-template-rows, opacity" : undefined,
      }}
    >
      <TreeRails depth={railDepth} />
      <div style={{ minHeight: 0, minWidth: 0, overflow: animating ? "hidden" : "visible" }}>
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
  folderIndexRoles,
  folderIndexByKey,
  onToggleFolder,
  onRevealFolder,
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
  /** Note-id → folder-index role (MYND-370): "index" = the folder's index note,
   *  "conflict" = a claimant that lost the tiebreak. Drives the NoteRow badge +
   *  conflict indicator. Computed in the parent off the derived tree. */
  folderIndexRoles: ReadonlyMap<NoteId, "index" | "conflict">;
  /** Folder-key → its index note id (MYND-370). Drives the single-folder-note
   *  guard: the per-note "Set as folder note" action is offered only when the
   *  note's folder is absent from this map. Computed in the parent off the tree. */
  folderIndexByKey: ReadonlyMap<string, NoteId>;
  /** Per-row folder disclosure-animation descriptors, keyed by VirtualList row
   *  key (empty when no expand/collapse is animating). Computed in the parent so
   *  it shares `treeAnim` state with the toggle handler; each entry's `mode` +
   *  `delay` drive that row's `DisclosureWrapper`. */
  treeAnimRows: ReadonlyMap<string, { mode: "in" | "out"; delay: number }>;
  onToggleFolder: (key: string) => void;
  /** Open a folder + its ancestors so a child created inside it (new note or
   *  subfolder) is visible under the default-collapsed tree. Owned by the parent
   *  (mutates the shared expansion state alongside `onToggleFolder`). */
  onRevealFolder: (path: string) => void;
  onCreate: () => void;
  fm: FolderManagement;
  onNewFromTemplate?: () => void;
  exportHooks?: NoteExportUiHooks;
  /** Sidebar per-note timestamp visibility (sidebar-note-timestamps), read from
   *  `PrefsView.show_note_timestamps` in the parent. Threaded into every
   *  `<NoteRow>` (tree + Favorites) via `renderNoteRow`. */
  showTimestamps: boolean;
}) {
  const { t } = useTranslation();
  const ctx = useSelectedNote();
  // Trap + restore focus while the case-merge confirm dialog is open (MYND-93).
  const caseMergeDialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(caseMergeDialogRef, { enabled: fm.caseMerge !== null });
  // Archive-feature disable toggle (archive-disable, MYND-…): hides the archive
  // context-menu actions when on. `usePrefs` is nonce-aware, so flipping the
  // Settings toggle re-renders the menu live. (Read here rather than threaded as
  // a prop — same independent-`usePrefs` pattern as the parent sidebar list.)
  const { prefs: rowPrefs } = usePrefs();
  const archiveDisabled = rowPrefs.archive_disabled ?? false;
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
  // The move picker acts on an EXPLICIT id set carried on the target (MYND-622).
  // It used to read the multi-selection at commit time, which was fine while
  // "Move to…" existed only in the bulk menu; the single-note entry needs to move
  // the row that was right-clicked, which is not necessarily selected at all.
  const [moveTarget, setMoveTarget] = useState<{
    x: number;
    y: number;
    ids: NoteId[];
  } | null>(
    null,
  );
  // Undo target for a bulk trash (MYND-367) — the ids just moved to Trash, so
  // "Undo" can restore the whole set (parity with the single-note undo toast).
  const [bulkUndo, setBulkUndo] = useState<readonly NoteId[] | null>(null);
  // Undo-toast target: the id of the note just moved to the trash. "Undo"
  // restores it (MYND-133). Replaced when another note is trashed.
  const [undoToast, setUndoToast] = useState<NoteId | null>(null);
  // Summary of the last drag-drop markdown import (MYND-629).
  const [importToast, setImportToast] = useState<string | null>(null);

  /**
   * Import markdown files dropped onto a folder row. Reports a count rather
   * than per-file detail: a drop of twenty should not produce twenty toasts,
   * and the skip reasons are coarse by design (an underlying error can carry a
   * filesystem path, which must not reach the UI).
   */
  const handleDropFiles = useCallback(
    async (folderPath: string, files: File[]) => {
      if (!files.some((f) => /\.(md|markdown|mdown|txt)$/i.test(f.name))) {
        setImportToast(t("notes.list.importNoMarkdown"));
        return;
      }
      const result = await importDroppedMarkdown(files, folderPath);
      // Same create-then-refresh discipline the folder-note path uses: pull the
      // real slice for each new id rather than assuming the list will notice.
      for (const id of result.created) await ctx.refreshOne(id);
      setImportToast(
        result.skipped.length === 0
          ? t("notes.list.imported", { count: result.created.length })
          : t("notes.list.importedWithSkips", {
              count: result.created.length,
              skipped: result.skipped.length,
            }),
      );
    },
    [ctx, t],
  );
  // Non-blocking error toast shown when a trash IPC fails after rollback.
  const [trashError, setTrashError] = useState<string | null>(null);
  // Confirmation gate for the keyboard Delete/Backspace path (MYND-487). An
  // accidental keypress must not silently soft-trash the selection, so the
  // keydown handler stages the victim(s) here and a DeleteConfirmModal
  // confirms before `handleTrash` / `handleBulkDelete` runs. Context-menu
  // Delete keeps its immediate + undo-toast behaviour (a deliberate click).
  const [confirmKeyboardDelete, setConfirmKeyboardDelete] = useState<
    | { kind: "single"; id: NoteId }
    | { kind: "bulk"; ids: readonly NoteId[] }
    | null
  >(null);
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

  // Per-note "not yet on the server" (phase3-web-client task 23). Read here
  // rather than inside `<NoteRow>` so one poll serves the whole list — a hook
  // per row would issue one IPC call per visible note on every tick.
  const { unsyncedIds } = useUnsyncedEdits();

  // Shared <NoteRow> renderer — the Favorites section and the tree render an
  // identical NoteRow (only the `favorited` flag + the surrounding drag wrapper
  // differ). Keeping the prop wiring in one place stops the two sites drifting.
  const renderNoteRow = useCallback(
    (record: TitleRecord, id: NoteId, favorited: boolean) => {
      const role = folderIndexRoles.get(id);
      return (
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
          isIndexNote={role === "index"}
          indexConflict={role === "conflict"}
          unsynced={unsyncedIds.has(id)}
          showTaskMarker={rowPrefs.show_task_marker}
        />
      );
    },
    [
      ctx,
      activateRow,
      handleContextMenu,
      fm.toggleFavorite,
      noteHighlightActive,
      fm.itemColors,
      showTimestamps,
      folderIndexRoles,
      unsyncedIds,
      rowPrefs.show_task_marker,
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
        setTrashError(t("notes.list.trashSingleError"));
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn("[NoteList] trashWithRollback failed:", err);
        }
      }
    },
    [ctx, navIds, t],
  );

  // Archive a single note (MYND-331): optimistically pull it from the live tree
  // (archiveWithRollback sets `archived:` + clears any `trashed:`), move the
  // editor to an adjacent row if the archived note was open. Mirrors
  // `handleTrash` minus the undo toast — the note is recoverable from the
  // Archive section, not a transient undo.
  const handleArchive = useCallback(
    async (id: NoteId) => {
      const wasSelected = ctx.selectedId === id;
      const adjacent = wasSelected ? pickAdjacentAfterDelete(navIds, id) : null;
      setMenu(null);
      try {
        await ctx.archiveWithRollback(id);
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
        setTrashError(t("notes.list.archiveSingleError"));
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn("[NoteList] archiveWithRollback failed:", err);
        }
      }
    },
    [ctx, navIds, t],
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

  // ---- folder notes (MYND-370) -------------------------------------------
  // Create a new index note for `folderPath`, settle it into the cache (so the
  // new row + its badge appear), then open it in the focused pane. Mirrors the
  // `newNoteHere` create-then-refresh discipline; `createFolderNote` mints the
  // note via the same `note_create` IPC, so `refreshOne` pulls the real slice.
  const handleCreateFolderNote = useCallback(
    async (folderPath: string) => {
      try {
        const newId = await createFolderNote(folderPath);
        await ctx.refreshOne(newId);
        openNote(newId);
      } catch (err) {
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn("[NoteList] createFolderNote failed:", err);
        }
      }
    },
    [ctx, openNote],
  );

  // Open a folder's existing index note — the same open path a note-row click
  // uses (reuse the focused pane).
  const handleOpenIndexNote = useCallback(
    (noteId: NoteId) => openNote(noteId),
    [openNote],
  );

  // Double-click a folder row: open its folder note, or create one if it has
  // none (MYND-370). The single creation path — gated on `indexNoteId === null`
  // here and in the affordance/menu — is what keeps it to exactly one per folder.
  const handleFolderActivate = useCallback(
    (node: FolderNode) => {
      if (node.indexNoteId !== null) handleOpenIndexNote(node.indexNoteId);
      else void handleCreateFolderNote(node.path);
    },
    [handleOpenIndexNote, handleCreateFolderNote],
  );

  // Designate / undesignate a note as its folder's index, then refresh its
  // record so the derived tree + badge update. The flag flip writes through the
  // dedicated `folderNote` orchestrators (no `updated:` bump); `refreshOne`
  // re-reads the slice so `folderIndex` settles into the cache.
  const handleSetIndex = useCallback(
    async (id: NoteId) => {
      setMenu(null);
      try {
        await setFolderIndex(id);
        await ctx.refreshOne(id);
      } catch (err) {
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn("[NoteList] setFolderIndex failed:", err);
        }
      }
    },
    [ctx],
  );
  const handleUnsetIndex = useCallback(
    async (id: NoteId) => {
      setMenu(null);
      try {
        await unsetFolderIndex(id);
        await ctx.refreshOne(id);
      } catch (err) {
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn("[NoteList] unsetFolderIndex failed:", err);
        }
      }
    },
    [ctx],
  );

  // Bulk move (MYND-367): move the whole multi-selection to `folder` (or root)
  // best-effort, then collapse the set. Reads `selectedIds` at call time (not
  // inside the async closure) so a concurrent clear can't shrink the payload.
  const runBulkMove = useCallback(
    async (folder: string | null, explicitIds?: readonly NoteId[]) => {
      const ids = explicitIds !== undefined ? [...explicitIds] : [...ctx.selectedIds];
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
      setTrashError(t("notes.list.trashBulkError"));
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn("[NoteList] bulkTrashWithSync failed:", err);
      }
    }
    ctx.clearMultiSelection();
  }, [ctx, navIds, t]);

  // Bulk archive (MYND-331 / MYND-367): archive the whole multi-selection
  // (recoverable from the Archive section), then collapse the set. If the OPEN
  // note is among them, move the editor to the first surviving nav row.
  const handleBulkArchive = useCallback(async () => {
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
      await ctx.bulkArchiveWithSync(ids);
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
      setTrashError(t("notes.list.archiveBulkError"));
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn("[NoteList] bulkArchiveWithSync failed:", err);
      }
    }
    ctx.clearMultiSelection();
  }, [ctx, navIds, t]);

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
        label: t("notes.list.vaultRoot"),
        onSelect: () => void runBulkMove(null, moveTarget?.ids),
      },
      ...folderOptions.map((o) => ({
        id: o.path,
        label: o.label,
        onSelect: () => void runBulkMove(o.path, moveTarget?.ids),
      })),
    ],
    [folderOptions, runBulkMove, moveTarget, t],
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
          group: "organize",
          label: t("notes.list.bulkMove", { count: selCount }),
          onSelect: () =>
            setMoveTarget({ x: menu.x, y: menu.y, ids: [...ctx.selectedIds] }),
        },
        // Archiving disabled → no "archive these" entry (the feature is hidden).
        ...(archiveDisabled
          ? []
          : [
              {
                id: "bulk-archive",
                group: "danger",
                label: t("notes.list.bulkArchive", { count: selCount }),
                onSelect: () => void handleBulkArchive(),
              },
            ]),
        {
          id: "bulk-delete",
          group: "danger",
          label: t("notes.list.bulkDelete", { count: selCount }),
          destructive: true,
          onSelect: () => void handleBulkDelete(),
        },
      ];
    }
    return [
      {
        id: "open-in-new-tab",
        group: "open",
        label: t("notes.list.openInNewTab"),
        onSelect: () => openNote(menu.id, { newTab: true }),
      },
      {
        id: "open-to-side",
        group: "open",
        label: t("notes.list.openToSide"),
        onSelect: () => openNote(menu.id, { toSide: true }),
      },
      {
        // MYND-622: desktop parity with mobile's folder context menu (MYND-480),
        // which has had "Move to folder" since it shipped. Dragging was the only
        // way to move a single note here, which is unreachable when the target
        // folder is collapsed or off-screen.
        id: "move",
        group: "organize",
        label: t("notes.list.moveTo"),
        onSelect: () => setMoveTarget({ x: menu.x, y: menu.y, ids: [menu.id] }),
      },
      {
        id: "rename",
        group: "edit",
        label: t("notes.list.rename"),
        onSelect: () => ctx.startRename(menu.id),
      },
      {
        // Clone the note in place (MYND-332) — new id + "(kopya)" title;
        // the copy opens in the focused pane.
        id: "duplicate",
        group: "edit",
        label: t("notes.list.duplicate"),
        onSelect: () => void ctx.duplicateAndOpen(menu.id),
      },
      {
        id: "favorite",
        group: "edit",
        label: favSet.has(menu.id)
          ? t("notes.list.removeFromFavorites")
          : t("notes.list.addToFavorites"),
        onSelect: () => fm.toggleFavorite(menu.id),
      },
      // Folder note (MYND-370): promote this note to its folder's index note —
      // offered ONLY for an in-folder note whose folder has NO index note yet, so
      // a second one can never be designated (exactly one per folder). The "Remove
      // as folder note" inverse is NOT here: the index note is hidden from the tree
      // (its row is unreachable), so undesignate lives on the FOLDER menu instead.
      ...(() => {
        const rec = ctx.cache.get(menu.id);
        if (rec?.folder == null) return [];
        if (folderIndexByKey.get(folderKey(rec.folder)) != null) return [];
        return [
          {
            id: "note.set-index",
            group: "edit",
            label: t("notes.list.setAsFolderNote"),
            onSelect: () => void handleSetIndex(menu.id),
          },
        ];
      })(),
      {
        id: "color",
        group: "edit",
        label: t("notes.list.color"),
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
        group: "export",
        label: t("notes.list.exportMarkdown"),
        onSelect: () =>
          void runNoteExportFlow(
            noteExportOptions(
              menu.id,
              ctx.cache.get(menu.id)?.title ?? null,
              exportHooks,
            ),
          ),
      },
      // The PDF item is OMITTED where `pdfExport` is absent (task 48), matching
      // the palette, which drops the same action through `ACTION_CAPABILITY`.
      // Two render sites, one answer — a menu that offered it while the palette
      // did not would be the "unreachable by menu, still reachable elsewhere"
      // gap task 27 exists to close, pointing the other way.
      ...(hasCapability("pdfExport")
        ? [
      {
        // Sibling PDF egress (MYND-255) — same export group, same shared-
        // flow discipline (runNotePdfExportFlow is the palette's flow too).
        id: "export-pdf",
        group: "export",
        label: t("notes.list.exportPdf"),
        onSelect: () =>
          void runNotePdfExportFlow(
            noteExportOptions(
              menu.id,
              ctx.cache.get(menu.id)?.title ?? null,
              exportHooks,
            ),
          ),
      },
          ]
        : []),
      {
        // Sibling HTML egress (MYND-340) — same export group, same shared-
        // flow discipline (runNoteHtmlExportFlow is the palette's flow too).
        id: "export-html",
        group: "export",
        label: t("notes.list.exportHtml"),
        onSelect: () =>
          void runNoteHtmlExportFlow(
            noteExportOptions(
              menu.id,
              ctx.cache.get(menu.id)?.title ?? null,
              exportHooks,
            ),
          ),
      },
      {
        // Sibling plain-text egress (MYND-340).
        id: "export-txt",
        group: "export",
        label: t("notes.list.exportTxt"),
        onSelect: () =>
          void runNoteTxtExportFlow(
            noteExportOptions(
              menu.id,
              ctx.cache.get(menu.id)?.title ?? null,
              exportHooks,
            ),
          ),
      },
      // Archive (MYND-331): pull the note out of the working set into the
      // indefinite-retention Archive section. Near Delete, but not destructive.
      // Hidden entirely when archiving is disabled (archive-disable, MYND-…).
      ...(archiveDisabled
        ? []
        : [
            {
              id: "archive",
              group: "danger",
              label: t("notes.list.archiveNote"),
              onSelect: () => void handleArchive(menu.id),
            },
          ]),
      {
        id: "delete",
        group: "danger",
        label: t("notes.list.delete"),
        destructive: true,
        onSelect: () => void handleTrash(menu.id),
      },
    ];
  }, [
    menu,
    ctx,
    handleTrash,
    handleArchive,
    handleBulkDelete,
    handleBulkArchive,
    archiveDisabled,
    fm,
    favSet,
    openNote,
    exportHooks,
    folderIndexByKey,
    handleSetIndex,
    t,
  ]);

  // Folder context-menu items (right-click a folder row).
  const folderMenuItems: ContextMenuItem[] = useMemo(() => {
    const menuPos = fm.menu;
    const node = menuPos?.node;
    if (node === undefined || menuPos === null) return [];
    return [
      {
        id: "rename",
        label: t("notes.list.rename"),
        onSelect: () => fm.startRenameFolder(node),
      },
      {
        id: "new-note",
        label: t("notes.list.newNoteHere"),
        onSelect: () => {
          onRevealFolder(node.path);
          fm.newNoteHere(node.path);
        },
      },
      {
        id: "new-drawing",
        label: t("notes.list.newDrawingHere"),
        onSelect: () => {
          onRevealFolder(node.path);
          fm.newDrawingHere(node.path);
        },
      },
      // Folder note (MYND-370): open the existing index, or create one.
      node.indexNoteId !== null
        ? {
            id: "folder.open-index",
            label: t("notes.list.openFolderNote"),
            onSelect: () => handleOpenIndexNote(node.indexNoteId as string),
          }
        : {
            id: "folder.create-index",
            label: t("notes.list.createFolderNote"),
            onSelect: () => void handleCreateFolderNote(node.path),
          },
      // Undesignate the folder note (MYND-370): the only reachable "remove" path
      // now that the index note is hidden from the tree. Non-destructive — the
      // note returns to an ordinary, visible note (re-appears as a row).
      ...(node.indexNoteId !== null
        ? [
            {
              id: "folder.remove-index",
              label: t("notes.list.removeFolderNote"),
              onSelect: () => void handleUnsetIndex(node.indexNoteId as string),
            },
          ]
        : []),
      {
        id: "new-subfolder",
        label: t("notes.list.newSubfolder"),
        onSelect: () => {
          onRevealFolder(node.path);
          fm.startNewFolder(node.path);
        },
      },
      {
        id: "color",
        label: t("notes.list.customize"),
        onSelect: () =>
          setDecoPopover({
            x: menuPos.x,
            y: menuPos.y,
            // Decorations key by the folded folder identity (MYND-562), not the
            // volatile display path — so a color follows the folder across
            // case-variant / display-flip and matches every client.
            key: node.key,
            folderPath: node.key,
          }),
      },
      // Archive the folder as a unit (folder-archive) — hidden when the archive
      // feature is disabled, mirroring the per-note "Archive" gate.
      ...(!archiveDisabled
        ? [
            {
              id: "folder.archive",
              label: t("notes.list.archiveFolder"),
              onSelect: () => fm.archiveFolderAction(node),
            },
          ]
        : []),
      {
        id: "delete",
        label: t("notes.list.delete"),
        destructive: true,
        onSelect: () => void fm.deleteFolderAction(node),
      },
    ];
  }, [
    fm,
    archiveDisabled,
    onRevealFolder,
    handleOpenIndexNote,
    handleCreateFolderNote,
    handleUnsetIndex,
    t,
  ]);

  // Background (root-level) context-menu items — Story F2.
  const bgMenuItems: ContextMenuItem[] = useMemo(
    () => [
      {
        id: "new-folder",
        label: t("notes.list.newFolder"),
        onSelect: () => fm.startNewFolder(""),
      },
      { id: "new-note", label: t("notes.list.newNoteMenu"), onSelect: onCreate },
      {
        id: "new-drawing",
        label: t("notes.list.newDrawingMenu"),
        onSelect: () => void ctx.createDrawingAndStartRename().catch(() => {}),
      },
    ],
    [ctx, fm, onCreate, t],
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
      // A confirm modal is already open — let it own the keyboard (its own
      // Enter/Esc handlers apply); a repeated Delete press must not re-stage.
      if (confirmKeyboardDelete !== null) return;
      // A multi-selection takes priority — Delete trashes the whole set
      // (MYND-367). Otherwise fall back to the single open note. Either way we
      // only STAGE the victim(s); a DeleteConfirmModal gates the actual trash
      // so a stray keypress can't lose notes (MYND-487).
      if (ctx.selectedIds.size > 0) {
        e.preventDefault();
        setConfirmKeyboardDelete({ kind: "bulk", ids: [...ctx.selectedIds] });
        return;
      }
      if (ctx.selectedId === null) return;
      e.preventDefault();
      setConfirmKeyboardDelete({ kind: "single", id: ctx.selectedId });
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [ctx.selectedId, ctx.selectedIds, ctx.renamingId, confirmKeyboardDelete]);

  // Resolve the staged keyboard-delete confirmation. Cancel just clears the
  // gate; confirm dispatches to the existing trash handlers (which own undo
  // toasts, selection follow-through, and rollback on IPC failure).
  const cancelKeyboardDelete = useCallback(() => {
    setConfirmKeyboardDelete(null);
  }, []);
  const runKeyboardDelete = useCallback(() => {
    const target = confirmKeyboardDelete;
    setConfirmKeyboardDelete(null);
    if (target === null) return;
    if (target.kind === "bulk") {
      void handleBulkDelete();
    } else {
      void handleTrash(target.id);
    }
  }, [confirmKeyboardDelete, handleBulkDelete, handleTrash]);

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
            <div style={SECTION_HEADING_STYLE}>
              {t("notes.list.favoritesHeading")}
            </div>
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
          <div style={SECTION_HEADING_STYLE}>{t("notes.list.notesHeading")}</div>
        </div>
        <div style={HEADER_ACTIONS_STYLE}>
          <IconButton
            icon="folder-plus"
            label={t("notes.list.newFolder")}
            testId="notes.new-folder"
            onClick={() => fm.startNewFolder("")}
          />
          <IconButton
            icon="file-plus"
            label={t("notes.list.newNoteShortcut")}
            testId="notes.create"
            onClick={onCreate}
          />
          {onNewFromTemplate && (
            <IconButton
              icon="chevron-down"
              label={t("notes.list.newNoteFromTemplate")}
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
                  railDepth={row.depth}
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
                    colorSlot={fm.itemColors[row.node.key]}
                    iconName={fm.folderIcons[row.node.key]}
                    onDragTarget={fm.setDropTargetKey}
                    onDropNote={(folderPath) =>
                      void fm.onFolderDropNote(folderPath)
                    }
                    onDropFiles={(folderPath, files) =>
                      void handleDropFiles(folderPath, files)
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
                    onOpenIndexNote={handleOpenIndexNote}
                    onCreateFolderNote={(folderPath) =>
                      void handleCreateFolderNote(folderPath)
                    }
                    onActivate={handleFolderActivate}
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
                railDepth={row.depth}
              >
                <div
                  style={{
                    position: "relative",
                    // Same base offset folder rows use, so a note and a folder at
                    // the same depth start in the same column. Notes were missing
                    // it, which sat every note 8px left of its sibling folders and
                    // read as the tree losing its spine (MYND-622).
                    paddingLeft:
                      TREE_BASE_PADDING_LEFT + row.depth * NOTE_INDENT_PER_LEVEL,
                  }}
                  draggable={ctx.renamingId === null}
                  data-note-depth={row.depth}
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
        <div ref={caseMergeDialogRef} style={CASE_MERGE_STYLE} role="alertdialog">
          <div>
            {t("notes.list.caseMergeBody", {
              name: fm.caseMerge.existingDisplay,
            })}
          </div>
          <div style={CASE_MERGE_ACTIONS_STYLE}>
            <button
              type="button"
              style={HEADER_BUTTON_STYLE}
              onClick={fm.cancelCaseMerge}
            >
              {t("notes.list.rename")}
            </button>
            <button
              type="button"
              style={{ ...HEADER_BUTTON_STYLE, color: "var(--fg-1)" }}
              onClick={fm.confirmCaseMerge}
            >
              {t("notes.list.mergeAnyway")}
            </button>
          </div>
        </div>
      )}
      {fm.confirmFolderDelete !== null && (
        <DeleteConfirmModal
          title={t("notes.list.deleteFolderTitle")}
          body={t("notes.list.deleteFolderBody", {
            name: fm.confirmFolderDelete.node.name,
            count: fm.confirmFolderDelete.noteCount,
          })}
          warning={t("notes.list.deleteFolderWarning")}
          confirmLabel={t("notes.list.deleteFolderConfirm")}
          onCancel={fm.cancelFolderDelete}
          onConfirm={fm.confirmFolderDeleteAction}
        />
      )}
      {confirmKeyboardDelete !== null && (
        <DeleteConfirmModal
          initialFocus="confirm"
          title={t("notes.list.trashConfirmTitle")}
          noteTitle={
            confirmKeyboardDelete.kind === "single"
              ? (ctx.cache.get(confirmKeyboardDelete.id)?.title ?? null)
              : undefined
          }
          body={
            confirmKeyboardDelete.kind === "bulk"
              ? t("notes.list.trashConfirmBulkBody", {
                  count: confirmKeyboardDelete.ids.length,
                })
              : undefined
          }
          warning={
            confirmKeyboardDelete.kind === "bulk"
              ? t("notes.list.trashConfirmBulkWarning")
              : t("notes.list.trashConfirmWarning")
          }
          confirmLabel={t("notes.list.trashConfirmConfirm")}
          onCancel={cancelKeyboardDelete}
          onConfirm={runKeyboardDelete}
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
        message={undoToast === null ? null : t("notes.list.noteMovedToTrash")}
        onDone={() => setUndoToast(null)}
        durationMs={6000}
        action={{ label: t("notes.list.undo"), onAction: handleUndoTrash }}
      />
      <Toast
        message={
          bulkUndo === null
            ? null
            : t("notes.list.notesMovedToTrash", { count: bulkUndo.length })
        }
        onDone={() => setBulkUndo(null)}
        durationMs={6000}
        action={{ label: t("notes.list.undo"), onAction: handleUndoBulk }}
      />
      <Toast
        message={importToast}
        onDone={() => setImportToast(null)}
        durationMs={5000}
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
  const { t } = useTranslation();
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
      title={t("notes.list.openAttachments")}
      aria-current={active ? "page" : undefined}
    >
      <Icon name="paperclip" size={15} />
      <span>{t("notes.list.attachments")}</span>
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
  const { t } = useTranslation();
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
        placeholder={
          parentPath === ""
            ? t("notes.list.newFolderPlaceholder")
            : t("notes.list.newFolderInPlaceholder", { path: parentPath })
        }
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
