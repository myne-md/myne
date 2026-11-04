// Is this device enrolled but still awaiting approval? (MYND-635, re-sited by
// myne-md/myne#535)
//
// # The question, and why it moved
//
// MYND-635 asked it at BOOT, from disk: `sync_status` reports `pending` when the
// device identity is present and the token is absent, and the join persists
// `device_id` before it enrols, so that pair looked like a clean answer.
//
// It is not one on the web client, and `design-notes/clients/0363` is why. The
// web token is session-scoped: `SessionTokenStore` keeps it in the Worker and
// writes it nowhere, so it dies with the tab, while `device_id` persists. So a
// fully approved browser reads as `pending` on every single reload, on the exact
// same two bytes of evidence as a device nobody has approved.
//
// Routing on that was a deadlock rather than a cosmetic error. The wait screen
// asks for no password; the only exit from pending is `try_claim_token`, which
// runs inside a sync cycle; and the cycle answers `NotReady` on a locked vault
// before it reaches the claim. Token needed unlock, unlock was unreachable, and
// the screen's one button re-probed into itself. 0363 had already written down
// the behaviour that was owed: "Every new tab re-authenticates: the user's
// password is needed again … and it is NOT accompanied by a re-approval prompt."
//
// # What tells the two apart
//
// Whether this device has ever adopted a head. `sync-protocol.md` §6.2 names
// exactly that as the discriminator: "The baseline that decides 'has a
// persisted baseline or not' is the `MYH1` device-local head-state of §7."
//
// * A device WITH a baseline has synced, so it was approved, and its vault holds
//   what it pulled. It belongs in the editor. This is 0363's reload case, and
//   0363 is explicit that it owes no re-approval prompt.
// * A device WITHOUT one has never synced. It has no notes to show and cannot
//   get any until an approval lands, and the cycle that approval enables will be
//   its FIRST head adoption: a TOFU bootstrap, which §6.2 requires the §6.3
//   fingerprint compare to cover on "**every** re-bootstrap, not only at first
//   enrolment". The wait screen is where that compare runs.
//
// # Why the verdict does NOT run a cycle to ask the server
//
// It cannot get an answer. `try_claim_token` collapses every failure into
// `None` (`core/src/plugins/sync/cycle.rs`): a transport that will not build, a
// handshake that never reached the server, and a server that refused approval
// are one value by the time the caller sees it. `None` becomes
// `CycleOutcome::NotReady`, which `sync_now` maps through `not_ready_reason`, a
// purely LOCAL disk read that answers `pending` for identity-present +
// token-absent and never consults the network.
//
// So "the server refused" and "the server was unreachable" are the same answer
// on the one path this verdict is ever asked about, and 0363 guarantees that
// path: a web tab never holds a stored token on reload. An earlier version of
// this module forced a cycle and read `pending` as a refusal, which routed an
// approved-but-offline device to a wait screen it could not leave. Both facts
// below are local reads instead, and neither can be made to lie by a network
// that is down.
//
// # Why this is still a read and not a stored flag
//
// Unchanged from MYND-635, and worth keeping: storing the verdict would move the
// bug rather than fix it. Two places would claim to know whether this device is
// approved, and the one that is wrong is the one nobody re-reads. The fact is
// the server's to state, and the token is how it states it.

import { invoke } from "../platform/core";
import { has } from "../platform/capabilities";
import type { SyncStatus } from "../hooks/useSyncStatus";

/**
 * Does this device owe the awaiting-approval wait?
 *
 * Call after unlock, once. Two things put it there, and neither is an inference
 * from disk: a cycle that RAN and was refused, and a cycle that claimed a token
 * for a device holding no adopted head, which is a TOFU bootstrap and owes the
 * §6.3 compare the wait screen runs.
 *
 * Answers `false` on every failure and on every other status, which is the
 * conservative direction here in both senses: a wrong `true` sends someone to a
 * wait screen for an approval they already have, and a wrong `false` leaves them
 * in the editor, where the sync indicator still reports the real state and the
 * Settings sync panel still offers the enrolment surface. The cost of the second
 * is an unexplained empty vault; the cost of the first is the dead end this
 * whole change exists to remove.
 */
export async function awaitingApprovalVerdict(): Promise<boolean> {
  // Answers `false` outright wherever a vault may be the only copy, which is the
  // desktop client. A desktop device can be pending too (enrol from Settings,
  // quit before another device approves), and routing it to a wait screen would
  // lock the user out of a vault that opens perfectly well: awaiting sync
  // approval does not block local use there, and the Settings sync panel already
  // shows the wait. The browser is the only client with nowhere else to put it
  // and nothing to do until the approval lands.
  //
  // The gate lives HERE rather than at the call site because this module is what
  // owns the meaning of each answer, and because a capability check inside a
  // `useEffect` is a routing policy in the one place no test can substitute a
  // capability set. The same rule used to live in `initialStageFromProbe`, where
  // `tests/stage/web-boot-routing.test.ts` drove it per client; it is driven per
  // client here instead (`tests/lib/pendingApprovalVerdict.test.ts`).
  if (has("localOnlyVault")) return false;
  // No marker read here, on purpose. The join's own answer is written down by the
  // client whose join it was (`@myne/client-core/approval-wait`), and that is
  // mobile: desktop and web install a vault that already exists on the device, so
  // neither has a join that could mark one. A read here would answer `false` on
  // every path, and the desktop arm above returns before it regardless.
  try {
    // 1. Has this device ever adopted a head? Asked FIRST, and the order is a
    //    correctness property rather than a preference.
    //
    // This is the discriminator `sync-protocol.md` §6.2 names for "has a
    // persisted baseline or not", and `sync_head_fingerprint` answers it from
    // the last recorded head observation, so `null` means this device has
    // adopted nothing. It is device-local: the server does not assert it, so a
    // server that manufactured a "no head" answer could only cost an extra
    // compare, never skip one.
    //
    // Asking the status first would let the scheduler decide the outcome. Its
    // own cycle is armed on the locked-to-unlocked edge (`web/wasm/src/
    // sync_loop.rs`), so if that cycle claims a token before a status read
    // lands, the status is no longer `pending` and an early return would skip
    // the baseline entirely, adopting a first head with no compare shown.
    //
    // A failed read counts as no baseline, which routes toward the compare. That
    // direction is chosen: the compare is what `threat-model.md` §7 records as
    // the only mitigation for the TOFU bootstrap, and a device sent to the wait
    // with a head already adopted sees its code and confirms it, while a
    // bootstrapping device that skips the wait loses the mitigation outright.
    //
    // One residual, stated rather than papered over: if that scheduler cycle
    // both claims AND completes its pull before this read, the baseline is
    // already non-null and the compare is skipped. The window is one local read
    // against a network round trip, and closing it properly needs a persisted
    // "compared head X" record, which is a device-local fact this client does
    // not keep.
    let baseline: string | null = null;
    try {
      baseline = await invoke<string | null>("plugin:sync|sync_head_fingerprint");
    } catch {
      /* stays null: fail toward showing the compare */
    }
    if (baseline !== null) {
      // Synced before, so approved before, and the vault holds what it pulled.
      // It belongs in the editor whatever the network is doing, and 0363 is
      // explicit that its reload owes no re-approval prompt.
      return false;
    }

    // 2. Is this device enrolled at all? A container with no enrolment is not
    //    waiting for anything: `sync_reset_local` leaves exactly that state, and
    //    routing it to an approval wait would answer a question the user already
    //    answered by un-enrolling.
    //
    // `pending` is identity-present + token-absent, and `idle`/`syncing`/
    // `conflicts` mean a token is held. Both are enrolled, and both owe the
    // compare while no head has been adopted: a held token with no head is a
    // device whose first adoption has not happened yet.
    const status = await invoke<SyncStatus>("plugin:sync|sync_status");
    return status.state !== "not_enrolled" && status.state !== "disabled";
  } catch (raw) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn(
        "[pending-approval] verdict read failed; staying in the editor (the sync indicator reports the real state):",
        raw,
      );
    }
    return false;
  }
}
