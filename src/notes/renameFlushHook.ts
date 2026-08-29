// Cross-provider seam for rename auto-update (WL-8). `commitRename` lives in
// `SidebarStateProvider`, which mounts ABOVE `WorkspaceProvider` (see
// `screens/Editor.tsx`) and therefore cannot read the workspace context. The
// workspace layer registers its open-note set + flush-all here on mount; the
// rename orchestrator (`./renameInbound.ts`) reads them through the
// `defaultRenameInboundDeps` factory.
//
// Default (nothing registered) = no panes open + a no-op flush, so a rename
// composed before the workspace mounts (or in a unit test) degrades to the
// closed-notes path rather than throwing.

export interface RenameFlushHooks {
  /** Note-ids open in any pane right now. */
  readonly openNoteIds: () => ReadonlySet<string>;
  /** Flush every dirty pane editor to disk, and REJECT when any pane did not
   *  settle (myne-md/myne#520). A caller that reads-patch-writes on top of a
   *  pane whose save just failed clobbers unsaved text, so "the flush ran" and
   *  "the disk matches the buffer" have to be distinguishable. */
  readonly flushOpenPanes: () => Promise<void>;
}

const EMPTY: RenameFlushHooks = {
  openNoteIds: () => new Set<string>(),
  // Resolves, and correctly: no panes are registered, so nothing failed to
  // settle. The degraded case is "no open editors", not "an unknown state".
  flushOpenPanes: async () => {},
};

let current: RenameFlushHooks = EMPTY;

/** Register the workspace layer's open-note set + flush-all (call on mount). */
export function registerRenameFlushHooks(next: RenameFlushHooks): void {
  current = next;
}

/** Reset to the no-op default (call on the workspace layer's unmount). */
export function clearRenameFlushHooks(): void {
  current = EMPTY;
}

/** The currently-registered hooks (or the no-op default). */
export function renameFlushHooks(): RenameFlushHooks {
  return current;
}
