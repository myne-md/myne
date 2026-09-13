// Bridge from the left ribbon (rendered in the Editor's layout row) to the
// command context, which is built inside `CommandPaletteHost` (a sibling
// subtree). Same shape as `sidebarCommands`: the rail is a separate subtree, so
// the host registers thin handlers on mount and the rail calls them
// imperatively. `undefined` before the host mounts, so the rail renders but
// does nothing rather than throwing.

export type RibbonVisibility = "show" | "disabled" | "hidden";

export type RibbonCommandHandlers = {
  /** Run a registry action by id against the live command context. */
  run?: (id: string) => void;
  /** Resolve a registry action's per-state visibility against the live context. */
  visibility?: (id: string) => RibbonVisibility;
  /** Open Settings on the Appearance panel, where the rail roster lives
   *  (myne-md/myne#699). The rail's right-click menu calls this. */
  customizeRibbon?: () => void;
};

export const ribbonCommands: RibbonCommandHandlers = {};
