// Shared drag payload for opening a note into the editor workspace
// (MYND-166 behavioral pass). The SAME payload is produced by a tab drag
// (`TabStrip`) and by a sidebar-note drag (`useFolderManagement`), and
// consumed by the pane tab-strip drop + the pane-body split drop zones
// (`TabStrip` / `PaneView`). A `fromPaneId` of `null` marks a
// sidebar-origin drag (the note may not be open in any pane yet); a pane
// id marks a tab being dragged out of that pane (a move).
//
// A sidebar drag sets BOTH this MIME and the folder-move MIME
// (`application/x-myne-note`), so the same gesture can drop on a folder
// row (folder-move) OR on a pane (open as tab / split) — the drop target
// decides which payload it reads.

import type { NoteId } from "./sidebarState";

export const TAB_DRAG_MIME = "application/x-myne-tab";

export type TabDragPayload = {
  noteId: NoteId;
  /** Source pane id, or `null` when the drag originates in the sidebar. */
  fromPaneId: string | null;
};

export function writeTabDrag(dt: DataTransfer, payload: TabDragPayload): void {
  dt.setData(TAB_DRAG_MIME, JSON.stringify(payload));
}

export function readTabDrag(dt: DataTransfer): TabDragPayload | null {
  const raw = dt.getData(TAB_DRAG_MIME);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as TabDragPayload;
    if (typeof parsed.noteId !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}
