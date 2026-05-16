// `<NoteList>` — Notes sidebar container.
//
// Visual canon: Penpot frames `screen------notes-sidebar--empty` (boş
// vault) + `screen------notes-sidebar--populated` (Notes header +
// "+ New Note" button + virtualized rows). Tokens per
// `colors_and_type.css`.
//
// PRD stories: 1 (empty state placeholder), 2 (sidebar populates after
// unlock), 78 (container), 81 (empty CTA).

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { SECTION_HEADING_STYLE } from "./sharedStyles";
import { noteRead } from "../readNote";
import {
  useSelectedNote,
  sortBatchIds,
  type NoteId,
  type UseSelectedNoteReturn,
} from "../sidebarState";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { DeleteConfirmModal } from "./DeleteConfirmModal";
import { NoteRow } from "./NoteRow";
import { VirtualList } from "./VirtualList";

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
  width: 260,
  background: "var(--paper-2)",
  borderRight: "1px solid var(--line-1)",
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
};

const LIST_OUTER_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
};

export function NoteList() {
  const ctx = useSelectedNote();
  // Cache identity changes only on actual data mutations (Map is
  // replaced via `applyCacheUpdate` etc.). Memo on cache identity so
  // selection-only re-renders don't reshuffle a 1000-row sort.
  const sortedIds = useMemo(
    () => sortBatchIds(Array.from(ctx.cache.keys()), ctx.cache),
    [ctx.cache],
  );
  const isEmpty = sortedIds.length === 0;

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
      sortedIds,
      selectedId: ctx.selectedId,
      renamingId: ctx.renamingId,
      select: ctx.select,
      open: ctx.open,
    });
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [sortedIds, ctx]);

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
        <EmptyState onCreate={handleCreate} />
      ) : (
        <PopulatedList sortedIds={sortedIds} onCreate={handleCreate} />
      )}
    </aside>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div style={LIST_OUTER_STYLE}>
      <div style={HEADER_ROW_STYLE}>
        <div style={SECTION_HEADING_STYLE}>Notes</div>
      </div>
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
type DeleteModalState = { id: NoteId; title: string | null } | null;

function PopulatedList({
  sortedIds,
  onCreate,
}: {
  sortedIds: NoteId[];
  onCreate: () => void;
}) {
  const ctx = useSelectedNote();
  const [menu, setMenu] = useState<ContextMenuState>(null);
  const [deleteModal, setDeleteModal] = useState<DeleteModalState>(null);

  const openDeleteModal = useCallback(
    (id: NoteId) => {
      const record = ctx.cache.get(id);
      setDeleteModal({ id, title: record?.title ?? null });
    },
    [ctx.cache],
  );

  const handleContextMenu = useCallback(
    (id: NoteId, pos: { x: number; y: number }) => {
      // Also select the right-clicked row so the visual state matches
      // the context-menu target (mirrors Finder / Explorer behavior).
      ctx.select(id);
      setMenu({ id, x: pos.x, y: pos.y });
    },
    [ctx],
  );

  const closeMenu = useCallback(() => setMenu(null), []);
  const closeDeleteModal = useCallback(() => setDeleteModal(null), []);

  const confirmDelete = useCallback(async () => {
    if (deleteModal === null) return;
    const victimId = deleteModal.id;
    // Pick adjacent BEFORE the delete fires — the optimistic remove
    // in `ctx.deleteWithRollback` drops the row from the cache; if we
    // compute adjacent after, we'd pick from a list that no longer
    // contains the victim.
    const wasSelected = ctx.selectedId === victimId;
    const adjacent = wasSelected
      ? pickAdjacentAfterDelete(sortedIds, victimId)
      : null;
    setDeleteModal(null);
    try {
      await ctx.deleteWithRollback(victimId);
      if (wasSelected && adjacent !== null) {
        void ctx.open(adjacent).catch(() => {
          /* T30 wires editor body load; ignore here */
        });
      }
    } catch (err) {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn("[NoteList] deleteWithRollback failed:", err);
      }
    }
  }, [deleteModal, ctx, sortedIds]);

  const menuItems: ContextMenuItem[] = useMemo(() => {
    if (menu === null) return [];
    return [
      {
        id: "rename",
        label: "Rename",
        onSelect: () => ctx.startRename(menu.id),
      },
      {
        id: "delete",
        label: "Delete",
        destructive: true,
        onSelect: () => openDeleteModal(menu.id),
      },
    ];
  }, [menu, ctx, openDeleteModal]);

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
      openDeleteModal(ctx.selectedId);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [ctx.selectedId, ctx.renamingId, openDeleteModal]);

  return (
    <div style={LIST_OUTER_STYLE}>
      <div style={HEADER_ROW_STYLE}>
        <div style={SECTION_HEADING_STYLE}>Notes</div>
        <button
          type="button"
          onClick={onCreate}
          style={HEADER_BUTTON_STYLE}
          aria-label="Create a new note"
          title="New note (⌘N)"
        >
          + New Note
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <VirtualList
          items={sortedIds}
          keyOf={(id) => id}
          estimatedRowHeight={52}
          renderItem={(id) => {
            const record = ctx.cache.get(id);
            if (record === undefined) return null;
            return (
              <NoteRow
                record={record}
                selected={ctx.selectedId === id}
                renaming={ctx.renamingId === id}
                onSelect={(noteId) => {
                  void ctx.open(noteId).catch(() => {
                    /* T30 wires editor body load; ignore here */
                  });
                }}
                onStartRename={ctx.startRename}
                onContextMenu={handleContextMenu}
                onCommitRename={async (noteId, newTitle) => {
                  await executeRenameCommit(noteId, newTitle, ctx);
                }}
                onCancelRename={ctx.cancelRename}
              />
            );
          }}
        />
      </div>
      {menu !== null && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={closeMenu}
        />
      )}
      {deleteModal !== null && (
        <DeleteConfirmModal
          noteTitle={deleteModal.title}
          onCancel={closeDeleteModal}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </div>
  );
}
