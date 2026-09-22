// Skip to content (myne-md/myne#728, task 9; WCAG 2.4.1).
//
// Ordering is the whole design here, and it is not arbitrary. This is the
// SECOND focusable element on the editor stage, after `ScreenCaptureEscape`,
// which keeps the first slot: on Windows that window can be a black rectangle
// and its escape hatch is the only way out of a data-loss path, so nothing may
// be placed in front of it. Read that component's header before reordering
// either of them.
//
// The target is the editor REGION rather than a hard-coded element id
// (`src/lib/regions.ts`): the same three regions F6 cycles, so "skip to
// content" and "focus the editor" cannot drift into meaning two different
// places. When the centre column holds nothing focusable the jump is simply
// a no-op, because `focusRegion` moves focus only when it found somewhere to
// move it to. Nothing here reads that answer, and the header used to imply
// it did.
//
// Visually hidden until focused, then drawn: the skip-link idiom, and the same
// `VISUALLY_HIDDEN` constant `ScreenCaptureEscape` and `ActionStatus` use. It
// is deliberately NOT `display: none` or `visibility: hidden`, either of which
// would take it out of the accessibility tree and make it unreachable by the
// keyboard user it exists for.

import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { VISUALLY_HIDDEN } from "./primitives/visuallyHidden";
import { enterRegion } from "../lib/regions";

const HIDDEN_STYLE: CSSProperties = {
  ...VISUALLY_HIDDEN,
  position: "absolute",
  top: 0,
  insetInlineStart: 0,
  // A clipped box still occupies its 1x1 slot in flow; taking it out of flow
  // keeps it from nudging the chrome by a pixel.
  padding: 0,
  border: 0,
  background: "transparent",
};

const FOCUSED_STYLE: CSSProperties = {
  position: "absolute",
  top: "var(--space-2)",
  insetInlineStart: "var(--space-2)",
  zIndex: 2000,
  width: "auto",
  height: "auto",
  overflow: "visible",
  clipPath: "none",
  whiteSpace: "nowrap",
  padding: "var(--space-1) var(--space-3)",
  background: "var(--bg-2)",
  color: "var(--fg-1)",
  border: "1px solid var(--accent)",
  borderRadius: "var(--radius-2)",
  boxShadow: "var(--shadow-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)",
  cursor: "pointer",
};

export function SkipToContent() {
  const { t } = useTranslation();
  const [focused, setFocused] = useState(false);
  return (
    <button
      type="button"
      data-testid="app.skip-to-content"
      style={focused ? FOCUSED_STYLE : HIDDEN_STYLE}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onClick={() => {
        // Blur first: the region's entry target takes focus next, and leaving
        // this button focused would keep it drawn over the content it just
        // jumped to if the move failed.
        setFocused(false);
        // `enterRegion`, not `focusRegion`, and the real-render run is what
        // settled it. A synchronous focus move from inside this handler does
        // not stick: the click that activates the link is followed by the
        // button's own blur and this component's re-render, and focus was
        // back outside the editor before the next frame. `e2e/a11y-keyboard`
        // AK-4 timed out waiting for the editor region with every other
        // assertion in the scenario green, which is what said the ordering
        // was right and the landing was not. Deferring past the current task
        // is the same fix the palette rows needed, for a close-enough reason,
        // and it makes this the third caller of one call shape rather than
        // the one exception.
        enterRegion("editor");
      }}
    >
      {t("common.skipToContent")}
    </button>
  );
}
