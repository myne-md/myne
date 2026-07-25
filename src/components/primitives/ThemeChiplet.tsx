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
      {swatches.map((color, i) => (
        <span key={i} style={{ flex: 1, background: color }} />
      ))}
    </span>
  );
}
