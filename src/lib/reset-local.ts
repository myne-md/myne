// Un-enrol this device, and REPORT a refusal rather than hiding it.
//
// # Why one helper
//
// Several surfaces call `plugin:sync|sync_reset_local`, and they did not agree on
// what a failure means. The SAS-mismatch escapes stay on screen and print the
// banner; one "start over" door swallowed the rejection and reset the screen
// either way, so a user who asked to leave an enrolment that would not leave got
// a UI that said it had. Its own comment claimed it was "the same handler as the
// SAS-mismatch escape above, deliberately", a second implementation described
// as one (test-audit #10/#65). That door went with the account-number join
// (`decisions/sync/0767`); this helper is why the survivors cannot repeat it.
//
// The failure mode is not cosmetic. This call is how a device stops trusting an
// endpoint it has decided is hostile or wrong, and the state a refusal leaves
// behind is "still enrolled". A screen that clears on a refusal tells the user
// the opposite of what is true. The pending door made that worse in a way worth
// naming: the enrolment stays, the enrol-gate treats `pending` as
// already-enrolled and hides the form, and the next reload lands the user back on
// the same screen having been told they had left it.
//
// # What the helper does NOT decide
//
// What a SUCCESS means. Closing a modal, clearing a form and keeping a card on
// screen are all correct, and they differ per surface. The boolean is the whole
// of the shared part: `true` when the reset landed, `false` when it did not.

import { invoke } from "../platform/core";

/**
 * Ask the backend to forget this device's enrolment.
 *
 * Returns `true` when the reset landed and `false` when it was refused. A caller
 * that ignores the `false` is reintroducing the defect this file exists to
 * remove, which is why the return value is a `boolean` rather than a
 * `void`-with-a-banner: the compiler cannot make a caller read it, but a
 * reviewer can see that it did not.
 */
export async function resetLocalOrReport(): Promise<boolean> {
  try {
    await invoke("plugin:sync|sync_reset_local");
    return true;
  } catch {
    return false;
  }
}
