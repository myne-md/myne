// Focus-mode editor behaviours (focus-mode, MYND-348).
//
// Two pieces, both ACTIVE ONLY in focus mode and only when their pref is on:
//   - Typewriter scroll: keep the active line vertically centered as the cursor
//     moves. Implemented here as an always-mounted ViewPlugin gated by a DOM
//     attribute (`data-focus-typewriter="true"` on an editor ancestor, set by
//     EditorChrome = focusActive && editor_focus_typewriter). No threading /
//     compartment needed — the gate is read off the DOM on each relevant update.
//   - Dim inactive lines: pure CSS (tokens.css `[data-focus-dim] .cm-line`), so
//     it lives there, not here. This module owns only the scroll behaviour.
//
// Both honor `prefers-reduced-motion`: the typewriter scroll is a one-shot
// `scrollIntoView` (no animation library, no looping), and the dim is a CSS
// opacity transition the global reduced-motion rule zeroes.

import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

/** Walk up from the editor DOM to see whether focus-mode typewriter scroll is
 *  currently enabled (EditorChrome sets the attr = focusActive && pref). */
function typewriterEnabled(view: EditorView): boolean {
  return view.dom.closest('[data-focus-typewriter="true"]') !== null;
}

/**
 * Always-mounted typewriter-scroll plugin. On a selection/doc change, if focus
 * mode + the typewriter pref are on (DOM gate) and the view has focus, scroll the
 * main selection head to the vertical center. Dispatched in a microtask because
 * a transaction cannot be dispatched from inside `update()`; the scroll effect
 * does not change the selection or doc, so it does not re-trigger this plugin
 * (no loop).
 */
// A stable key so rapid keystrokes coalesce to ONE measure per frame (the last
// request with this key wins) instead of stacking scroll writes.
const typewriterMeasureKey = {};

const typewriterPlugin = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {}
    update(u: ViewUpdate) {
      if (!u.selectionSet && !u.docChanged) return;
      // Never re-center on a MOUSE selection/click. Scrolling mid-click moves the
      // content between mousedown and mouseup, which CM6 then reads as a drag —
      // selecting the span between the two click points. Typewriter centering is
      // for KEYBOARD caret movement + typing only; a mouse click places the caret
      // where the user aimed and must not yank the viewport.
      if (u.transactions.some((t) => t.isUserEvent("select.pointer"))) return;
      const view = this.view;
      if (!view.hasFocus || !typewriterEnabled(view)) return;
      // Center the caret's line by writing `scrollDOM.scrollTop` DIRECTLY in CM's
      // measure cycle — NOT by dispatching a `scrollIntoView` transaction. A
      // per-keystroke transaction redraws the selection (the brief flash) and
      // races CM's own post-edit scroll (the "doesn't always center / gets
      // stuck"). A measure-phase scroll write is flicker-free + deterministic, and
      // clamps cleanly at the document ends (can't over-center near top/bottom).
      view.requestMeasure({
        key: typewriterMeasureKey,
        read: () => {
          const head = view.state.selection.main.head;
          const block = view.lineBlockAt(head);
          return (block.top + block.bottom) / 2 - view.scrollDOM.clientHeight / 2;
        },
        write: (target) => {
          if (!view.hasFocus || !typewriterEnabled(view)) return;
          view.scrollDOM.scrollTop = Math.max(0, target);
        },
      });
    }
  },
);

/** The focus-mode editor extension (typewriter scroll). Always mounted; inert
 *  unless the DOM gate is present. */
export function focusModeExtension(): Extension {
  return [typewriterPlugin];
}
