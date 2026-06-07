// `<ColorDot>` — the small color-label dot for a sidebar row (MYND-184).
//
// A solid 8px circle filled with the row's `--label-<slot>` token. Rendered
// leading the title (NoteRow) / following the icon (FolderRow). The title text
// stays in the ink ramp — the dot is the ONLY color the label introduces, per
// PRODUCT.md (no colored left-border, no title tint). Renders nothing when the
// row carries no color, so callers pass the raw `string | undefined` slot.

import type { CSSProperties } from "react";
import { labelColorVar } from "../decorations";

const DOT_STYLE: CSSProperties = {
  display: "inline-block",
  flexShrink: 0,
  width: 8,
  height: 8,
  borderRadius: "50%",
};

export function ColorDot({
  slot,
  style,
}: {
  slot: string | undefined;
  style?: CSSProperties;
}) {
  if (!slot) return null;
  return (
    <span
      aria-hidden="true"
      data-color-slot={slot}
      style={{ ...DOT_STYLE, background: labelColorVar(slot), ...style }}
    />
  );
}
