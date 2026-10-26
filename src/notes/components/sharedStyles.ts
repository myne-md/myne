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
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  fontWeight: "var(--weight-semibold)",
};

/**
 * The quiet caption that annotates rather than states: source labels, scope
 * counts, a run's cost. `--fg-3` ink at the smallest size, so it reads as an
 * aside next to the sentence it belongs to.
 */
export const CAPTION_STYLE: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
};

/**
 * The right-sidebar reader-surface card chrome shared by the Backlinks rows
 * (`<RightSidebar>`) and the Unlinked-mentions rows
 * (`<UnlinkedMentionsSection>`): `--bg-1` fill, `--line-1` hairline, 6px radius,
 * 10/11px padding. Spread this and override per-row (e.g. `display`/`cursor`).
 */
export const SIDEBAR_CARD_STYLE: CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "start",
  background: "var(--bg-1)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  padding: "10px 11px",
  margin: 0,
  cursor: "pointer",
  fontFamily: "inherit",
};

/**
 * The unfocused pane's dim (myne-md/myne#908 item 3).
 *
 * A split workspace had no visual difference between the pane holding the caret
 * and the others. The treatment is a BRIGHTNESS reduction on the pane itself,
 * not an overlay: an overlay has to pick a colour, and every colour that works
 * on one theme is wrong on another. A foreground wash LIGHTENS a dark pane
 * (which reads as a highlight rather than a recession, measured on AMOLED first,
 * then visible on dark too), and a black wash does nothing at all on AMOLED's
 * true black. Lowering the pane's brightness is the one operation that means
 * "this is not the active one" in every theme, including the pure-black one.
 *
 * `0.8` keeps the other pane readable, which is the point of having it open:
 * this dims, it does not hide.
 */
export function paneDimStyle(
  focused: boolean,
  paneCount: number,
): CSSProperties | null {
  if (focused || paneCount < 2) return null;
  return { filter: "brightness(0.8)" };
}
