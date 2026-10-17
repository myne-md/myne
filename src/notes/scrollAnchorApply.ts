// The one CodeMirror-touching half of `scrollMemory`.
//
// # Why this is a separate module
//
// `scrollMemory.ts` holds the session's remembered reading positions and the
// function that CLEARS them on a vault-leaving path, and that reset is imported
// by `src/lib/vault-unlock.ts` and `src/lib/vault-switch.ts` — which the app
// loads before anything the editor owns. While `applyScrollAnchor` lived
// alongside it, the module's module-scope `import { EditorView } from
// "@codemirror/view"` put the whole CodeMirror view stack into first load for a
// function no pre-unlock screen can reach (measured by
// `scripts/check-web-bundle-budget.mjs`).
//
// So the store keeps only a `import type` of `EditorView` and this module owns
// the one value use, `EditorView.scrollIntoView`. Nothing imports this except
// the pane that actually scrolls.

import { EditorView } from "@codemirror/view";
import { beginScrollRestore, type ScrollAnchor } from "./scrollMemory";

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
