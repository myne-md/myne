// Press-feedback for inline-styled interactive surfaces (myne-md/myne#732).
//
// The other half of `hoverSurface.ts`, split out rather than folded into it
// because the two are adopted independently: 34 files want hover and would have
// their behaviour changed under them if hover came with a press arm, and the
// surfaces that need press are the ones a user clicks expecting an answer.
//
// Why JS handlers and not a CSS class, the same reason `hoverSurface.ts`
// documents at length: the app styles inline, and an inline `background` always
// beats a stylesheet `:active` on specificity, so a class would silently lose to
// the element's own resting fill.
//
// Why POINTER events and not mouse events or `:active`. `:active` is the better
// signal where it is available, because it also fires on Space and Enter, which
// is why class-based controls take their press from the component layer
// (`client-core/src/components.css`, `.myne-btn:enabled:active`) and not from
// here. On an inline-styled element there is no such rule to lean on: a
// `mousedown` handler never fires for a keyboard user and does not fire reliably
// for touch, so a press built on it answers mouse users only. Pointer events
// cover mouse, touch and pen through one path, which is what lets one primitive
// serve desktop and mobile.
//
// The split, stated once so the next reader does not have to infer it: a
// class-based control takes its press from `.myne-btn` / `.myne-icon-btn` in the
// component layer, and an inline-styled surface takes it from here.

import { useCallback, useMemo, useState } from "react";
import type { PointerEvent } from "react";

/**
 * The neutral press step: one step past the hover ramp, toward the foreground.
 *
 * Deliberately NOT a token, and deliberately not `--line-1`, which
 * `docs/design/README.md` names and `design-notes/ui/0683` records the reason
 * for: `--line-1` is a hairline border, and the step measured in it is 9/255 on
 * light and dark but 18/255 on amoled, so the same rule lands twice as hard on
 * one theme. This mix holds roughly 17/255 in all three.
 *
 * The expression is duplicated by `.myne-btn` in `client-core/src/components.css`,
 * which cannot import from here, so `tests/components/pressSurface.test.ts` reads
 * that file and holds the two to the same string rather than trusting them to
 * stay in step. The canon and the code already disagreed silently once.
 */
export const NEUTRAL_PRESS_BG = "color-mix(in srgb, var(--bg-3), var(--fg-1) 8%)";

/** The accent press step, the same token the component layer deepens to. */
export const ACCENT_PRESS_BG = "var(--accent-press)";

interface PressSurfaceOpts {
  /** Background at rest, and the one a pointer-leave returns to. Default
   *  `transparent`, matching `hoverSurface`. Pass the control's resting fill (a
   *  selected row's `--paper-3`, say) so leaving restores it instead of clearing
   *  it. */
  restBg?: string;
  /** Background a pointer-RELEASE returns to. Defaults to `restBg`. Pass the
   *  hover fill when the surface also has hover: on release the pointer is still
   *  over the control, and dropping straight to the resting fill reads as the
   *  control losing focus under the cursor. */
  releaseBg?: string;
  /** Explicit press background. Defaults to `ACCENT_PRESS_BG` on an accent
   *  surface and `NEUTRAL_PRESS_BG` otherwise. */
  pressBg?: string;
  /** Accent surface, so the press uses the accent treatment. */
  accent?: boolean;
  /** Disabled control: no handlers at all, so nothing is even attached. */
  disabled?: boolean;
}

/** The handler subset the hook returns: the press half only, since a
 *  state-driven surface owns its own hover. Spelled out rather than derived from
 *  the full bag, because `interactiveSurface` imports this module and a type
 *  import back would make the two mutually dependent. */
type PressHandlers = {
  onPointerDown?: (e: PointerEvent<HTMLElement>) => void;
  onPointerUp?: (e: PointerEvent<HTMLElement>) => void;
  onPointerLeave?: (e: PointerEvent<HTMLElement>) => void;
  onPointerCancel?: (e: PointerEvent<HTMLElement>) => void;
};

/**
 * The same press step as `pressSurface`, delivered as React state instead of a
 * DOM mutation, for a surface whose background is COMPUTED from state.
 *
 * Why this exists rather than the spread: `pressSurface` mutates
 * `e.currentTarget.style.background`, which works only while nothing else writes
 * that property. A surface that derives its fill from React state re-applies the
 * whole style object on the next render, so any re-render during a press (a
 * parent, a sync tick, a list virtualising) erases the pressed fill mid-press.
 * That reads as a flicker, which is worse than no press feedback at all, so
 * these surfaces take the fact and fold it into the fill they already compute.
 *
 * The VALUE is not restated: `pressBg` comes from the same two constants
 * `pressSurface` uses, so there is still one place that decides what a press
 * looks like. Only the delivery differs.
 *
 *   const { pressed, pressBg, handlers } = usePressSurface({ disabled });
 *   <div style={{ background: pressed ? pressBg : hovering ? hover : rest }} {...handlers} />
 */
export function usePressSurface(opts: { accent?: boolean; disabled?: boolean } = {}): {
  /** True while the pointer is down on this surface. */
  pressed: boolean;
  /** The fill to use while `pressed`, from the one shared source. */
  pressBg: string;
  handlers: PressHandlers;
  /** For a LIST that shares one hover state (a picker whose `hoveredId` names a
   *  row): whether the row under `key` is the pressed one. */
  isPressed: (key: string) => boolean;
  /** The handlers for the row under `key`. Use these instead of `handlers` when
   *  more than one element in the render tree can be pressed. */
  handlersFor: (key: string) => PressHandlers;
} {
  const [pressedKey, setPressedKey] = useState<string | null>(null);
  const disabled = opts.disabled === true;
  const pressBg = opts.accent === true ? ACCENT_PRESS_BG : NEUTRAL_PRESS_BG;

  const handlersFor = useCallback(
    (key: string): PressHandlers => {
      if (disabled) return {};
      const clear = () => setPressedKey((k) => (k === key ? null : k));
      return {
        onPointerDown: () => setPressedKey(key),
        onPointerUp: clear,
        // Cancel is not covered by leave: a touch the system takes over (a scroll
        // gesture, an incoming call) cancels without ever leaving.
        onPointerCancel: clear,
        onPointerLeave: clear,
      };
    },
    [disabled],
  );

  const handlers = useMemo(() => handlersFor(""), [handlersFor]);
  const isPressed = useCallback(
    (key: string) => !disabled && pressedKey === key,
    [disabled, pressedKey],
  );

  return {
    pressed: !disabled && pressedKey !== null,
    pressBg,
    handlers,
    isPressed,
    handlersFor,
  };
}
/**
 * Spreadable pointer handlers that deepen an element's background on
 * pointer-down and restore it on release, leave or cancel. Spread onto any
 * inline-styled `<button>` or clickable `<div>`:
 *
 *   <button style={{ background: "transparent" }} {...pressSurface()}>…</button>
 *
 * The element keeps ownership of its resting `style.background`; these handlers
 * only mutate it transiently. Pair with `hoverSurface()` where the surface also
 * wants hover, and pass its hover fill as `releaseBg`, or use
 * `interactiveSurface`, which does the pairing for the common case.
 */
export function pressSurface(opts: PressSurfaceOpts = {}): PressHandlers {
  const { restBg = "transparent", releaseBg = restBg, accent = false, disabled = false } = opts;
  if (disabled) return {};
  const pressBg = opts.pressBg ?? (accent ? ACCENT_PRESS_BG : NEUTRAL_PRESS_BG);
  return {
    onPointerDown: (e) => {
      e.currentTarget.style.background = pressBg;
    },
    onPointerUp: (e) => {
      e.currentTarget.style.background = releaseBg;
    },
    // Cancel is not covered by leave: a touch the system takes over (a scroll
    // gesture, an incoming call) cancels without ever leaving, and without this
    // the pressed fill would stay until something else painted over it.
    onPointerCancel: (e) => {
      e.currentTarget.style.background = restBg;
    },
    onPointerLeave: (e) => {
      e.currentTarget.style.background = restBg;
    },
  };
}
