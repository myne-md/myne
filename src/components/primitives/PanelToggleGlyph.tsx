// The sidebar toggle's glyph: ONE shape that changes, not two that swap.
//
// It used to be a swap through `<Icon>`: `panel-left` while the pane was
// collapsed, `panel-left-close` while it was open. Those are two different
// Lucide paths (the second adds an inward caret), and an SVG `d` does not
// interpolate, so no amount of CSS could have animated between them. The
// control popped between two unrelated icons while the pane it drives glides
// open beside it, which is the mismatch this replaces.
//
// So the outline is constant and the PANEL REGION fills: `currentColor` at full
// opacity while the pane is open, transparent while it is collapsed, with
// `fill-opacity` carrying the change. That is a single animatable number.
//
// Drawn here rather than through `<Icon>` because `Icon` hardcodes `fill="none"`
// and renders one path set with no room for an overlay. The OUTLINE is still the
// repo's Lucide copy (`ICON_PATHS`), so this holds no second copy of the
// geometry. What it does encode is WHERE the divider sits: `panel-left` rules at
// x=9 and `panel-right` at x=15, so the fillable strip is 6 units wide off the
// matching edge. The clip is what gives that strip the outline's own rounded
// outer corners; without it a square corner pokes past the `rx=2` curve.

import type { CSSProperties } from "react";
import { ICON_PATHS } from "../../lib/icons";

/**
 * Frozen `{__html}` objects, one per side — **identity, not immutability**
 * (myne-md/myne#894). React 19 compares `dangerouslySetInnerHTML` by object
 * identity, so a fresh literal per render re-assigns `innerHTML` and replaces
 * the nodes under it; the browser then fires no `click` when a mousedown and
 * mouseup straddle that render. `Icon.tsx` carries the full account and the
 * measurement.
 */
const PANEL_INNER_HTML = new Map<string, { __html: string }>();
function panelInnerHtmlFor(name: "panel-left" | "panel-right"): { __html: string } {
  let cached = PANEL_INNER_HTML.get(name);
  if (cached === undefined) {
    cached = { __html: ICON_PATHS[name]! };
    PANEL_INNER_HTML.set(name, cached);
  }
  return cached;
}

/**
 * @param collapsed whether the pane this toggles is currently collapsed. Drives
 *   the fill: empty while collapsed, filled while open.
 *
 * The fill transitions on `--duration-base`, which is `SidebarPane`'s own
 * width-collapse duration: the glyph and the pane are one gesture, and two
 * durations would read as two events. Reduced motion needs nothing here,
 * `tokens.css` zeroes `transition-duration` globally, so the fill snaps exactly
 * when the pane does.
 *
 * Both the duration and the 16px size are fixed rather than props. There is one
 * caller and it overrides neither, so a parameter here would be configurability
 * nothing has asked for; add one when a second caller needs a different answer.
 */
export function PanelToggleGlyph({
  side,
  collapsed,
}: {
  side: "left" | "right";
  collapsed: boolean;
}) {
  // At most one toggle per side is on screen, and both sides' clips are the same
  // shape anyway, so a stable id beats `useId()`, whose generated ids carry
  // colons, a known hazard inside a `url(#…)` reference.
  const clipId = `myne-panel-toggle-clip-${side}`;
  const fillStyle: CSSProperties = {
    fillOpacity: collapsed ? 0 : 1,
    transition: "fill-opacity var(--duration-base) var(--ease-standard)",
  };
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      // Reproduces what `<Icon>` would have applied: `panel-left` and friends are
      // in its `DIRECTIONAL_ICONS` set, so they mirror under RTL, and losing that
      // here would leave the toggle pointing the wrong way in an RTL locale. The
      // `scaleX(-1)` itself is a `[dir="rtl"] svg[data-flip]` rule in tokens.css.
      data-flip=""
      aria-hidden="true"
      data-testid="editor.sidebar-toggle-glyph"
      data-side={side}
      style={{ flexShrink: 0 }}
    >
      <defs>
        <clipPath id={clipId}>
          <rect x="3" y="3" width="18" height="18" rx="2" />
        </clipPath>
      </defs>
      <rect
        data-testid="editor.sidebar-toggle-fill"
        x={side === "left" ? 3 : 15}
        y={3}
        width={6}
        height={18}
        clipPath={`url(#${clipId})`}
        fill="currentColor"
        stroke="none"
        style={fillStyle}
      />
      <g dangerouslySetInnerHTML={panelInnerHtmlFor(side === "left" ? "panel-left" : "panel-right")} />
    </svg>
  );
}
