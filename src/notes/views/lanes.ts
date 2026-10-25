// The board's lane derivation (myne-md/myne#922 task 4).
//
// A board is a projection, not a stored object: its lanes are the distinct
// values of the view's `group_by` property, and each card is a note the query
// engine already grouped. There is no board file and no per-card rank, which is
// the whole reason two devices cannot overwrite each other's board.
//
// The one thing the view DECLARES is an ORDER (`lanes` in the format). This
// module joins that declaration to the data, and the rules are deliberately
// small:
//
// - A declared lane comes first, in the declared order, and it renders even
//   when no card carries its value. "Drop a card into Done" has to be possible
//   before anything is done, so an empty lane disappearing would be the bug.
// - A value present in the data but absent from the declaration is APPENDED in
//   first-appearance order, so a new status never silently hides its cards.
// - Duplicates are collapsed to the first occurrence. The FORMAT preserves a
//   repeated value verbatim (`lanes` is a sequence, never deduplicated), but a
//   renderer that drew the same lane twice would be two views of one value.
// - A within-lane duplicate note is collapsed, the same rule the cards gallery
//   applies: the engine fans a list-valued property into several groups, and
//   one note appearing twice in one lane is one card.
//
// Pure and dependency-free beyond the shared `dedupeRowsByNote`, so the rules
// above are tested directly rather than through a render.

import type { ViewRow } from "../queryEngine";
import { dedupeRowsByNote } from "./viewLayout";

/** One lane: the group VALUE and the cards the lane holds. */
export interface BoardLane {
  /** The raw `group_by` value this lane stands for. `""` is the engine's
   *  "no value" group, and it is a lane like any other rather than a bucket to
   *  be hidden. */
  readonly value: string;
  /** The lane's cards, in the result's own order (the view's `sort` is already
   *  applied by the engine) with within-lane duplicates collapsed. Empty for a
   *  declared lane nothing carries yet. */
  readonly rows: readonly ViewRow[];
}

/** A group as the query engine reports it. Structural, so the derivation does
 *  not depend on the engine's wider `ViewResult` shape. */
export interface LaneGroup {
  readonly key: string;
  readonly rows: readonly ViewRow[];
}

/**
 * Join the view's declared lane order to the engine's groups.
 *
 * @param groups the engine's groups, already sorted within each group.
 * @param declared the view's `lanes`, or an empty array when it declares none.
 */
export function deriveLanes(
  groups: readonly LaneGroup[],
  declared: readonly string[] = [],
): BoardLane[] {
  // First occurrence wins for a repeated group key; the engine does not emit
  // one, and a renderer that summed two would double-count a lane.
  const rowsByValue = new Map<string, readonly ViewRow[]>();
  for (const group of groups) {
    if (!rowsByValue.has(group.key)) {
      rowsByValue.set(group.key, dedupeRowsByNote([...group.rows]));
    }
  }

  const lanes: BoardLane[] = [];
  const seen = new Set<string>();
  for (const value of declared) {
    if (seen.has(value)) continue;
    seen.add(value);
    lanes.push({ value, rows: rowsByValue.get(value) ?? [] });
  }
  for (const group of groups) {
    if (seen.has(group.key)) continue;
    seen.add(group.key);
    lanes.push({ value: group.key, rows: rowsByValue.get(group.key) ?? [] });
  }
  return lanes;
}
