// `useFocusTrap` — the React wrapper around the canonical focus-trap primitive
// (MYND-93). The trap behaviour itself (contain Tab/Shift-Tab, move focus in,
// pull focus back on escape, restore focus on teardown) lives ONCE in
// `trapFocus` (src/lib/imperative-focus-trap.ts); this hook is just the React
// glue — gate on `enabled`, resolve the ref to an element, map options, and
// hand the imperative release fn to React as the effect cleanup. There is a
// single trap implementation; the hook and the raw-DOM `trapFocus` callers
// share it.
//
// `ModalShell` consumes this internally so its callers get trap+restore for
// free; the carve-out modals (`SettingsModal`, `CommandPalette`) call it
// directly without inheriting ModalShell's dismiss semantics.

import { useLayoutEffect, type RefObject } from "react";
import { trapFocus } from "../lib/imperative-focus-trap";

export interface FocusTrapOptions {
  /** When false the trap is inert: no containment, no focus move, no restore. Default true. */
  enabled?: boolean;
  /** Element to focus on activation; defaults to the first focusable in the container. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Restore focus to the pre-activation element on teardown. Default true. */
  restoreFocus?: boolean;
}

export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  options: FocusTrapOptions = {},
): void {
  const { enabled = true, initialFocusRef, restoreFocus = true } = options;

  // Layout effect, not passive: teardown must restore focus in the SAME
  // synchronous turn that removed the dialog's DOM. A passive cleanup runs
  // after paint, so a driver (or a screen reader) can observe the intermediate
  // state where the modal is gone and focus has already fallen to `<body>`.
  // That race is what KN-4 and the web quick-picker scenario both hit on Esc.
  useLayoutEffect(() => {
    if (!enabled) return;
    const el = containerRef.current;
    if (!el) return;
    // `trapFocus` returns its release fn — hand it straight to React as the
    // effect cleanup (runs on deactivate / unmount), which restores focus.
    return trapFocus(el, {
      initialFocus: initialFocusRef?.current ?? null,
      restoreFocus,
    });
  }, [enabled, containerRef, initialFocusRef, restoreFocus]);
}
