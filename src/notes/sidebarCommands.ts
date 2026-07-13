// Bridge from the command palette to sidebar-owned surfaces (MYND palette-gap
// audit, Wave 4). The Trash / Archive panels and "new folder" live as local
// state inside `NoteList`, which the palette (`CommandPaletteHost`, a separate
// subtree) can't reach directly. `NoteList` registers thin handlers here on
// mount and clears them on unmount; the palette actions call them if present.
//
// A deliberately tiny service-locator, not a store — no reactivity needed (the
// actions fire imperatively). `undefined` when the sidebar isn't mounted (any
// non-editor stage), so the actions no-op safely.

type SidebarCommands = {
  openTrash?: () => void;
  openArchive?: () => void;
  newFolder?: () => void;
  /**
   * Expand the left sidebar so the surfaces above are reachable — the pane is
   * `inert` while collapsed (incl. focus mode), so an action must reveal it
   * BEFORE opening its surface. Registered by the Editor screen (which owns
   * the layout + focus state). Returns `false` when a width-forced collapse
   * (MYND-192) makes expansion impossible; callers then skip their surface
   * rather than ghost-open it.
   */
  revealSidebar?: () => boolean;
};

export const sidebarCommands: SidebarCommands = {};
