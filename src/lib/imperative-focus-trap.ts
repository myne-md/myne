// `trapFocus` — the imperative twin of the React `useFocusTrap` hook (MYND-93),
// for dialogs built with raw DOM rather than React (the in-WebView text prompt,
// the attachment lightbox / rename / diff-preview, the wikilink converter).
//
// Same four guarantees as the hook: move focus in on open, contain Tab/Shift-Tab,
// pull focus back if it escapes, restore focus to the pre-open element on
// teardown. Call it after the dialog is in the DOM; call the returned function
// when you tear the dialog down.

import { focusableWithin } from "./focusable";

export interface TrapFocusOptions {
  /** Element to focus on open; defaults to the first focusable in the container. */
  initialFocus?: HTMLElement | null;
  /** Restore focus to the pre-open element on release. Default true. */
  restoreFocus?: boolean;
}

/**
 * Trap keyboard focus inside `container`. Returns a release function that
 * removes the listeners and (by default) restores focus to whatever was
 * focused before the trap was installed.
 */
export function trapFocus(
  container: HTMLElement,
  options: TrapFocusOptions = {},
): () => void {
  const { initialFocus, restoreFocus = true } = options;
  const doc = container.ownerDocument;
  const previouslyFocused = doc.activeElement as HTMLElement | null;

  (initialFocus ?? focusableWithin(container)[0] ?? container).focus();

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const items = focusableWithin(container);
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = doc.activeElement;
    if (e.shiftKey) {
      if (active === first || !container.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !container.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  };

  const onFocusIn = (e: FocusEvent) => {
    const target = e.target as Node | null;
    if (target && !container.contains(target)) {
      (focusableWithin(container)[0] ?? container).focus();
    }
  };

  container.addEventListener("keydown", onKeyDown);
  doc.addEventListener("focusin", onFocusIn);

  return () => {
    container.removeEventListener("keydown", onKeyDown);
    doc.removeEventListener("focusin", onFocusIn);
    if (restoreFocus && previouslyFocused?.isConnected) {
      previouslyFocused.focus();
    }
  };
}
