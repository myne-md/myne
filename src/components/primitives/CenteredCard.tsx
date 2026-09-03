// Centered single-column card shell — shared by FailClosedError and
// Unlock screens. Penpot canon: `screen------*` frames in
// page "4 — Desktop UI Kit"; all use the same envelope (centered card
// on `--bg-1` canvas, max-width 480, `--bg-2` fill + `--line-1`
// hairline + `--radius-2` + `--space-6` padding + `--space-4` row gap).

import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { HOVER_TRANSITION, hoverSurface } from "./hoverSurface";
import { fillingScrollRegionStyle, useScrollEdges } from "../../hooks/useScrollEdges";
import { stageRootStyle } from "./stageRoot";

interface CenteredCardProps {
  children: ReactNode;
}

// The stage envelope is shared; `stageRoot.ts` carries the 38px reasoning and
// the ancestor contract it replaces `100vh` with.
const ROOT_STYLE: CSSProperties = {
  ...stageRootStyle,
  background: "var(--bg-1)",
  fontFamily: "var(--font-sans)",
  padding: "var(--space-6)",
};

const CARD_STYLE: CSSProperties = {
  background: "var(--bg-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-6)",
  maxWidth: 480,
  width: "100%",
  // Bounded by the space the root was given, and no taller. The card itself does
  // NOT scroll and is NOT masked: see `SCROLL_STYLE` below.
  maxHeight: "100%",
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
};

/**
 * The scroller, INSIDE the card's padding rather than the card itself.
 *
 * Masking the card was the obvious shape and it was wrong twice over. A
 * `mask-image` clips the whole rendered box, so the card's own `--bg-2` fill,
 * its `--line-1` hairline and its `--radius-2` corners faded to transparent the
 * moment anything overflowed, which is exactly the chrome `docs/design/README.md`
 * defines a card by. And the fade band is `--space-5` against `--space-6` of
 * padding, so it sat entirely in the gutter: it dissolved the frame and faded
 * almost none of the content it was added for. `VaultPicker` had it right from
 * the start by masking its list.
 */
const SCROLL_STYLE: CSSProperties = {
  ...fillingScrollRegionStyle,
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
  // Negative insets so the scrollbar and the faded edges reach the card's
  // padding box, then re-applied as padding inside: the content still clears the
  // frame, and nothing is clipped a second time by the gutter.
  margin: "calc(var(--space-6) * -1)",
  padding: "var(--space-6)",
};

export function CenteredCard({ children }: CenteredCardProps) {
  // Soft edges once the content outgrows the window, for the same reason the
  // vault list has them: a hairline crop reads as a rendering fault, a fade
  // reads as "there is more this way". See `src/hooks/useScrollEdges.ts`.
  const { ref, fadeProps } = useScrollEdges<HTMLDivElement>();
  return (
    <div style={ROOT_STYLE}>
      <div style={CARD_STYLE}>
        <div ref={ref} style={SCROLL_STYLE} {...fadeProps}>
          {children}
        </div>
      </div>
    </div>
  );
}

export const CARD_TITLE_STYLE: CSSProperties = {
  fontSize: "var(--text-2xl)",
  lineHeight: "var(--leading-snug)",
  letterSpacing: "var(--tracking-tight)",
  fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
  color: "var(--fg-1)",
  margin: 0,
};

export const CARD_BODY_STYLE: CSSProperties = {
  fontSize: "var(--text-base)",
  lineHeight: "var(--leading-normal)",
  fontWeight: "var(--weight-regular)" as CSSProperties["fontWeight"],
  color: "var(--fg-2)",
  margin: 0,
};

/**
 * The card's primary call-to-action. Centered flex row with a `--space-2` gap so
 * an in-flight `<Spinner>` sits beside the label rather than displacing it — the
 * unlock surfaces all run multi-second Argon2id, and a CTA that just goes quiet
 * reads as a hung app.
 *
 * Pair with `ctaHover(disabled)` for the pointer feedback — the resting fill
 * lives here, the transient one there, and neither works without the other.
 */
export function ctaStyle(disabled: boolean): CSSProperties {
  return {
    background: disabled ? "var(--bg-3)" : "var(--accent)",
    color: disabled ? "var(--fg-3)" : "var(--accent-on)",
    border: disabled ? "1px solid var(--line-1)" : "none",
    borderRadius: "var(--radius-2)",
    padding: "var(--space-3) var(--space-5)",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-base)",
    fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
    cursor: disabled ? "not-allowed" : "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "var(--space-2)",
    transition: HOVER_TRANSITION,
  };
}

/**
 * Pointer feedback for a `ctaStyle()` button: hover deepens `--accent` to
 * `--accent-hover`, press goes one step further to `--accent-press`, leave and
 * release restore the resting fill. `docs/design/README.md`: background only —
 * no colour shift, no transform, no scale.
 *
 * Handlers rather than a stylesheet `:hover`/`:active`, for the reason
 * `hoverSurface.ts` documents at length: the app styles inline, and an inline
 * `background` always outranks a stylesheet rule, so a CSS hover would lose to
 * the button's own resting fill. Disabled returns empty handlers on every one of
 * the four, so a dimmed CTA never lights up under the pointer.
 */
export function ctaHover(disabled: boolean): {
  onMouseEnter?: (e: MouseEvent<HTMLElement>) => void;
  onMouseLeave?: (e: MouseEvent<HTMLElement>) => void;
  onMouseDown?: (e: MouseEvent<HTMLElement>) => void;
  onMouseUp?: (e: MouseEvent<HTMLElement>) => void;
} {
  const surface = hoverSurface({
    restBg: "var(--accent)",
    hoverBg: "var(--accent-hover)",
    disabled,
  });
  if (disabled) return surface;
  return {
    ...surface,
    onMouseDown: (e) => {
      e.currentTarget.style.background = "var(--accent-press)";
    },
    // Back to the HOVER fill, not the resting one: the pointer is still over the
    // button when the click releases, and dropping straight to `--accent` would
    // read as the button losing focus under the cursor. `onMouseLeave` owns the
    // return to rest.
    onMouseUp: (e) => {
      e.currentTarget.style.background = "var(--accent-hover)";
    },
  };
}
