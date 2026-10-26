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
 * The unfocused-pane scrim (myne-md/myne#908 item 3).
 *
 * A split workspace had no visual difference between the pane holding the caret
 * and the others; the only cue was a 2px accent line on the focused pane, which
 * is easy to miss at a glance. The treatment is deliberately NOT a text dim: in
 * a notes app the other pane is usually there to be READ, so its note text keeps
 * full contrast. What dims is the pane's chrome and a very light wash over the
 * whole section, both of which the eye reads as "not the active one" without
 * making a line of prose harder to read.
 *
 * Returns `null` when there is nothing to contrast with (a single pane) or when
 * this pane IS the focused one, so the caller can render nothing at all rather
 * than an invisible overlay.
 */
export function paneScrimStyle(
  focused: boolean,
  paneCount: number,
): CSSProperties | null {
  if (focused || paneCount < 2) return null;
  return {
    position: "absolute",
    inset: 0,
    background: "var(--scrim)",
    // `--scrim` is the modal wash (0.4–0.6 alpha); at 6% of it the effect is a
    // few percent of ink, enough to separate the panes and far too little to
    // move a contrast ratio that matters.
    opacity: 0.06,
    pointerEvents: "none",
  };
}
