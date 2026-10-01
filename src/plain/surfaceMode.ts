// Which surface owns the editor host right now (myne-md/myne#788).
//
// The desktop app installs ONE `EditorHost` per window (`src/editor-host.ts`),
// and the plain-file surface renders the same `@myne/editor` engine in that
// same window. The host's vault-coupled members therefore need to know when
// the plain surface is active, because "never touches vault data" has to hold
// for AMBIENT reads (prefs on mount, the tag tree on a typed `#`, the spell
// pass) and not only for the controls a user could click.
//
// A module-scope boolean rather than React context, deliberately: the readers
// are module-scope bridge functions inside `@myne/editor` that never see the
// React tree. One writer (this surface's mount/unmount), one synchronous read.
//
// The plain surface sets this on mount and clears it on unmount, so the flag
// can never outlive the surface by more than a render.

let plainSurfaceActive = false;

/** Called by the plain surface's mount (true) and unmount (false). */
export function setPlainSurfaceActive(active: boolean): void {
  plainSurfaceActive = active;
}

/** Read by the host's vault-coupled members. */
export function isPlainSurfaceActive(): boolean {
  return plainSurfaceActive;
}
