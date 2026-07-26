// `ThemeChiplet` — the 5-swatch palette preview.
//
// One component so every surface that previews a theme shows the SAME five
// roles in the same order (background, surface, foreground, accent, line).
// Lifted out of `CustomThemesSection` when the deep-link install dialog
// (MYND-567) needed the same strip at a different size; `style` is the only
// thing that ever differed between the two.
//
// Decorative by definition — the colors are the content, and the theme's name
// is always rendered next to it — so it is `aria-hidden`.

import type { CSSProperties } from "react";
import type { ThemePreview } from "../../lib/themes";

/**
 * Display-safe colour shapes: `#hex`, the `rgb()/rgba()/hsl()/hsla()` functions
 * over numeric arguments, and bare named colours.
 *
 * Deliberately NARROWER than `theme_validator`'s allowlist, and it is not a
 * second copy of that grammar — this decides only what may be painted as a
 * swatch, which is a much smaller question than what may be stored as a theme.
 */
const DISPLAY_SAFE_COLOR =
  /^(#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([0-9.,%/\s+-]*\)|[a-z]+)$/i;

/**
 * A swatch colour, or `null` when the value is not something we are willing to
 * paint.
 *
 * Load-bearing for the deep-link install dialog (MYND-567): it previews a
 * palette that has NOT yet been through the host-side value-shape allowlist, so
 * without this an attacker-chosen `url(https://…)` would reach the DOM on a
 * mere link click. React assigns inline styles through the CSSOM, which already
 * refuses a second declaration (`red; position:fixed` is dropped wholesale) —
 * but `url(...)` survives that, and leaving it to the CSP's `img-src` alone
 * inverts the control ordering `threat-model.md` states, where the allowlist is
 * the PRIMARY guard. Already-stored palettes are validated, so this never fires
 * for them.
 */
function displaySafeColor(value: string): string | null {
  return DISPLAY_SAFE_COLOR.test(value.trim()) ? value : null;
}

const CHIPLET_STYLE: CSSProperties = {
  display: "flex",
  width: 40,
  height: 28,
  borderRadius: "var(--radius-1)",
  overflow: "hidden",
  border: "1px solid var(--line-2)",
  flex: "0 0 auto",
};

interface ThemeChipletProps {
  preview: ThemePreview;
  /** Overrides merged over the default chiplet chrome (size, radius, border). */
  style?: CSSProperties;
  "data-testid"?: string;
}

export function ThemeChiplet({ preview, style, ...rest }: ThemeChipletProps) {
  const swatches = [
    preview.background,
    preview.surface,
    preview.foreground,
    preview.accent,
    preview.line,
  ];
  return (
    <span style={{ ...CHIPLET_STYLE, ...style }} aria-hidden="true" {...rest}>
      {swatches.map((color, i) => {
        // A value we will not paint renders as an empty cell rather than being
        // dropped, so the swatch count stays stable and a hostile palette looks
        // obviously wrong instead of silently plausible.
        const safe = displaySafeColor(color);
        return (
          <span
            key={i}
            style={safe === null ? { flex: 1 } : { flex: 1, background: safe }}
            data-unsafe={safe === null && color !== "" ? "true" : undefined}
          />
        );
      })}
    </span>
  );
}
