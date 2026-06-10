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
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
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
import { deriveFolderTree } from "../folderTree";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { DecorationPopover } from "./DecorationPopover";
import { Toast } from "../../components/Toast";
import { FolderRow } from "./FolderRow";
import { NoteRow } from "./NoteRow";
import type { TitleRecord } from "../loadNoteBatch";
import { VirtualList } from "./VirtualList";
import { useWorkspace } from "../workspaceContext";
import { IconButton } from "../../components/primitives/IconButton";
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
}): (e: KeyboardEvent) => void {
  const { sortedIds, selectedId, renamingId, select, open, pageSize = 10 } = opts;

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
        select(sortedIds[next] ?? null);
        return;
      }
      case "ArrowUp": {
        e.preventDefault();
        const next = idx <= 0 ? 0 : idx - 1;
        select(sortedIds[next] ?? null);
        return;
      }
      case "Home": {
        e.preventDefault();
        select(sortedIds[0] ?? null);
        return;
      }
      case "End": {
        e.preventDefault();
        select(sortedIds[sortedIds.length - 1] ?? null);
        return;
      }
      case "PageDown": {
        e.preventDefault();
        const target = Math.min(
          idx < 0 ? pageSize - 1 : idx + pageSize,
          sortedIds.length - 1,
        );
        select(sortedIds[target] ?? null);
        return;
      }
      case "PageUp": {
        e.preventDefault();
        const target = idx < 0 ? 0 : Math.max(idx - pageSize, 0);
        select(sortedIds[target] ?? null);
        return;
      }
      case "Enter": {
        if (selectedId !== null) {
          e.preventDefault();
          void open(selectedId);
        }
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
}

export function NoteList({ onNewFromTemplate }: NoteListProps = {}) {
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

  // Ephemeral collapse state — folded folder keys. Default empty = all
  // expanded; reset on app restart (folder paths are AS3 → no persistence).
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggleFolder = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
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
  // Unified manual order (item_order) interleaves folders + loose notes per
  // container (MYND-183); flatten owns all display ordering.
  const rows = useMemo(
    () => flattenVisibleRows(tree, live, collapsed, fm.itemOrder),
    [tree, live, collapsed, fm.itemOrder],
  );
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
          onToggleFolder={toggleFolder}
          onCreate={handleCreate}
          fm={fm}
          onNewFromTemplate={onNewFromTemplate}
        />
      )}
      <div style={FOOTER_WRAP_STYLE}>
        <AttachmentsNavEntry />
        <button
          type="button"
          style={FOOTER_ENTRY_STYLE}
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
            onClick={() => fm.startNewFolder("")}
          />
          <IconButton icon="file-plus" label="New note" onClick={onCreate} />
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

type ContextMenuState = { id: NoteId; x: number; y: number } | null;

function PopulatedList({
  rows,
  favRows,
  navIds,
  onToggleFolder,
  onCreate,
  fm,
  onNewFromTemplate,
}: {
  rows: VisibleRow[];
  favRows: VisibleRow[];
  navIds: NoteId[];
  onToggleFolder: (key: string) => void;
  onCreate: () => void;
  fm: FolderManagement;
  onNewFromTemplate?: () => void;
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
  const [menu, setMenu] = useState<ContextMenuState>(null);
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
        renaming={ctx.renamingId === id}
        onSelect={(noteId, opts) => openNote(noteId, opts)}
        onStartRename={ctx.startRename}
        onContextMenu={handleContextMenu}
        onCommitRename={async (noteId, newTitle) => {
          await executeRenameCommit(noteId, newTitle, ctx);
        }}
        onCancelRename={ctx.cancelRename}
        favorited={favorited}
        onToggleFavorite={fm.toggleFavorite}
        colorSlot={fm.itemColors[id]}
      />
    ),
    [ctx, openNote, handleContextMenu, fm.toggleFavorite, noteHighlightActive, fm.itemColors],
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

  const menuItems: ContextMenuItem[] = useMemo(() => {
    if (menu === null) return [];
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
        id: "delete",
        label: "Delete",
        destructive: true,
        onSelect: () => void handleTrash(menu.id),
      },
    ];
  }, [menu, ctx, handleTrash, fm, favSet, openNote]);

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
      if (ctx.selectedId === null) return;
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
      e.preventDefault();
      void handleTrash(ctx.selectedId);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [ctx.selectedId, ctx.renamingId, handleTrash]);

  return (
    <div style={LIST_OUTER_STYLE} onContextMenu={handleBackgroundContextMenu}>
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
            onClick={() => fm.startNewFolder("")}
          />
          <IconButton
            icon="file-plus"
            label="New note (⌘N)"
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
          estimatedRowHeight={44}
          renderItem={(row) => {
            if (row.kind === "folder") {
              return (
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
                  onDropNote={(folderPath) => void fm.onFolderDropNote(folderPath)}
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
              );
            }
            const record = ctx.cache.get(row.id);
            if (record === undefined) return null;
            const id = row.id;
            const reorderPlace =
              fm.reorderTarget?.id === id ? fm.reorderTarget.place : null;
            return (
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
