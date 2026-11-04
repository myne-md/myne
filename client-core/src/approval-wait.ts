// "This device was told it is pending approval, and nobody has said otherwise
// since." A device-local marker, set by the join and cleared by the approval.
//
// # Why a marker at all, when the token is the answer
//
// Because the answer is not always readable. `awaitingApprovalVerdict` used to
// derive the wait from `sync_status`, which derives it from `sync-state.json`
// plus the token store: `pending` = identity present, token absent. That is a
// clean pair and it is right whenever every read succeeds. myne-md/myne#535
// shipped on it, and a phone that had just joined sat in an empty editor with
// the compare it owed unreachable, because the derived status came back
// `not_enrolled` — a read that degrades silently (an unparseable state file
// reads as `None`, a vault root that does not resolve reads as "nothing is
// enrolled") and that answers with the SAME value as a device that never joined.
//
// The join itself has no such doubt. It is holding `pending: true` in its hand,
// from the server, at the moment it decides which screen to show. Writing that
// down is the one place the fact is known without inference, and it survives the
// process being killed, which is exactly the case the automatic route is for: a
// join overlay that the user closed, backgrounded, or lost to a crash.
//
// # Why this is not the "stored flag" the verdict's own comment rejects
//
// That objection is about a stored COPY of a server fact going stale while the
// server moves on, leaving two places that claim to know and one of them wrong.
// This marker is not that. It is a local note that says "the join put a vault on
// this device and its compare has not been answered", and what retires it is named
// rather than guessed:
//
//   - mobile writes it, in the join, and retires it on three acts and no others: a
//     match, a mismatch that un-enrols the device, or the user cancelling out of the
//     compare after the code has been SHOWN. It keeps it when the user leaves
//     before a code was shown, and an idle auto-lock keeps it too, because a head
//     arriving is not a comparison: a joined vault's first pull lands one on the
//     locked-to-unlocked edge, and retiring the marker on that reads as
//     "approved" for a device whose compare never happened.
//   - desktop and web neither write one nor read one. Their accept puts the vault on
//     the `pending-approval` stage at the moment it is accepted (`decisions/sync/0767`
//     names that route on both), so the question is answered by routing the user has
//     already been through and nothing has to be remembered. Mobile is the exception
//     because a person's vaults arrive LOCKED: the wait cannot be entered until the
//     vault is open, so the fact has to outlive the unlock. Add the writer when a
//     second client gains that shape, not a second retirement rule here.
//
// A stale one therefore costs an extra compare screen rather than a skipped
// mitigation, which is the failure direction `threat-model.md` §7 can absorb.
//
// # Storage
//
// `localStorage`, because it is the only store all three clients have that
// outlives a process without an IPC round trip: the web client has no vault
// directory to write, and a marker that needed `root_key` could not be read on
// the locked screen. Keys are per vault, since one device may hold several.

const PREFIX = "myne.approval-wait.";

function store(): Storage | null {
  try {
    // Absent under jsdom's node environment and in a Worker without a document;
    // a marker that cannot be stored must not throw into a join's success path.
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function key(vaultId: string): string {
  return PREFIX + vaultId;
}

/** Record that this device's join answered `pending`, for this vault. */
export function markApprovalWait(vaultId: string): void {
  try {
    store()?.setItem(key(vaultId), "1");
  } catch {
    /* quota or a denied store: the verdict falls back to its own reads */
  }
}

/** Retire the marker for this vault: the compare was answered, the device was
 *  un-enrolled, or the user cancelled out of a compare that had shown a code. */
export function clearApprovalWait(vaultId: string): void {
  try {
    store()?.removeItem(key(vaultId));
  } catch {
    /* nothing to do: a stale marker costs one screen, never a skipped compare */
  }
}

/** Did this device's join answer `pending` for this vault, with no approval since? */
export function isApprovalWait(vaultId: string): boolean {
  try {
    return store()?.getItem(key(vaultId)) === "1";
  } catch {
    return false;
  }
}
