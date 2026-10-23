/**
 * What survives a layout transition in the editor (myne-md/myne#918).
 *
 * A size-class change remounts the editor: the band and the phone render the
 * note at different tree positions, so React tears down the CodeMirror view and
 * builds a new one. The TEXT is safe (it lives in `EditorFlow` and is handed
 * back to the new view), but three things die with the instance, and they die
 * in order of how much the user notices:
 *
 *   - the scroll offset, which reads as the note jumping to the top;
 *   - the caret, which reads as typing starting somewhere else;
 *   - the undo history, which cannot be carried across a new EditorState at all.
 *
 * The first two are captured before the remount and replayed after it. The third
 * is knowingly not, and that is the reason this module is small and explicit
 * rather than a "restore the editor" helper: a caller should be able to see what
 * it does NOT put back.
 *
 * Nothing here touches storage. This is a RAM handoff across one render, and a
 * snapshot that is never applied is simply dropped.
 */

/** The slice of `EditorView` this module needs, so a test can drive it with a
 *  four-line fake instead of constructing a real editor. */
export interface CaretRestoreTarget {
  state: {
    selection: { main: { anchor: number; head: number } };
    doc: { length: number };
  };
  dispatch: (spec: { selection: { anchor: number; head: number } }) => void;
  hasFocus: boolean;
  focus: () => void;
  /** The editor's editable element, when the view has one. */
  contentDOM?: Element | null;
  /** The editor's own measure hook, when the view has one. CodeMirror's
   *  `MeasureRequest` requires a read half as well, so the call carries a
   *  no-op one. */
  requestMeasure?: (spec: { read: () => null; write: () => void }) => void;
}

/** The element that actually scrolls the note. On mobile this is the editor
 *  pane's own `.m-scroll` wrapper, NOT `view.scrollDOM`: the CodeMirror scroller
 *  inside it does not overflow once the pane has a bounded height, so the offset
 *  a user recognises lives on the wrapper. */
export interface ScrollOffset {
  scrollTop: number;
}

export interface CaretSnapshot {
  /** Caret offset in the OLD document. */
  head: number;
  /** Selection anchor. Equal to `head` for a collapsed caret; carrying it keeps
   *  a selection a selection across the fold instead of collapsing it. */
  anchor: number;
  /** Scroll offset of the editor's own scroller. */
  scrollTop: number;
  /** The note this was captured from, so a different one never inherits it. */
  noteId: string | null;
  /** Whether the editor held the keyboard. Restoring the caret without this
   *  leaves a fold mid-typing with the keyboard dismissed. */
  focused: boolean;
}

export function snapshotCaret(
  view: CaretRestoreTarget,
  noteId: string | null,
  scroller: ScrollOffset | null,
): CaretSnapshot {
  return {
    head: view.state.selection.main.head,
    anchor: view.state.selection.main.anchor,
    scrollTop: scroller?.scrollTop ?? 0,
    noteId,
    focused: holdsFocus(view),
  };
}

/** Whether the caret is IN this editor, which is not the same question as
 *  `view.hasFocus`: a headless browser and a window that lost OS focus both
 *  report `hasFocus` false while the caret is still visibly where the user left
 *  it. The DOM's own active-element answer is the one that survives both. */
function holdsFocus(view: CaretRestoreTarget): boolean {
  if (view.hasFocus) return true;
  return view.contentDOM != null && document.activeElement === view.contentDOM;
}

/**
 * Replay a snapshot onto the rebuilt view.
 *
 * Returns false when the snapshot belongs to another note (the user opened a
 * different one across the transition) or there is none, in which case nothing
 * is dispatched: inheriting a caret across notes would put the cursor at an
 * offset the new note's text may not even have.
 *
 * The caret is clamped to the new document's length. The two views are built
 * from the same buffer in the ordinary case, but a sync that lands during the
 * remount makes the new document shorter, and an out-of-range anchor throws.
 */
export function applyCaret(
  view: CaretRestoreTarget,
  snapshot: CaretSnapshot | null,
  noteId: string | null,
  scroller: ScrollOffset | null,
): boolean {
  if (!snapshot || snapshot.noteId !== noteId) return false;
  const clamp = (offset: number) => Math.max(0, Math.min(offset, view.state.doc.length));
  view.dispatch({ selection: { anchor: clamp(snapshot.anchor), head: clamp(snapshot.head) } });
  // Focus last, and only if the OLD view had it: `focus()` syncs the DOM
  // selection from the state we just set, and a fold that dismisses the keyboard
  // mid-sentence is the same kind of surprise as a caret that jumps.
  if (snapshot.focused) view.focus();
  const applyScroll = () => {
    if (scroller) scroller.scrollTop = snapshot.scrollTop;
  };
  applyScroll();
  // CodeMirror reveals the caret on its first measure after a mount, which
  // scrolls back to wherever the cursor is. Restoring inside that same cycle is
  // what makes the user's reading position win over it.
  view.requestMeasure?.({ read: () => null, write: applyScroll });
  return true;
}
