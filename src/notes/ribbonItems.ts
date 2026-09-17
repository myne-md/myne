// Left-ribbon item resolution (myne-md/myne#699).
//
// The rail pins an ordered list of registry command ids. Two things live here so
// the component stays a renderer:
//
//   1. `resolveRibbonItems` turns the stored `ribbon_items` pref into the list
//      the rail renders. The pref is an `Option` at the wire level: `null` means
//      the user never configured the rail (render the curated default), while
//      `[]` is a deliberately emptied rail and must STAY empty. That distinction
//      is the whole reason the field is not a plain array.
//   2. `ribbonEligibleIds` reads the eligible set off the registry, so the
//      roster and the rail agree on what can be pinned.
//
// Reorder reuses the shared `barItemsOrder` maths; the only thing this module
// does NOT reuse is `resolveBarOrder`, because that helper APPENDS every
// canonical id missing from the stored order (correct for a fixed-vocabulary bar,
// wrong for a pin list where unpinned means "not on the rail").

import { COMMAND_ACTIONS, RIBBON_DEFAULT_IDS } from "../commands";

/**
 * Resolve the stored `ribbon_items` against the eligible command ids.
 *
 * - `stored === null` → the curated default rail (`RIBBON_DEFAULT_IDS`).
 * - `stored === []` → empty.
 * - Any stored id not in `eligibleIds` is dropped (a command removed from the
 *   registry, matching the `resolveBarOrder` GC discipline); ids are deduped.
 */
export function resolveRibbonItems(
  stored: readonly string[] | null,
  eligibleIds: readonly string[],
): string[] {
  const raw = stored ?? RIBBON_DEFAULT_IDS;
  const known = new Set(eligibleIds);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of raw) {
    if (known.has(id) && !seen.has(id)) {
      out.push(id);
      seen.add(id);
    }
  }
  return out;
}

/** The ids a user is allowed to pin, in registry order: every action that
 *  declared a `ribbon` block. */
export function ribbonEligibleIds(): string[] {
  return COMMAND_ACTIONS.filter((a) => a.ribbon !== undefined).map((a) => a.id);
}
