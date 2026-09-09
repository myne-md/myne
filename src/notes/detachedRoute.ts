// Pop-out routing decision (myne-md/myne#681 task 3, #678 task 5; SYNC-6).
//
// SYNC-6 says a note lives in exactly ONE surface. So triggering the pop-out
// affordance on a note is not always "spawn a window": it depends on where the
// note already lives. This pure function is the decision, kept separate from the
// IPC and the React state so it can be exercised without either (the Vitest spec
// drives all three arms). The caller maps the verdict to an action:
//
//   "suppress" -> do nothing. The request came FROM the detached window that
//                 already shows this note; re-popping its own note is a no-op the
//                 UI should not even offer.
//   "reveal"   -> the note is already in a pop-out. Focus that window (the host
//                 `detached_window_open` reveals an already-open note rather than
//                 duplicating it); the main-window tab is already gone.
//   "spawn"    -> the note is in the main window. MOVE it: open the pop-out and
//                 close the source tab so the two never autosave one blob at once.
//
// The move (close-the-tab) is what closes the concurrent-writer clobber: without
// it a popped-out note stays a live autosaving main-window tab AND a live pop-out.

export type PopOutRoute = "suppress" | "reveal" | "spawn";

export interface PopOutRouteInput {
  /** The note the affordance was triggered for. */
  readonly noteId: string;
  /** Whether `noteId` is already held in a detached window on this device. A
   *  predicate (not a Set) so the caller can back it with a live ref without
   *  copying, while the function stays pure. */
  readonly isDetached: (noteId: string) => boolean;
  /**
   * The note this window is itself a detached surface for, or `null` in the main
   * window. A detached window must not offer to pop out its own note.
   */
  readonly requestingDetachedNoteId: string | null;
}

export function decidePopOutRoute(input: PopOutRouteInput): PopOutRoute {
  const { noteId, isDetached, requestingDetachedNoteId } = input;
  if (requestingDetachedNoteId !== null && requestingDetachedNoteId === noteId) {
    return "suppress";
  }
  if (isDetached(noteId)) return "reveal";
  return "spawn";
}
