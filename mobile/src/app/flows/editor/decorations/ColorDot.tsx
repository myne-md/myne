// `<ColorDot>` — the small color-label dot for a sidebar / list row (MYND-184 /
// MYND-516). Mobile-local twin of desktop's: a solid circle filled with the row's
// `--label-<slot>` token. Rendered leading a note title / following a folder
// glyph. The title text stays in the ink ramp — the dot is the ONLY color the
// label introduces (PRODUCT.md: no colored border, no title tint). Renders
// nothing when the row carries no color, so callers pass the raw slot.

import type { CSSProperties } from "react";
import { labelColorVar } from "@myne/decorations";

export function ColorDot({
  slot,
  size = 8,
  style,
}: {
  slot: string | undefined;
  size?: number;
  style?: CSSProperties;
}) {
  if (!slot) return null;
  return (
    <span
      aria-hidden="true"
      data-color-slot={slot}
      style={{
        display: "inline-block",
        flexShrink: 0,
        width: size,
        height: size,
        borderRadius: "50%",
        background: labelColorVar(slot),
        ...style,
      }}
    />
  );
}
