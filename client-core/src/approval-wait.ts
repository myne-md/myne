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
// This marker is not that. It is a local note that says "the join answered
// pending", it is cleared the moment the approval is observed (a non-null head
// fingerprint, or a self-approved join), and a stale one costs an extra compare
// screen the user can leave with one tap rather than a skipped mitigation. The
// failure direction is the one `threat-model.md` §7 can absorb.
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

/** Record that an approval has been observed, or that there is nothing to wait for. */
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
