// Roving tabindex (myne-md/myne#728). The companion primitive to the shared
// focus trap: where `trapFocus` contains Tab inside a dialog, this keeps exactly
// ONE element of a composite group in the Tab order and moves the active item
// with the arrow keys, so a region with hundreds of rows costs one Tab stop
// instead of hundreds.
//
// It is deliberately one implementation shared by every composite widget the
// accessibility pass touches (the note tab strips, the sidebar note listbox,
// the folder tree). A per-surface copy is how the three tablists drifted apart
// in the first place.
//
// Two surfaces, mirroring `trapFocus` / `useFocusTrap`:
//   - `rovingTargetIndex` is the pure key-to-index rule (unit-testable, no DOM).
//   - `useRovingFocus` is the React binding: it returns the container ref, the
//     container's keydown handler and the per-item `tabIndex`, leaving
//     activation (what "active" MEANS) to the caller.
//
// Focus is moved by the primitive, not left to the caller: changing `tabIndex`
// alone leaves DOM focus on the previously focused element, so the ring would
// stay behind while the state moved on, and the next arrow would move from the
// wrong place.

import { useRef, useState, type RefObject } from "react";

export type RovingOrientation = "horizontal" | "vertical" | "both";

/**
 * The index an arrow/Home/End key moves to, wrapping at the ends, or `null`
 * when the key is not a roving key for this orientation (so a caller can leave
 * it alone rather than swallowing it).
 *
 * `current` is clamped, because a group can render fewer items than the active
 * index (a filtered list) and returning `null` there would leave focus stuck.
 */
export function rovingTargetIndex(
  count: number,
  current: number,
  key: string,
  orientation: RovingOrientation = "both",
): number | null {
  if (count <= 0) return null;
  const here = current >= 0 && current < count ? current : 0;
  const forward =
    orientation !== "vertical" && key === "ArrowRight"
      ? true
      : orientation !== "horizontal" && key === "ArrowDown"
        ? true
        : null;
  if (forward !== null) return (here + 1) % count;
  const backward =
    orientation !== "vertical" && key === "ArrowLeft"
      ? true
      : orientation !== "horizontal" && key === "ArrowUp"
        ? true
        : null;
  if (backward !== null) return (here - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

/**
 * The subset of a keyboard event the primitive reads. Narrowed on purpose so a
 * caller can pass a synthesized event in a test without a DOM cast.
 */
export interface RovingKeyEventLike {
  key: string;
  preventDefault?: () => void;
  /**
   * The element the key came from. `target`, NOT `currentTarget`: the handler
   * is bound to the CONTAINER, so `currentTarget` is always the container and
   * a guard reading it would refuse every real press. That mistake was made
   * here first and three specs caught it.
   *
   * Optional so a unit test can synthesize an event without a DOM; absent
   * means "act", which keeps every existing caller's behaviour.
   */
  target?: unknown;
}

export interface UseRovingFocusOptions {
  /** How many items the group currently renders. */
  count: number;
  /** The active item's index. `-1` means "nothing active yet". */
  activeIndex: number;
  /**
   * Called when an arrow selects a new item. OPTIONAL, and inert under
   * `manualActivation`: there the arrows only move focus and the caller
   * activates on Enter or Space, so a callback passed alongside that flag
   * can never run. Both production callers are manual, and both passed a
   * real closure for one review round - the right-panel one read as writing
   * a pref on every arrow press, which is the exact behaviour the comment
   * beside it says was removed. Dead wiring that reads as live is worse than
   * none, so the option is omittable and the manual sites omit it.
   */
  onActiveIndexChange?: (index: number) => void;
  orientation?: RovingOrientation;
  /**
   * AUTOMATIC activation (the default) means an arrow both moves focus and
   * selects; MANUAL means the arrow only moves focus and the caller activates
   * on Enter or Space, which `activate` below is for.
   *
   * WAI-ARIA makes automatic the default only because switching panels is
   * usually cheap. It is not always: on the note tab strip each activation
   * re-points the editor body and persists workspace state, and on the
   * right-panel strip it WRITES A PREF, so arrowing from the first tab to the
   * eighth used to perform seven IPC writes on the way past. The pattern
   * explicitly sanctions manual activation exactly there.
   *
   * When this is `false` the hook keeps its own focused index, because the
   * caller's `activeIndex` deliberately stops moving: without that the next
   * arrow would compute from the last ACTIVATED tab rather than the focused
   * one, and focus would jump backwards.
   */
  manualActivation?: boolean;
  /**
   * CSS selector for the item elements inside the container, in DOM order. The
   * primitive focuses item N by position, so the selector must match exactly
   * `count` elements and no others (a trailing "add" chip carrying
   * `role="tab"` but no `data-tab-id` is excluded by the selector, not by
   * count).
   */
  itemSelector: string;
}

export interface RovingFocusBinding {
  /** Attach to the container element (the `role="tablist"` / listbox / tree). */
  containerRef: RefObject<HTMLElement | null>;
  /** Spread on the container element. */
  onKeyDown: (event: RovingKeyEventLike) => void;
  /** Spread on each item: exactly one item gets `0`, the rest get `-1`. */
  tabIndexFor: (index: number) => 0 | -1;
  /**
   * The index the arrows have moved focus to. Equal to the caller's
   * `activeIndex` under automatic activation; under manual activation it is
   * the hook's own, and it is what the caller activates on Enter or Space.
   */
  focusedIndex: number;
}

export function useRovingFocus({
  count,
  activeIndex,
  onActiveIndexChange,
  orientation = "both",
  manualActivation = false,
  itemSelector,
}: UseRovingFocusOptions): RovingFocusBinding {
  const containerRef = useRef<HTMLElement | null>(null);
  // Only consulted under manual activation. `null` means "the caller's
  // activeIndex still describes where focus is", which is the state after an
  // activation and after any external change of the active item, so focus
  // follows a tab opened or closed by something other than these arrows.
  const [focusOverride, setFocusOverride] = useState<number | null>(null);
  const lastActive = useRef(activeIndex);
  if (lastActive.current !== activeIndex) {
    lastActive.current = activeIndex;
    if (focusOverride !== null) setFocusOverride(null);
  }
  const focusedIndex =
    manualActivation && focusOverride !== null ? focusOverride : activeIndex;

  return {
    containerRef,
    focusedIndex,
    onKeyDown: (event) => {
      // Only act when the key came from one of the group's OWN items. The
      // handler sits on the container, so without this it swallows every
      // arrow that bubbles up from a descendant that needs them for itself:
      // a text input, a contenteditable, a nested list. Neither call site can
      // reach that today, which is exactly why the guard belongs in the
      // shared primitive rather than in the next caller's head.
      // `makeTreeKeydownHandler` guards the same way for the same reason.
      // `unknown` on the interface and narrowed here, because React types a
      // synthetic event's `target` as a bare `EventTarget`, which carries no
      // `closest`. A structurally-typed field would make every React handler
      // unassignable; a runtime narrow costs one check and lets a test pass a
      // plain object or nothing at all.
      const from = event.target;
      if (
        from !== null &&
        typeof from === "object" &&
        "closest" in from &&
        typeof (from as { closest: unknown }).closest === "function" &&
        (from as { closest: (s: string) => unknown }).closest(itemSelector) === null
      ) {
        return;
      }
      const target = rovingTargetIndex(count, focusedIndex, event.key, orientation);
      if (target === null || target === focusedIndex) return;
      event.preventDefault?.();
      const items = containerRef.current?.querySelectorAll<HTMLElement>(itemSelector);
      items?.[target]?.focus();
      if (manualActivation) setFocusOverride(target);
      else onActiveIndexChange?.(target);
    },
    // When nothing is active, the FIRST item carries the Tab stop, so entering
    // the region by Tab lands somewhere real rather than nowhere. Keyed off
    // the FOCUSED index so that under manual activation, leaving and
    // re-entering the group by Tab returns to where the arrows left off
    // rather than to the still-active tab.
    tabIndexFor: (index) => (index === (focusedIndex === -1 ? 0 : focusedIndex) ? 0 : -1),
  };
}
