// Collapse the spurious 1–few character selection a plain click can produce when
// the cursor-aware reveal reflows the line under the pointer between mousedown and
// mouseup.
//
// Example: clicking an H1 title re-shows the hidden `# ` (heading.ts reveal),
// shifting the text right, so the mouseup resolves a few characters off the
// mousedown anchor → CM records that as a selection. The user "just clicked" but
// sees a couple of letters selected.
//
// Fix: if the pointer did NOT move between down and up (a real click, not a
// drag) yet a SMALL selection appeared, it's that reflow artifact — collapse it
// to a caret at the head. A genuine drag (pointer moved past the threshold) or a
// larger selection is left untouched, so deliberate selection still works.

import { EditorSelection, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

const MOVE_THRESHOLD = 3; // px — at/below this a press+release is a click, not a drag
const MAX_SPURIOUS = 6; // chars — only collapse small reflow-induced ranges

export function clickCollapseExtension(): Extension {
  let downX: number | null = null;
  let downY: number | null = null;
  return EditorView.domEventHandlers({
    mousedown(event) {
      if (event.button !== 0) return false;
      downX = event.clientX;
      downY = event.clientY;
      return false; // record only — never preempt CM's own selection
    },
    mouseup(event, view) {
      if (downX === null || downY === null) return false;
      const moved =
        Math.abs(event.clientX - downX) > MOVE_THRESHOLD ||
        Math.abs(event.clientY - downY) > MOVE_THRESHOLD;
      downX = null;
      downY = null;
      if (moved) return false; // deliberate drag-select — leave it
      // Defer past CM's own selection update AND the reveal reflow.
      requestAnimationFrame(() => {
        try {
          const sel = view.state.selection.main;
          if (!sel.empty && Math.abs(sel.head - sel.anchor) <= MAX_SPURIOUS) {
            view.dispatch({
              selection: EditorSelection.cursor(sel.head),
              userEvent: "select",
            });
          }
        } catch {
          /* view torn down between the click and the frame — nothing to do */
        }
      });
      return false;
    },
  });
}
