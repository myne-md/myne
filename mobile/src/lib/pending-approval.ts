// Is this device enrolled but still awaiting approval? Mobile's half of
// `src/lib/pending-approval.ts` (myne-md/myne#535), which this client never got.
//
// # The defect this exists for, in this client's own terms
//
// `sync_join_account` fetches the account's real `vault.meta` and writes it
// BEFORE the enrolment that comes back pending (`core/src/plugins/sync/
// enroll.rs`, step 3), so a device nobody has approved yet presents an ordinary
// container. The waiting screen, its approval poll and the §6.3 fingerprint
// compare all lived inside `JoinFlow`'s own React state (`step`, `AppShell`'s
// `joinFrom`), which is the only place on this client a joining device can
// display its code. Lose that overlay once — the phone reclaims the WebView
// while the user walks over to the other device, or the pending screen's Cancel
// is pressed — and boot routing finds one healthy vault on disk and offers the
// unlock form. The password works, because the meta is the account's real one,
// the vault opens empty because a pending device holds no token, and the code
// can never be shown again: the approving device sits on "Verify the new device"
// with nothing to compare against, and the first background cycle claims the
// token and adopts a head with the compare silently skipped.
//
// That last clause is the half that matters. `threat-model.md` §7 records this
// eye-compare as the only mitigation for the TOFU bootstrap, and
// `sync-protocol.md` §6.2/§6.3 require it on every re-bootstrap. A restart is
// therefore not a lost screen, it is a way around the ceremony.
//
// # Why this client asks the question and desktop does not
//
// The shared twin bails out where `localOnlyVault` is present, and its own
// header gives the reason: on a desktop, awaiting sync approval does not block
// local use, the vault opens perfectly well, and the Settings sync panel already
// surfaces the wait. Every word of that is true here EXCEPT the last one: the
// mobile Settings panel carries only the APPROVER's side of the compare
// (`SyncSettingsPanels.tsx`, role `"approver"`), so a joining phone that lost
// the overlay has no surface left that can show its code. Routing it to the wait
// is therefore not an eviction from a usable vault, it is the only door back to
// the ceremony — and a still-pending device has no notes to be evicted from,
// since it cannot pull any.
//
// # The three reads, and why none asks the server
//
// A twin of `src/lib/pending-approval.ts`, and the ORDER is where the two differ:
// this file answers the join's marker before it reads the baseline, and the desktop
// one does not. The divergence is deliberate and one-sided: since
// `decisions/sync/0767` deleted the desktop join, nothing on desktop writes a marker
// at all, so there the question cannot arise; here the join is the only door in.
// Everything else is shared and kept identical on purpose: `try_claim_token`
// collapses a refused approval, an unreachable server and a transport that will not
// build into one `None`, so "the server refused" is not an answer this client can get.
// Every fact below is device-local, and none can be made to lie by a network
// that is down.
//
// 1. Did a JOIN say this device owes the compare? `@myne/client-core/approval-wait`
//    is written by the flow that installed the vault and holds the server's own
//    `pending`/`joined` answer, so it is the only one of the three that is known
//    without inference. Asked FIRST, because a head is not a comparison.
// 2. Has this device ever adopted a head? `sync_head_fingerprint` reads the last
//    recorded head observation, and §6.2 names exactly that as the "has a
//    persisted baseline" discriminator. Non-null means it synced, so it belongs in
//    the editor whatever the network is doing.
// 3. Is this device enrolled at all? `not_enrolled` and `disabled` are not
//    waiting for anything, and `sync_reset_local` leaves exactly that state, so
//    routing it to a wait would re-ask a question the user already answered.
//
// A failed read counts as no baseline, which routes toward the compare: the
// compare is the mitigation, so an unreadable answer must not route past it.
//
// **Why the marker outranks the baseline (this used to be the other way round).**
// The baseline is read on the locked-to-unlocked edge, and the sync loop arms its own
// cycle there too, so a joined vault's first pull could land a head before this
// verdict ran. Reading the baseline first answered "an approval has been
// observed" for a device whose compare had never happened, and retired the marker
// that owed it. That is the exact skip this file exists to prevent, on the one path
// where the device is a phone nobody can read a code off. The cost of the new order
// is a wait screen on every unlock until the compare is answered, which is the
// direction `threat-model.md` §7 can absorb and the direction the marker's own doc
// already claims.

import { invoke } from "../platform/core";
import { isApprovalWait } from "@myne/client-core/approval-wait";
import { HAS_TAURI } from "./app-window";
import type { SyncStatus } from "./use-sync-status";

/**
 * Does this device owe the awaiting-approval wait?
 *
 * Asked once on entering the editor stage. Answers `false` on every failure and
 * on every other status, which is the conservative direction in both senses: a
 * wrong `true` sends someone to a wait for an approval they already have, and a
 * wrong `false` leaves them in the editor, where the sync indicator still
 * reports the real state.
 *
 * `vaultId` is optional only for the tests that drive the two reads alone; the
 * shell always passes it. With it, the join's own answer decides FIRST (see
 * `@myne/client-core/approval-wait`): a join that installed a vault wrote that
 * down, and the derived status below is the read that answered `not_enrolled`
 * on a device that had just joined, which is how myne-md/myne#535 shipped a fix
 * that never fired on the phone.
 */
export async function awaitingApprovalVerdict(vaultId?: string): Promise<boolean> {
  // Browser dev has no IPC at all; every read below would reject and the
  // answer would be `false` anyway. Answered here so the dev console stays
  // quiet rather than logging a verdict read failure on every boot.
  if (!HAS_TAURI) return false;
  try {
    // The join's own answer first, and BEFORE the baseline read (myne#957
    // follow-up). A baseline is not a comparison: a joined vault's first pull can
    // land a head before this verdict runs, because the sync loop arms its own cycle
    // on the locked-to-unlocked edge, and reading the baseline first therefore
    // answered "an approval has been observed" for a device whose compare had never
    // happened and silently retired the marker that owed it. The marker is cleared by
    // the compare itself ("they match") and by a local un-enrol; never by a head
    // appearing.
    if (vaultId !== undefined && isApprovalWait(vaultId)) return true;

    let baseline: string | null = null;
    try {
      baseline = await invoke<string | null>("plugin:sync|sync_head_fingerprint");
    } catch {
      /* stays null: fail toward showing the compare */
    }
    if (baseline !== null) {
      // A baseline with no marker: an approved device (or one that joined before
      // markers existed). Nothing to retire, since the marker was already absent, and
      // that is why the check above answered first.
      return false;
    }

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
