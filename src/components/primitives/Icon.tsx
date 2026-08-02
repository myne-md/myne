import type { CSSProperties } from "react";
import { ICON_PATHS, type IconName } from "../../lib/icons";

/** Horizontal directional glyphs that must MIRROR under RTL (`<html dir="rtl">`):
 *  chevrons, arrows and the sidebar panel toggles all point along the reading
 *  axis, so a collapsed-folder chevron, a back arrow or a "collapse-left" panel
 *  icon has to reverse. Vertical glyphs (`chevron-up/down`) and symmetric ones
 *  (search, check, x) are absent by design — they never flip. A call site can
 *  still force the decision with the `flip` prop (e.g. `flip={false}` for a
 *  chevron used purely decoratively). (SYNC-4.) */
const DIRECTIONAL_ICONS: ReadonlySet<IconName> = new Set<IconName>([
  "arrow-left",
  "arrow-right",
  "chevron-left",
  "chevron-right",
  "panel-left",
  "panel-left-close",
  "panel-right",
  "panel-right-close",
]);

interface IconProps {
  name: IconName;
  size?: number;
  /** Stroke width (default 1.5). Bump for small glyphs that read too thin
   *  (e.g. a checkmark inside a 16px checkbox). */
  strokeWidth?: number;
  /** Override RTL mirroring. Undefined (default) auto-mirrors the horizontal
   *  directional glyphs in {@link DIRECTIONAL_ICONS}; pass `false` to opt a
   *  directional glyph out (e.g. a chevron that already rotates via transform),
   *  or `true` to force-mirror one not in the set. Emits `data-flip`; the actual
   *  `scaleX(-1)` is a `[dir="rtl"] svg[data-flip]` rule in tokens.css, so an LTR
   *  locale never pays for it. */
  flip?: boolean;
  style?: CSSProperties;
}

export function Icon({
  name,
  size = 16,
  strokeWidth = 1.5,
  flip,
  style,
}: IconProps) {
  const mirror = flip ?? DIRECTIONAL_ICONS.has(name);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...(mirror ? { "data-flip": "" } : {})}
      style={{ flexShrink: 0, ...style }}
      dangerouslySetInnerHTML={{ __html: ICON_PATHS[name] }}
    />
  );
}
