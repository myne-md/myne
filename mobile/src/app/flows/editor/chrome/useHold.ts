import { useRef } from "react";
import type { PressEvt } from "../types";

/** How long a press must be held (ms) before it counts as a long-press. */
const HOLD_MS = 480;
/** How far the finger may drift (px) before the press is treated as a scroll
 *  and the pending long-press is cancelled. */
const MOVE_CANCEL_PX = 10;

/** A point the gesture reports, in client coordinates. */
export type HoldPoint = { x: number; y: number };

/**
 * The optional DRAG phase of the same press (owner, 2026-11-08): the row action
 * sheet's up/down arrows became hold-then-drag. `onEnd` is told whether the finger
 * moved, because a hold that never moved is still the sheet; and drift cancels the
 * press before the hold fires (a scroll) but is the drag itself afterwards.
 */
export type HoldDrag = {
  onStart: (point: HoldPoint) => void;
  onMove: (point: HoldPoint) => void;
  /** `moved` is false when the finger never left the press point. */
  onEnd: (point: HoldPoint, moved: boolean) => void;
};

/** The pointer/context handlers to spread onto a pressable element. Each takes
 *  a structural subset of its matching React DOM event (which carries a
 *  superset of `PressEvt`), so `{...handlers}` type-checks on a `div`/`button`. */
export type HoldHandlers = {
  onPointerDown: (e: PressEvt) => void;
  onPointerMove: (e: PressEvt) => void;
  /** Takes the release point: a drag's target is decided from where it left. */
  onPointerUp: (e: PressEvt) => void;
  onPointerLeave: () => void;
  onPointerCancel: () => void;
  onContextMenu: (e: { preventDefault: () => void }) => void;
};

/**
 * Long-press (touch) / right-click gesture, shared by the note-list rows
 * (`NoteRow`), the folder-tree rows (`FolderTreeRow`) and the favorites strip
 * (`FavoritesStrip`, MYND-597). A press held ~480ms without the finger drifting
 * more than ~10px (which would be a scroll, so it cancels) fires `onHold`; the
 * click that follows the release is swallowed via `consumeHeldClick()` so the
 * element's tap action (open the note) does not ALSO fire.
 *
 * The gesture is inert when `onHold` is absent — a row with no hold action can
 * spread the same handler bundle safely. Extracted from the two byte-identical
 * copies in `NoteRow` and `FolderTreeRow` when the strip became the third
 * caller (the ticket's "extract a shared hook" note).
 */
export function useHold(
  onHold?: () => void,
  drag?: HoldDrag,
): {
  handlers: HoldHandlers;
  consumeHeldClick: () => boolean;
} {
  const holdTimer = useRef<number | null>(null);
  const holdAt = useRef<HoldPoint | null>(null);
  const held = useRef(false);
  /** True between the hold firing and the release, and only when `drag` is set. */
  const dragging = useRef(false);
  const movedSinceHold = useRef(false);
  const clearHold = () => {
    if (holdTimer.current != null) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
    holdAt.current = null;
    dragging.current = false;
    movedSinceHold.current = false;
  };
  const handlers: HoldHandlers = {
    onPointerDown: (e) => {
      if (!onHold && !drag) return;
      held.current = false;
      dragging.current = false;
      movedSinceHold.current = false;
      holdAt.current = { x: e.clientX, y: e.clientY };
      holdTimer.current = window.setTimeout(() => {
        held.current = true;
        holdTimer.current = null;
        const at = holdAt.current;
        if (drag !== undefined && at !== null) {
          dragging.current = true;
          drag.onStart(at);
          return;
        }
        onHold?.();
      }, HOLD_MS);
    },
    onPointerMove: (e) => {
      const s = holdAt.current;
      if (dragging.current) {
        // The finger is already carrying a row: every move is a target change,
        // never a scroll, which is why the cancel below is skipped here.
        movedSinceHold.current = true;
        drag?.onMove({ x: e.clientX, y: e.clientY });
        return;
      }
      if (
        s &&
        (Math.abs(e.clientX - s.x) > MOVE_CANCEL_PX ||
          Math.abs(e.clientY - s.y) > MOVE_CANCEL_PX)
      ) {
        // Before the hold fires, drift means the user is scrolling the list.
        clearHold();
      }
    },
    onPointerUp: (e) => {
      if (dragging.current) {
        const moved = movedSinceHold.current;
        const at = { x: e.clientX, y: e.clientY };
        clearHold();
        drag?.onEnd(at, moved);
        // A hold that never moved is still the action sheet, and the click that
        // follows this release must not also open the note.
        if (!moved) onHold?.();
        return;
      }
      clearHold();
    },
    onPointerLeave: () => {
      // Releasing outside the row still ends the drag: the row keeps receiving
      // pointer events for the life of the gesture, so this only fires for a
      // gesture that never started, which is the scroll case.
      if (!dragging.current) clearHold();
    },
    onPointerCancel: clearHold,
    onContextMenu: (e) => {
      if (onHold) e.preventDefault();
    },
  };
  /** Call first in the element's `onClick`: returns `true` when this click is
   *  the tail of a long-press and must be swallowed (do not open). */
  const consumeHeldClick = (): boolean => {
    if (held.current) {
      held.current = false;
      return true;
    }
    return false;
  };
  return { handlers, consumeHeldClick };
}
