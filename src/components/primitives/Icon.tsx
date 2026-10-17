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

/**
 * One frozen `{__html}` object per icon NAME, and **the identity is the whole
 * point** (myne-md/myne#894).
 *
 * React 19's reconciler compares `dangerouslySetInnerHTML` by OBJECT identity,
 * not by the `__html` string: `updateProperties`' default arm skips a prop only
 * when `nextValue === prevValue` (`react-dom-client`, the
 * `for (lastProp in nextProps)` loop). A fresh literal on every render therefore
 * makes React re-assign `domElement.innerHTML` on every render, which REPLACES
 * the `<path>` nodes. Nothing the user can see changes, and one thing breaks
 * completely silently: the browser dispatches no `click` when the mousedown and
 * mouseup targets are different nodes, so a control whose icon re-renders
 * between press and release does NOTHING.
 *
 * Measured, not reasoned, on the agent hub's "New conversation" (`agent-hub`
 * ah5): pointerdown landed on the icon's `<path>`, the Tooltip's own
 * mousedown/focus state change re-rendered the icon, the path node was
 * replaced, and no click event was dispatched at all. A scripted
 * `element.click()` still worked, which is exactly why this read as a
 * test-harness problem and cost an afternoon. Every button in the app is one
 * re-render away from the same dead control.
 */
const ICON_INNER_HTML = new Map<IconName, { __html: string }>();

function innerHtmlFor(name: IconName): { __html: string } {
  let cached = ICON_INNER_HTML.get(name);
  if (cached === undefined) {
    cached = { __html: ICON_PATHS[name] };
    ICON_INNER_HTML.set(name, cached);
  }
  return cached;
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
      dangerouslySetInnerHTML={innerHtmlFor(name)}
    />
  );
}
