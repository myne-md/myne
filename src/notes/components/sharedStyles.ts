// Shared CSSProperties constants used by the notes sidebar UI
// (`<NoteList>`) AND the Editor's `<RightSidebar>` Backlinks header
// (`src/screens/Editor.tsx`). Extracted into its own module so the
// constant lives in one place and the consumer modules don't
// circularly import each other.

import type { CSSProperties } from "react";

/**
 * Uppercase letter-spaced eyebrow heading style used by all section
 * dividers in the Editor screen (sidebars). Visual token bundle:
 * `--fg-3` ink, 11px sans, 0.08em tracking, 600 weight.
 */
export const SECTION_HEADING_STYLE: CSSProperties = {
  fontSize: 11,
  color: "var(--fg-3)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  fontWeight: 600,
};
