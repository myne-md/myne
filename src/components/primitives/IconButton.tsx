// Square, token-only icon button (MYND-137).
//
// A bare icon affordance — the sidebar collapse chevrons and friends. Its
// appearance and states live in `@myne/client-core`'s `components.css` under
// `.myne-icon-btn` (myne-md/myne#773); this file is the semantic shell.
//
// The move fixed one thing it could not have fixed before: hover was applied
// from an `onMouseEnter` handler, so a keyboard user tabbing onto an icon-only
// control got the focus ring and no surface change. On a rail of identical
// glyphs the ring alone is a weak "you are here", so the stylesheet now pairs
// `:focus-visible` with `:hover`.
//
// Always carries an accessible label. It is ALSO mirrored to `title` — which is
// the native tooltip this repo is otherwise replacing with `<Tooltip>` (epic
// #772 lane 2c). Left as-is here on purpose: swapping it is a call-site
// migration with its own issue, not a side effect of the CSS move.

import type { Ref } from "react";
import { Icon } from "./Icon";
import { Tooltip } from "./Tooltip";
import type { IconName } from "../../lib/icons";
import { MIN_TARGET } from "./targetSize";

interface IconButtonProps {
  /** The button itself. React 19 passes `ref` as a prop, the same shape
   *  `Button.tsx` and `Input.tsx` already declare. */
  ref?: Ref<HTMLButtonElement>;
  icon: IconName;
  /** Accessible label — used for both `aria-label` and the hover `title`. */
  label: string;
  onClick: () => void;
  /** Icon glyph size (px). Default 16. */
  iconSize?: number;
  /** Dim + disable the button (no hover, no click). Default false. */
  disabled?: boolean;
  /** E2E observability hook (`data-testid`), SYNC-8 curated-prop pattern. */
  testId?: string;
  /**
   * Draw the control's own border and surface, for an icon control that floats
   * ON content rather than sitting in chrome. The graph pane's overlay cluster
   * had forked this component to get it (myne-md/myne#774) — a primitive nobody
   * can adapt is a primitive people keep re-implementing.
   */
  bordered?: boolean;
  /** Toggled-on state. Emits `aria-pressed`, which is also what paints it. */
  active?: boolean;
  /**
   * Transient confirmation state: the glyph becomes a tick and pops once, in
   * `--success` (2026-10-24). For a control whose whole job is "did that run?",
   * the answer belongs on the control rather than in a toast at the corner of
   * the screen. The CALLER owns the timer that clears it, and owes a live
   * region saying the same thing: a tick is invisible to a screen reader.
   *
   * **Passing it at all opts the control into the mechanism** (true OR false):
   * the stylesheet keys the two-way animation on that, so the tick arrives with
   * a pop and the copy glyph returns with a softer one instead of snapping back
   * when the timer clears. A caller that never confirms anything never sets it,
   * and its glyphs stay still.
   */
  confirmed?: boolean;
  /** Emits `aria-expanded`, for a control that opens a panel or menu. */
  expanded?: boolean;
  /**
   * Mirror `label` into the native `title` (default true).
   *
   * `HelperDisclosure` is the one caller that passes `false`: its trigger opens
   * its own popover on hover, so the OS chip arriving over that popover a
   * second later is a second surface saying the same thing, which is the
   * duplication the tooltip convention exists to remove. The `aria-label`
   * never depends on this either way.
   */
  nativeTitle?: boolean;
  /**
   * Show the label in a `<Tooltip>` rather than the native `title`
   * (myne-md/myne#775: ~1s delay, unstyled OS chip, clips at the window edge,
   * never appears on keyboard focus). Opt-in for now because wrapping every
   * call site in a portal-backed tooltip changes layout, and the conversion is
   * a ratchet rather than a flag day.
   */
  tooltip?: boolean;
}

export function IconButton({
  ref,
  icon,
  label,
  onClick,
  iconSize = 16,
  disabled = false,
  testId,
  bordered = false,
  confirmed = false,
  active,
  expanded,
  nativeTitle = true,
  tooltip = false,
}: IconButtonProps) {
  const button = (
    <button
      ref={ref}
      type="button"
      className="myne-icon-btn"
      data-bordered={bordered ? "true" : undefined}
      data-confirmed={confirmed ? "true" : undefined}
      data-copy-feedback={confirmed === undefined ? undefined : "true"}
      aria-pressed={active}
      aria-expanded={expanded}
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      // The minimum pointer target (WCAG 2.2 `target-size`) stays inline: it is
      // a LAYOUT constraint the call site may legitimately override for a dense
      // rail, and this file's rule is that layout lives at the call site.
      style={MIN_TARGET}
      aria-label={label}
      // The native attribute stays only on the un-tooltipped path, and only
      // until the call sites convert; `check-tooltip-convention.mjs` records
      // this file as exempt with that reason.
      title={tooltip || !nativeTitle ? undefined : label}
    >
      <Icon name={confirmed ? "check" : icon} size={iconSize} />
    </button>
  );
  return tooltip ? <Tooltip label={label}>{button}</Tooltip> : button;
}
