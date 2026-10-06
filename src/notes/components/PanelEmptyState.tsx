// Shared zero-state for the vault-collection panels (Trash / Archive).
//
// A thin adapter over the app-wide `<EmptyState>` since myne-md/myne#776. It
// used to be its own layout — a large muted glyph, a headline and one line —
// which was the right shape for two panels and the wrong place for it to live:
// the same three situations recur on a dozen surfaces, and each one had grown
// its own version. Keeping the name means Trash and Archive are untouched while
// the shape they use is now the one every surface uses.
//
// `firstRun` is the honest variant here. An empty Trash is not an error and it
// is not a filtered result; it is the collection in its resting state, which is
// what `firstRun` means — "there is nothing here yet, and here is what would
// put something here".
//
// ── It FILLS the panel ─────────────────────────────────────────────────────
// Both callers are 560 × min(78vh, 720px) modals, not sidebar sections. The
// first version of this adapter said "these panels are sidebar-width" and asked
// for `sm`, which was simply wrong about its own callers: the result was a
// ~200px bordered card pinned to the top of a 700px modal with the rest of the
// modal empty below it, so the box the user was looking at and the box the
// state was drawn in were two different rectangles with two different borders.
// `fill` makes the modal body the state — one border, the modal's own, and the
// `01` field across the whole of it.

import { EmptyState } from "../../components/primitives/EmptyState";
import type { IconName } from "../../lib/icons";

export function PanelEmptyState({
  icon,
  title,
  body,
  testId,
}: {
  icon: IconName;
  title: string;
  body: string;
  testId?: string;
}) {
  return (
    <EmptyState
      variant="firstRun"
      icon={icon}
      title={title}
      body={body}
      size="md"
      fill
      testId={testId}
    />
  );
}
