// React binding for the shared overlay `inert` owner (myne-md/myne#728).
//
// The owner itself is imperative and module-scope (`src/lib/overlay-inert.ts`),
// because context menus and imperative modals are portalled outside every
// provider. This is the hook every React overlay uses so none of them has to
// know how the stack works, the same split `useFocusTrap` / `trapFocus` has.
//
// It is deliberately separate from `useFocusTrap` rather than folded into it:
// a focus trap contains Tab, `inert` removes the background from the page.
// Some surfaces want the first without the second (a non-modal popover that
// the user may click past), and folding them together would make that
// unexpressible.

import { useEffect, useState, type RefObject } from "react";
import { popOverlay, pushOverlay } from "../lib/overlay-inert";

export function useOverlayInert(
  ref: RefObject<HTMLElement | null>,
  enabled = true,
): void {
  // `node`, not `ref.current` read once. The effect's deps cannot see an
  // element that arrives on a LATER render, and that case is real rather
  // than theoretical: `SnapshotsPanel` calls this with `open` while its
  // render guard is `if (!open || noteId === null) return null`, so with
  // `open` true and `noteId` still null the backdrop is not mounted, the
  // effect runs against a null ref and returns, and nothing re-runs it when
  // the id arrives. The overlay is then never registered, the background
  // stays fully reachable, and the failure is silent in both directions:
  // no error, and an overlay that looks registered.
  //
  // `VaultSwitcher` paid for the identical trap one file over and fixed it
  // by widening its dep list; the shared hook had no such guard. A state
  // slot updated by a callback ref makes the node itself a dependency, so
  // the effect re-runs exactly when the element appears or is replaced.
  const [node, setNode] = useState<HTMLElement | null>(null);
  useEffect(() => {
    // Poll-free: re-read on every render, and only re-render when it moved.
    setNode((prev) => (prev === ref.current ? prev : ref.current));
  });
  useEffect(() => {
    if (!enabled || node === null) return;
    pushOverlay(node);
    return () => popOverlay(node);
  }, [node, enabled]);
}
