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
 * Active traps, innermost last.
 *
 * Containment is enforced by a DOCUMENT-level `focusin` listener, so two live
 * traps would each yank focus back into their own container and ping-pong. Only
 * the innermost trap enforces; outer ones stay installed but inert until it is
 * released. Releasing out of order is fine — a trap removes itself by identity.
 *
 * Every trap in the app used to be opened by the same owner closing the previous
 * one first, so a stack was not needed. `ThemeInstallDialog` (MYND-567) breaks
 * that: it opens from an OS deep link, which can arrive over any modal the user
 * already had open.
 */
const activeTraps: { container: HTMLElement }[] = [];

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

  // Identity for this trap's slot on the stack. Only the innermost trap
  // enforces containment (see `activeTraps`).
  const self = { container };
  activeTraps.push(self);
  // Skip entries whose container has left the document. Release is effect
  // cleanup at every call site, so a stale entry should be unreachable — but if
  // one ever survived, an inert trap sitting on top would silently disable
  // containment for every LIVE trap, which is a worse failure than the
  // ping-pong this stack exists to fix.
  const isInnermost = () => {
    for (let i = activeTraps.length - 1; i >= 0; i -= 1) {
      const entry = activeTraps[i];
      if (entry.container.isConnected) return entry === self;
    }
    return false;
  };

  (initialFocus ?? focusableWithin(container)[0] ?? container).focus();

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Tab" || !isInnermost()) return;
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
    if (!isInnermost()) return;
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
    // Remove by identity, not `pop()`: traps can be released out of order.
    // Whatever is left on top becomes the enforcing trap again, and the
    // `restoreFocus` below is what puts focus back inside it.
    const at = activeTraps.indexOf(self);
    if (at !== -1) activeTraps.splice(at, 1);
    if (restoreFocus && previouslyFocused?.isConnected) {
      previouslyFocused.focus();
    }
  };
}
