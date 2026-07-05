// Canonical focusable-element detection, shared by both focus traps (MYND-93):
// the React `useFocusTrap` hook (src/hooks/useFocusTrap.ts) and the imperative
// `trapFocus` helper (src/lib/imperative-focus-trap.ts). One definition so the
// two never disagree about what counts as tabbable.
//
// Detection is attribute-based, NOT layout/`offsetParent` (which is always null
// under jsdom) — so unit tests exercise the same code path as the real WebView.

export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
  '[contenteditable=""]',
].join(",");

/** Tabbable elements inside `container`, excluding `hidden` / `aria-hidden`. */
export function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(
    (el) =>
      !el.hasAttribute("hidden") && el.getAttribute("aria-hidden") !== "true",
  );
}
