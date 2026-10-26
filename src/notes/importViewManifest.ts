// Import one `.myneview` manifest: the ordered comparison, and the two writes it
// can lead to (view-manifests task 9).
//
// THE ORDERING IS THE WHOLE DESIGN. An id is not an instruction to overwrite. Four
// outcomes, and only one of them writes:
//
//   - no view with this id              → IMPORT (a new view; nothing to order);
//   - a higher version                  → REPLACE, and the replacement does NOT
//     approve itself: this device's approval names the version it was shown, so
//     new bytes are pending until the person here approves them;
//   - the same version, same definition → IDENTICAL, a no-op success. A repeated
//     download must not be an error dialog;
//   - the same version, different bytes → REFUSED. That is either a different
//     author reusing an id or a file changed after it was signed off, and a naive
//     "same id means update" would take it;
//   - a lower version                   → REFUSED, with both versions named.
//
// The comparison is by DEFINITION, not by version alone, and it uses the same
// fingerprint the version rule uses (`viewVersion.ts`), so "identical" here and
// "unchanged" on a save cannot disagree — both answer "would the canonical encoder
// emit the same bytes".
//
// The strict reader is the host's (`read_view_manifest`): this module never parses
// JSON, so the grammar has one authority. What it owns is the ordering, which
// needs the stored definition and this device's approval map.

import type { SavedView } from "../lib/prefs";
import { setViewApproval, upsertSavedView } from "../lib/prefs";
import { viewDefinitionFingerprint } from "./views/viewVersion";

/** What an arriving definition is, relative to the one this vault holds. */
export type ManifestOrdering =
  | { kind: "new"; incoming: SavedView }
  | { kind: "update"; incoming: SavedView; stored: SavedView }
  | { kind: "identical"; incoming: SavedView; stored: SavedView }
  | {
      kind: "sameVersionDifferentContent";
      incoming: SavedView;
      stored: SavedView;
    }
  | { kind: "older"; incoming: SavedView; stored: SavedView };

/**
 * Order `incoming` against `stored` (the definition this vault holds for the same
 * id, or `null`).
 *
 * `stored` comes from `prefs.saved_views` and `incoming` from the strict reader, so
 * both are already validated shapes; nothing here can admit one.
 */
export function compareIncomingManifest(
  incoming: SavedView,
  stored: SavedView | null,
): ManifestOrdering {
  if (stored === null) return { kind: "new", incoming };

  // An absent version cannot arrive from a file (the strict reader requires one),
  // so on this path both sides have one. Reading a missing stored version as 0 is
  // the fail-closed direction: any versioned file outranks a view this vault never
  // versioned.
  const incomingVersion = incoming.version ?? 0;
  const storedVersion = stored.version ?? 0;

  if (incomingVersion > storedVersion) {
    return { kind: "update", incoming, stored };
  }
  if (incomingVersion < storedVersion) {
    return { kind: "older", incoming, stored };
  }
  return viewDefinitionFingerprint(incoming) === viewDefinitionFingerprint(stored)
    ? { kind: "identical", incoming, stored }
    : { kind: "sameVersionDifferentContent", incoming, stored };
}

/**
 * Store an arriving definition WITHOUT approving it. The definition and its
 * version land; this device's approval still names the version it was shown, so
 * the view renders only once the person here approves the new one.
 *
 * A brand-new view has no approval entry to keep, so it is pending too — which is
 * the point of asking.
 */
export async function storeImportedView(incoming: SavedView): Promise<void> {
  await upsertSavedView(incoming);
}

/** Approve the version that was shown. One call, one field, nothing else. */
export async function approveImportedView(incoming: SavedView): Promise<void> {
  await setViewApproval(incoming.id, incoming.version);
}
