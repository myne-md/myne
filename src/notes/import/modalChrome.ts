// The import modal's body and footer geometry, in one place.
//
// Extracted from `ObsidianImportModal.tsx` (myne-md/myne#464) because a second
// setup step now needs it and the alternative was a copy. Copies of these two
// are not cosmetic drift: `BODY_STYLE` is what makes the body the scrolling
// region (`flex: 1`, `minHeight: 0`, `overflow: auto`) and `FOOTER_STYLE` is
// what keeps the actions pinned outside it (`flex: 0 0 auto`). A phase body that
// renders a bare `<div>` instead sits flush against the panel border and CLIPS
// rather than scrolling, which is exactly what the Myne setup step did: with a
// vault list, a credential, a label, a hint and three buttons, the Continue
// button was the part that went off the bottom.
//
// A module rather than an export from the modal itself, because the modal
// imports the setup steps: exporting from there and importing back would be a
// cycle.

import type { CSSProperties } from "react";

/** The scrolling region of a modal phase. Exactly one per phase. */
export const BODY_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "auto",
  padding: "var(--space-5)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
};

/** The pinned action row. Sits OUTSIDE the scrolling region, never inside it. */
export const FOOTER_STYLE: CSSProperties = {
  borderTop: "1px solid var(--line-1)",
  padding: "var(--space-3) var(--space-5)",
  display: "flex",
  justifyContent: "flex-end",
  gap: "var(--space-2)",
  flex: "0 0 auto",
};
