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
    return null; // position outside the measured height map
  }
  return { pos, offsetPx: contentRect.top + top - scrollerTop };
}

/** Remember `view`'s current reading position for `noteId`. No-op when it cannot
 *  be measured, so a bad moment never overwrites a good anchor. */
export function rememberScroll(
  noteId: string,
  view: EditorView,
  scroller: HTMLElement,
): void {
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
 */
export function applyScrollAnchor(view: EditorView, anchor: ScrollAnchor): void {
  const pos = Math.min(anchor.pos, view.state.doc.length);
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
}
