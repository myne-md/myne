// One write for a locally edited saved view (view-manifests task 8).
//
// A local edit is two facts and one decision:
//
//   - the definition, with its version settled by `withNextVersion` (a change
//     moves it forward, a no-op save does not);
//   - whether THIS DEVICE's approval should come along.
//
// The second half needs the care. Task 3's `set_view_approval(definition)` writes
// the definition and the approval of its version in ONE prefs write, which is
// what stops a user's own edit from leaving their own view unapproved. But it
// approves unconditionally, and a view this device has NOT approved is not the
// user's own: renaming or re-filtering one from the sidebar must not silently
// grant the approval the manager is still asking for. So the approval rides along
// only when it was already there; an unapproved view's edit is written without
// one, and it stays pending at its new version.
//
// Reading `approved` from the caller rather than re-reading prefs here keeps this
// a single write either way; the caller already holds the map (`usePrefs`).

import type { SavedView } from "../../lib/prefs";
import { upsertSavedView, setViewApproval } from "../../lib/prefs";
import { withNextVersion } from "./viewVersion";

/**
 * Persist a locally edited view. `previous` is the stored definition (the one
 * whose version the edit is ordered against) and `next` is the edited value.
 *
 * `approved` means "this device's approval names `previous`". When it does, the
 * definition and the approval of its new version land in one write; when it does
 * not, the definition lands alone and the view stays pending.
 */
export async function saveLocalViewEdit(
  previous: SavedView,
  next: SavedView,
  approved: boolean,
): Promise<SavedView> {
  const versioned = withNextVersion(previous, next);
  if (approved) {
    await setViewApproval(versioned.id, versioned.version, versioned);
  } else {
    await upsertSavedView(versioned);
  }
  return versioned;
}
