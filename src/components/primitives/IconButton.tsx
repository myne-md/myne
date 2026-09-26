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

import { Icon } from "./Icon";
import type { IconName } from "../../lib/icons";
import { MIN_TARGET } from "./targetSize";

interface IconButtonProps {
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
}

export function IconButton({
  icon,
  label,
  onClick,
  iconSize = 16,
  disabled = false,
  testId,
}: IconButtonProps) {
  return (
    <button
      type="button"
      className="myne-icon-btn"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      // The minimum pointer target (WCAG 2.2 `target-size`) stays inline: it is
      // a LAYOUT constraint the call site may legitimately override for a dense
      // rail, and this file's rule is that layout lives at the call site.
      style={MIN_TARGET}
      aria-label={label}
      title={label}
    >
      <Icon name={icon} size={iconSize} />
    </button>
  );
}
