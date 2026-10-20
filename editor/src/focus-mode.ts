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
// `scrollTop` write inside CodeMirror's measure phase (no animation library, no
// smooth behaviour, no looping), and the dim is a CSS opacity transition the
// global reduced-motion rule zeroes. (This sentence said "a one-shot
// `scrollIntoView`" until myne-md/myne#555; it has not been one since the
// measure-phase write replaced the transaction, and the distinction is the
// whole reason the write below is where it is.)

import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { Transaction, type Extension } from "@codemirror/state";

import { resolveScrollHost } from "./scroll-slack";

/** Walk up from the editor DOM to see whether focus-mode typewriter scroll is
 *  currently enabled (EditorChrome sets the attr = focusActive && pref). */
function typewriterEnabled(view: EditorView): boolean {
  return view.dom.closest('[data-focus-typewriter="true"]') !== null;
}

/** The re-centre decision, as a pure function so it can be held to its own
 *  rule without layout. `update()` is the adapter that fills it in.
 *
 *  The `userDriven` term is myne-md/myne#908 item 9: the plugin used to
 *  re-centre on ANY document change that was not a pointer selection, and an
 *  autosave echo arrives as a programmatic dispatch (the frontmatter `updated:`
 *  patch), so pausing to save moved the page under a reader who had not moved.
 *  A programmatic transaction carries no user event, which is exactly what this
 *  distinguishes. */
export function shouldRecenterOnChange(input: {
  selectionSet: boolean;
  docChanged: boolean;
  pointerSelection: boolean;
  userDriven: boolean;
  hasFocus: boolean;
  typewriterEnabled: boolean;
}): boolean {
  if (!input.selectionSet && !input.docChanged) return false;
  if (input.pointerSelection) return false;
  if (!input.hasFocus || !input.typewriterEnabled) return false;
  return input.userDriven;
}

/** True when at least one transaction in the update came from the user (typing,
 *  deleting, a keyboard caret move, paste, undo) rather than from code. */
export function transactionsAreUserDriven(
  transactions: readonly Transaction[],
): boolean {
  return transactions.some((t) => t.annotation(Transaction.userEvent) !== undefined);
}

/** The adapter the plugin calls: a ViewUpdate plus the two view facts, reduced
 *  to the decision. Extracted rather than inlined so the SPEC can drive the
 *  wiring with a real programmatic transaction, not just the predicate. An
 *  inlined `userDriven: transactionsAreUserDriven(...)` left the plugin free to
 *  pass `true` and every spec still green, which is exactly the vacuity a review
 *  caught. */
export function typewriterDecision(
  update: {
    selectionSet: boolean;
    docChanged: boolean;
    transactions: readonly Transaction[];
  },
  view: { hasFocus: boolean; dom: { closest(selector: string): Element | null } },
): boolean {
  return shouldRecenterOnChange({
    selectionSet: update.selectionSet,
    docChanged: update.docChanged,
    pointerSelection: update.transactions.some((t) =>
      t.isUserEvent("select.pointer"),
    ),
    userDriven: transactionsAreUserDriven(update.transactions),
    hasFocus: view.hasFocus,
    typewriterEnabled:
      view.dom.closest('[data-focus-typewriter="true"]') !== null,
  });
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
      const view = this.view;
      // Never re-center on a MOUSE selection/click. Scrolling mid-click moves the
      // content between mousedown and mouseup, which CM6 then reads as a drag —
      // selecting the span between the two click points. Typewriter centering is
      // for KEYBOARD caret movement + typing only; a mouse click places the caret
      // where the user aimed and must not yank the viewport.
      if (!typewriterDecision(u, view)) return;
      // Center the caret's line by writing the scroll host's `scrollTop` DIRECTLY
      // in CM's measure cycle — NOT by dispatching a `scrollIntoView`
      // transaction. A per-keystroke transaction redraws the selection (the brief
      // flash) and races CM's own post-edit scroll (the "doesn't always center /
      // gets stuck"). A measure-phase scroll write is flicker-free +
      // deterministic, and clamps cleanly at the document ends (can't over-center
      // near top/bottom).
      //
      // THE HOST, NOT `view.scrollDOM` (myne-md/myne#555). This wrote
      // `view.scrollDOM.scrollTop` — i.e. `.cm-scroller` — and in Myne
      // `.cm-scroller` never scrolls: the editor GROWS to fit its content inside
      // an outer bounded scroller on every client (`PaneView.tsx` on
      // desktop/web, `EditorFlow.tsx` on mobile), which is exactly what
      // `scroll-slack.ts` was written for and says in its own header. So the
      // write landed on an element whose `scrollHeight === clientHeight`, where
      // assigning `scrollTop` is a silent no-op, and typewriter scroll has never
      // moved anything on any client. Measured in the container: with the pref
      // and focus mode both on, after thirty typed lines the outer host had
      // scrolled to 358 (CodeMirror's ordinary scroll-into-view doing it) while
      // `.cm-scroller.scrollTop` was 0 and `.cm-scroller` had nothing to scroll
      // at all — the caret sitting 184px BELOW the centre of a 654px pane, which
      // is the no-pin position.
      //
      // `resolveScrollHost` is the same resolver `scroll-slack.ts` exports for
      // this, and its doc explains why asking `.cm-scroller` directly answers
      // "is it allowed to scroll" rather than "does it".
      view.requestMeasure({
        key: typewriterMeasureKey,
        read: () => {
          const host = resolveScrollHost(view);
          const head = view.state.selection.main.head;
          const block = view.lineBlockAt(head);
          // Block coordinates are relative to the document's top, so they are
          // translated into client space through `contentDOM`'s rect — the same
          // mapping `PaneView.tsx` uses to resolve the heading at the viewport
          // top. Going via client space is what makes this work for a host that
          // is NOT the editor's own scroller: the two live in different scroll
          // coordinate systems and only the viewport is common to both.
          const contentTop = view.contentDOM.getBoundingClientRect().top;
          const blockCenter = contentTop + (block.top + block.bottom) / 2;
          const hostRect = host.getBoundingClientRect();
          const hostCenter = hostRect.top + host.clientTop + host.clientHeight / 2;
          return { host, target: Math.max(0, host.scrollTop + blockCenter - hostCenter) };
        },
        write: ({ host, target }) => {
          if (!view.hasFocus || !typewriterEnabled(view)) return;
          host.scrollTop = target;
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
