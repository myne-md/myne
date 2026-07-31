// `ThemeChiplet` — the 5-swatch custom-theme palette preview (mobile, MYND-598).
//
// A deliberate COPY of the desktop primitive (main repo
// `src/components/primitives/ThemeChiplet.tsx`), not a shared module: unlike the
// pure syntax-token derivation this file is a UI component, and the two clients'
// component layouts and sizing conventions differ (desktop composes from
// `var(--space-*)` / `var(--radius-*)`; mobile's grouped-list geometry is raw px
// and a taller touch row). What must NOT diverge is the five roles and their
// order — background, surface, foreground, accent, line — so a theme looks like
// itself on both clients.
//
// Decorative by definition: the colours are the content, and the theme's name is
// always rendered next to it — so the strip is `aria-hidden`.

import type { CSSProperties } from "react";

import type { ThemePalette } from "../lib/themes";

/**
 * Display-safe colour shapes: `#hex`, the `rgb()/rgba()/hsl()/hsla()` functions
 * over numeric arguments, and bare named colours.
 *
 * Deliberately NARROWER than `theme_validator`'s allowlist, and not a second
 * copy of that grammar — this decides only what may be painted as a swatch,
 * which is a much smaller question than what may be stored as a theme. Every
 * palette that reaches mobile was validated host-side before it was sealed, so
 * this never fires in practice; it is here because "the value is already
 * validated" is an assumption about a file written by another device, and a
 * swatch is not the place to bet on it.
 */
const DISPLAY_SAFE_COLOR =
  /^(#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([0-9.,%/\s+-]*\)|[a-z]+)$/i;

function displaySafeColor(value: string): string | null {
  return DISPLAY_SAFE_COLOR.test(value.trim()) ? value : null;
}

const CHIPLET_STYLE: CSSProperties = {
  display: "flex",
  width: 44,
  height: 28,
  borderRadius: 6,
  overflow: "hidden",
  border: "1px solid var(--line-2)",
  flex: "none",
};

/**
 * The five palette roles the strip previews, in paint order. Read off the
 * palette the list surface already returned — `vault.themes` is one blob, so the
 * entry in hand carries every colour this needs and there is nothing to fetch.
 * A role the palette omits renders as an empty cell rather than being dropped,
 * so the swatch count stays stable.
 */
const PREVIEW_ROLES = ["--paper", "--paper-2", "--ink-1", "--accent", "--line-1"];

export function ThemeChiplet({
  palette,
  testId,
}: {
  palette: ThemePalette;
  testId?: string;
}) {
  return (
    <span style={CHIPLET_STYLE} aria-hidden="true" data-testid={testId}>
      {PREVIEW_ROLES.map((role) => {
        const raw = palette[role] ?? "";
        const safe = displaySafeColor(raw);
        return (
          <span
            key={role}
            style={safe === null ? { flex: 1 } : { flex: 1, background: safe }}
            data-unsafe={safe === null && raw !== "" ? "true" : undefined}
          />
        );
      })}
    </span>
  );
}
