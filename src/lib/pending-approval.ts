// Is this device enrolled but still awaiting approval? (MYND-635)
//
// # Why boot has to ask at all
//
// The boot probe decides between "no vault → account entry" and "a vault → the
// unlock form" from two signals: what is on disk, and what the runtime slot
// holds. Neither can express awaiting-approval, and the reason is an ordering:
// `sync_join_account` fetches the account's real `vault.meta` and writes it
// **before** running the enrolment that comes back pending. So the disk says
// "an ordinary vault is here" while the truth is "this device cannot read a
// byte of it yet". A refresh empties the runtime slot, and boot then routed a
// device that can sync nothing to the unlock form — where the password works,
// because the meta is genuine, and the vault opens EMPTY.
//
// # Why this is a read and not a stored flag
//
// The pending state used to live in React state on the screen that showed it,
// which is exactly why a refresh erased it. Storing a flag instead would move
// the bug rather than fix it: two places would then claim to know whether this
// device is approved, and the one that is wrong is the one nobody re-reads.
//
// The fact is already on disk and already derived in one place. The join
// persists `device_id` unconditionally so a pending device can claim its token
// once approved, and it writes no token until it is. `sync_status` reads that
// pair — identity present, token absent — and answers `pending`. This module
// only asks it.

import { invoke } from "../platform/core";
import type { SyncStatus } from "../hooks/useSyncStatus";

/**
 * `true` when this device has enrolled against an account and is waiting for an
 * already-approved device to approve it.
 *
 * Answers `false` on any failure, which is the conservative direction here: a
 * client that cannot read its own status must not strand the user on a wait
 * screen with no exit. The cost of a wrong `false` is the pre-existing
 * behaviour (an unlock form); the cost of a wrong `true` is a dead end.
 */
export async function isPendingApproval(): Promise<boolean> {
  try {
    const status = await invoke<SyncStatus>("plugin:sync|sync_status");
    return status.state === "pending";
  } catch (raw) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn(
        "[pending-approval] status read failed; treating as not-pending (unlock routing applies):",
        raw,
      );
    }
    return false;
  }
}
