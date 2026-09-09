// Where each note was left, in DOCUMENT coordinates (myne-md/myne#600).
//
// # Why not a pixel
//
// The scroll position used to be remembered as the outer scroller's `scrollTop`,
// restored once inside a `requestAnimationFrame`. That is wrong twice.
//
// It is wrong in TIME: at that frame CodeMirror has not finished measuring and
// the late-resolving blocks (images, math, mermaid, attachment embeds) have not
// taken their height, so the document is shorter than it will be and the browser
// CLAMPS the assignment to the current `scrollHeight`. Nothing corrects it after.
//
// It is wrong in UNIT: after a pane split the pane is narrower, the text
// re-wraps, and the same pixel offset points at different content. A document
// position does not re-wrap (the line the reader was on is the same line at any
// width), so that is what gets remembered, plus how far below the viewport's top
// edge it was sitting.
//
// # Why module scope
//
// A split UNMOUNTS the pane (`PaneTree` renders `<PaneView>` for a leaf with no
// key, so a leaf becoming a split node replaces the component). Anything the
// pane owned goes with it, which is why the scroll used to be lost on exactly
// the gesture the reader is most likely to be mid-thought during. The order is a
// property of the session, not of a pane, so it lives here.
//
// Session-lived, deliberately: this is a convenience, and persisting it would
// mean writing per-note UI state into `vault.workspace` (§9.7). Nothing here is
// persisted, so nothing here reaches the vault.

import { EditorView } from "@codemirror/view";

/** A remembered reading position. */
export type ScrollAnchor = {
  /** The document offset of the line at the top of the viewport. */
  readonly pos: number;
  /** How far BELOW the viewport's top edge that line's own top sits, in px.
   *  Usually negative (the line is partly scrolled off), which is what keeps a
   *  restore from jumping by up to one line height. */
  readonly offsetPx: number;
};

const anchors = new Map<string, ScrollAnchor>();

/**
 * Notes whose remembered anchor is currently being RESTORED, and must therefore
 * not be re-remembered from the scroll that restore is producing (myne#651).
 *
 * # The loop this breaks
 *
 * `applyScrollAnchor` scrolls the pane. That scroll fires the pane's own scroll
 * listener, which remembers the position it lands at. So the restore writes its
 * own result back over the anchor it was restoring from.
 *
 * If a restore were exact that would be harmless: it would rewrite the same
 * value. It cannot be exact, and the reason is the reason the restore exists at
 * all. `readScrollAnchor` records a LINE plus the fraction of it scrolled off,
 * and a restore runs after the pane's width changed and re-wrapped the text ,
 * so the line is put back, and its sub-pixel offset within a viewport of
 * different line heights is not. The residue is small and it is written back,
 * so the next restore starts from the drifted anchor and adds its own residue.
 *
 * Toggling a sidebar is exactly that, once per toggle, which is why the note
 * walked one notch down the viewport per open/close and never walked back.
 *
 * # Why a suppression window rather than a flag around the call
 *
 * The scroll `applyScrollAnchor` causes does not happen during the call. It is
 * dispatched as a CodeMirror effect, lands after the next measure, and the
 * pane's listener coalesces on a trailing timer. A flag cleared when the
 * function returns would already be off by the time the write it is meant to
 * suppress arrives. The window has to outlive that whole chain.
 */
const restoring = new Map<string, number>();

/**
 * How long a restore suppresses re-remembering, in ms. Comfortably longer than
 * `PaneView`'s `SCROLL_SETTLE_MS` (120), because the write to suppress happens
 * on the trailing edge of that timer, one full settle AFTER the scroll lands.
 *
 * Being generous costs only that a genuine user scroll within the window is not
 * remembered; the next one is. Being tight costs the bug back.
 */
const RESTORE_SUPPRESSION_MS = 500;

/**
 * Mark `noteId` as being restored, so scroll writes are ignored for a moment.
 *
 * Exported for `tests/notes/scrollMemory.test.ts` and for a future restore path
 * that does not go through {@link applyScrollAnchor}. Every path today does, so
 * this has no production caller, said plainly rather than claiming one, which
 * an earlier version of this comment did.
 */
export function beginScrollRestore(noteId: string, now = Date.now()): void {
  restoring.set(noteId, now);
}

/** Whether a restore of `noteId` is still settling. */
export function isRestoringScroll(noteId: string, now = Date.now()): boolean {
  const started = restoring.get(noteId);
  if (started === undefined) return false;
  if (now - started <= RESTORE_SUPPRESSION_MS) return true;
  restoring.delete(noteId);
  return false;
}

/**
 * Read the reading position out of a live view, or `null` when it cannot be
 * measured (a detached view, a pane with no height yet).
 */
export function readScrollAnchor(
  view: EditorView,
  scroller: HTMLElement,
): ScrollAnchor | null {
  const scrollerTop = scroller.getBoundingClientRect().top;
  const contentRect = view.contentDOM.getBoundingClientRect();
  // One pixel inside the viewport, and far enough from the left edge to land on
  // the line rather than in its padding.
  const pos = view.posAtCoords({ x: contentRect.left + 4, y: scrollerTop + 1 });
  if (pos === null) return null;
  let top: number;
  try {
    top = view.lineBlockAt(pos).top;
  } catch {
    // Measured, not assumed: the real `lineBlockAt` throws `RangeError:
    // Invalid position N in document of length M` for a position past the end,
    // which is what a coordinate read during a re-layout can produce. The
    // earlier wording here said "outside the measured height map", which was a
    // guess at the cause and named a different one.
    return null;
  }
  return { pos, offsetPx: contentRect.top + top - scrollerTop };
}

/** Remember `view`'s current reading position for `noteId`. No-op when it cannot
 *  be measured, so a bad moment never overwrites a good anchor, and no-op while
 *  a restore of this note is still settling, so the restore cannot write its own
 *  rounding error back over the anchor it came from (myne#651). */
export function rememberScroll(
  noteId: string,
  view: EditorView,
  scroller: HTMLElement,
): void {
  if (isRestoringScroll(noteId)) return;
  const anchor = readScrollAnchor(view, scroller);
  if (anchor !== null) anchors.set(noteId, anchor);
}

/** The anchor remembered for `noteId`, if any. */
export function recallScroll(noteId: string): ScrollAnchor | undefined {
  return anchors.get(noteId);
}

/** Forget `noteId`, for a closed tab whose reopen should start at the top. */
export function forgetScroll(noteId: string): void {
  anchors.delete(noteId);
  // Both maps, not just the anchors. `evictClosedTabs` routes here, so leaving
  // the suppression mark behind would accumulate one entry per note restored
  // and then closed, for the life of the session, with nothing able to read it
  // again. The note is gone; its mark cannot matter.
  restoring.delete(noteId);
}

/**
 * Evict the notes a pane just CLOSED: open on the previous pass, gone now.
 *
 * The pane's own tab set is the input, and it has to be, which is the whole
 * reason this is a function rather than three lines at the call site. The first
 * version walked the per-note `EditorState` cache instead and evicted the keys
 * that were no longer open, which answers a different question: that cache holds
 * only notes the pane switched AWAY from, since the active note's state lives in
 * the editor itself, and it is emptied wholesale whenever an out-of-band change
 * (a sync pull, an external edit) invalidates it. So a tab closed without ever
 * having been left, and any tab closed after a sync pull, kept its reading
 * position for the rest of the session, and a reopen landed halfway down a note
 * nobody remembered scrolling.
 *
 * A SPLIT is deliberately not this case: it leaves the source pane's tab where
 * it is, so the id stays in `open` and the anchor survives, which is what makes
 * "reopen starts at the top" a statement about closing rather than about panes.
 *
 * `stateCache` is evicted alongside, so the two cannot disagree about which
 * notes this pane still has open. Returns the ids it forgot, for the caller's
 * tests and for nothing else.
 */
export function evictClosedTabs(
  previouslyOpen: Iterable<string>,
  open: ReadonlySet<string>,
  stateCache: Pick<Map<string, unknown>, "delete">,
): string[] {
  const closed: string[] = [];
  for (const id of previouslyOpen) {
    if (open.has(id)) continue;
    stateCache.delete(id);
    forgetScroll(id);
    closed.push(id);
  }
  return closed;
}

/**
 * Put `anchor`'s line back where it was.
 *
 * Dispatched as CodeMirror's own `scrollIntoView` effect rather than assigned to
 * `scrollTop`: CM re-measures before scrolling and walks the scrollable
 * ancestors, so this lands after layout instead of racing one frame, and it
 * finds the pane's OUTER scroller (the editor itself never scrolls, see
 * `editor/src/scroll-slack.ts`).
 *
 * `y: "start"` puts the line at the top of the viewport and `yMargin` restores
 * the fraction of it that was scrolled off, so the restore is exact when nothing
 * changed and still on the right LINE when the pane's width did.
 *
 * `noteId` is what suppresses the write-back this scroll would otherwise cause
 * (see {@link beginScrollRestore}). It is **required**, deliberately: an
 * optional one would let the next caller reintroduce myne#651 by omitting it,
 * and a default is the arm that never fires.
 */
export function applyScrollAnchor(
  view: EditorView,
  anchor: ScrollAnchor,
  noteId: string,
): void {
  const pos = Math.min(anchor.pos, view.state.doc.length);
  // BEFORE the dispatch: the scroll it causes can land in the same frame.
  beginScrollRestore(noteId);
  view.dispatch({
    effects: EditorView.scrollIntoView(pos, {
      y: "start",
      yMargin: anchor.offsetPx,
    }),
  });
}

/** Forget every remembered position.
 *
 * Called on both vault-leaving paths (`lockVault`, `leaveActiveVault`) and
 * asserted there by `scripts/check-frontend-lock-teardown.mjs`: this map is
 * module scope, no leaving path reloads the WebView, and the memory this
 * feature promises is scoped to the session a lock ends. Also the reset the
 * tests use between cases. */
export function resetScrollMemory(): void {
  anchors.clear();
  // The in-flight restore marks too (myne#651). Both maps are module scope and
  // no leaving path reloads the WebView, so a mark left behind here outlives the
  // vault it belongs to and silences the FIRST scroll write of the next
  // session's note with the same id. It cost a test before it could cost a user,
  // which is the cheap version of the same bug.
  restoring.clear();
}
