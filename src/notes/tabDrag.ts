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

export const TAB_DRAG_MIME = "application/x-myne-tab";

export type TabDragPayload = {
  /** The dragged tab's opaque handle — a workspace `itemKey` (`"note:<id>"` /
   *  `"view:<id>"`, MYND-274). A sidebar-note drag produces the note handle;
   *  the consumer parses it back to a `WorkspaceItem` via `parseItemKey`. */
  tabId: string;
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
    if (typeof parsed.tabId !== "string") return null;
    return { tabId: parsed.tabId, fromPaneId: parsed.fromPaneId ?? null };
  } catch {
    return null;
  }
}
