import { useRef } from "react";
import type { PressEvt } from "../types";

/** How long a press must be held (ms) before it counts as a long-press. */
const HOLD_MS = 480;
/** How far the finger may drift (px) before the press is treated as a scroll
 *  and the pending long-press is cancelled. */
const MOVE_CANCEL_PX = 10;

/** The pointer/context handlers to spread onto a pressable element. Each takes
 *  a structural subset of its matching React DOM event (which carries a
 *  superset of `PressEvt`), so `{...handlers}` type-checks on a `div`/`button`. */
export type HoldHandlers = {
  onPointerDown: (e: PressEvt) => void;
  onPointerMove: (e: PressEvt) => void;
  onPointerUp: () => void;
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
export function useHold(onHold?: () => void): {
  handlers: HoldHandlers;
  consumeHeldClick: () => boolean;
} {
  const holdTimer = useRef<number | null>(null);
  const holdAt = useRef<{ x: number; y: number } | null>(null);
  const held = useRef(false);
  const clearHold = () => {
    if (holdTimer.current != null) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
    holdAt.current = null;
  };
  const handlers: HoldHandlers = {
    onPointerDown: (e) => {
      if (!onHold) return;
      held.current = false;
      holdAt.current = { x: e.clientX, y: e.clientY };
      holdTimer.current = window.setTimeout(() => {
        held.current = true;
        holdTimer.current = null;
        onHold();
      }, HOLD_MS);
    },
    onPointerMove: (e) => {
      const s = holdAt.current;
      if (
        s &&
        (Math.abs(e.clientX - s.x) > MOVE_CANCEL_PX ||
          Math.abs(e.clientY - s.y) > MOVE_CANCEL_PX)
      ) {
        clearHold();
      }
    },
    onPointerUp: clearHold,
    onPointerLeave: clearHold,
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
