// The boot / post-delete / post-recovery routing DECISION, shared by every
// client (myne-md/myne#477).
//
// **What this module is, and what it deliberately is not.** myne-md/myne#477
// asks for two things at once that pull in opposite directions: the routing
// decision should have one implementation, and each client's navigation shape
// should stay its own. `decisions/clients/0488` is explicit that the
// screens SHOULD differ, so a shared `Stage` union would be the wrong answer:
// mobile has no `account-entry` and no `pending-approval`, and widening its
// union to hold two variants it can never reach would make every exhaustive
// switch in `mobile/src/app/flows/` carry a dead arm.
//
// So the split is at the decision, not at the screen. `bootDecision` answers
// "what did the probe find", in one place, and each client maps that answer to
// its own `Stage`. The mapping is six lines per client and is where the
// capability gates live, because a capability query is a fact about the HOST
// and this package is `seam: null`.
//
// **The measurement behind that split.** Before this module the two
// `initialStageFromProbe` implementations were byte-identical except for two
// expressions:
//
//   - the zero-vault arm: desktop `has("localOnlyVault") ? welcome
//     : account-entry`, mobile `welcome`
//   - the `Corrupted` arm: desktop `has("backup") ? unlock(Corrupted)
//     : account-entry`, mobile `unlock(Corrupted)`
//
// and mobile's two answers are exactly what desktop's gates produce when both
// capabilities are present, which on a Tauri client they always are. Everything
// else (slot priority with `Recovering` beating `Unlocked`, the fail-closed
// `err` arm, the 0 / 1 / >=2 count split, the per-status switch) was duplicated
// with no variance at all. That is the shape this module removes.
//
// **Post-delete and post-recovery are here by consequence rather than by a
// second implementation.** Post-delete routes through a reprobe on both clients
// (`vault-delete.ts` on each side), so once the probe decision is shared, the
// post-delete decision is too, and there is nothing further to unify. The
// post-recovery route is a constant, and both clients already agreed on it; it
// is named here so a change to it is a change to one line rather than to two
// files that nothing compares.

import type { IoFailureKind } from "./types/vault-unlock-error";
import type { SlotKind } from "./types/slot-kind";
import type { VaultListResult, VaultSummary } from "./types/vault-summary";

/** Canonical vault identifier on the TS side. Mirrors each client's `VaultId`. */
export type VaultId = string;

/** Runtime slot state per vault, as the boot probe reads it. */
export type SlotMap = Record<VaultId, SlotKind>;

/**
 * What the boot probe concluded, with no screen in it.
 *
 * Every variant is a state of the world rather than a destination, which is the
 * property that lets two clients with different screens share one decision. A
 * client maps this to its own `Stage`; two clients mapping the same variant to
 * different screens is a legitimate difference, and mapping it to different
 * screens for the same REASON is the drift this module exists to make visible.
 */
export type BootDecision =
  /**
   * A slot is `Recovering`: a chained recovery step was interrupted and is not
   * dismissible. Wins over `Unlocked` deliberately.
   */
  | { kind: "resume-recovery" }
  /** A slot is `Unlocked`: the session survives, go straight back to the editor. */
  | { kind: "resume-editor" }
  /**
   * The vault LIST itself failed to read. Fail-closed regardless of how many
   * vaults the client believes it has, because it cannot know.
   */
  | { kind: "list-io-error"; ioKind: IoFailureKind }
  /** No vaults on disk. What that MEANS is a per-client question (see below). */
  | { kind: "no-vaults" }
  /**
   * Exactly one vault (SYNC-7a: no picker for the single-vault user). Carries
   * the id so the single-vault path unlocks explicitly, in parity with the
   * picker path.
   */
  | { kind: "single-vault"; vaultId: VaultId; status: VaultSummary["status"] }
  /** Two or more vaults: the picker (SYNC-7a). */
  | { kind: "multiple-vaults" };

/**
 * The one implementation of the boot probe's routing decision.
 *
 * Maps the two boot probes (`vault_list` on disk, plus per-vault
 * `vault_slot_kind` on runtime) to a `BootDecision`. Pure, host-free, and
 * shared by every client (MYND-204, SYNC-4).
 *
 * **Slot priority first, unconditionally.** A non-Empty runtime slot pins the
 * decision regardless of disk state or vault count. Under SYNC-1 at most one
 * slot is non-Empty; the scan is defensive and lets `Recovering` win over
 * `Unlocked`, because the chained recovery step is not dismissible.
 */
export function bootDecision(vaultList: VaultListResult, slotMap: SlotMap): BootDecision {
  const slots = Object.values(slotMap);
  if (slots.includes("Recovering")) return { kind: "resume-recovery" };
  if (slots.includes("Unlocked")) return { kind: "resume-editor" };

  // All slots Empty (or no live slots): fall through to list-based routing. A
  // list-level IO failure is fail-closed regardless of count.
  if ("err" in vaultList) {
    return { kind: "list-io-error", ioKind: vaultList.err.detail.io_error_kind };
  }

  const vaults = vaultList.ok;
  if (vaults.length === 0) return { kind: "no-vaults" };
  if (vaults.length === 1) {
    return { kind: "single-vault", vaultId: vaults[0].id, status: vaults[0].status };
  }
  return { kind: "multiple-vaults" };
}

/**
 * Where a completed recovery lands, and where a cancelled one does.
 *
 * Constants rather than a function because there is nothing to decide: both
 * clients already answered identically, in two `LEGAL` tables nothing compared.
 * Naming them here makes a future change to either one edit instead of two,
 * and `SHARED_LEGAL` below is what holds the clients to them.
 */
export const POST_RECOVERY_SUCCESS_STAGE = "editor" as const;
export const POST_RECOVERY_CANCEL_STAGE = "unlock" as const;

/**
 * The legal `<stage>|<action>` transitions every client agrees on.
 *
 * **Measured, not asserted.** At extraction the desktop table held 23 rows and
 * mobile's 21, they shared 20 keys, and **not one** of those 20 routed
 * differently. The four that are not here are the whole real difference:
 *
 *   - `account-entry|create-vault.start` is desktop-only because its target stage
 *     is (`account-entry`). Screen difference, not a decision difference.
 *   - `editor|editor.awaiting-approval` was desktop-only when this table was
 *     extracted, for the same reason (`pending-approval` was a web-first
 *     surface). The mobile client gained that stage after a reported defect: a
 *     phone that lost its join overlay could never show the §6.3 compare code
 *     again, so the approver waited on a comparison nothing could make. The row
 *     is shared now; what stays per-client is the wait's EXIT, because mobile
 *     addresses it by action and desktop/web by reprobe.
 *   - `unlock|unlock.join-success` (desktop) against `editor|editor.join-success`
 *     (mobile) is deliberate and stays: desktop's join goes through `unlock`
 *     because `leaveActiveVault` has to tear the prior vault down first, while
 *     mobile re-addresses the load in place. Same destination, different
 *     origin, for a reason each client's own comment gives.
 *
 * A client composes its table as `{ ...SHARED_LEGAL, ...<its own rows> }`, so a
 * shared transition it silently retargets is an override that a test can see.
 * That test is the point: the twin inventory compares FILES, and two tables
 * that drift by one row are two files that differ in a hundred other ways
 * already.
 */
export const SHARED_LEGAL: Readonly<Record<string, string>> = Object.freeze({
  "create-vault|create-vault.auto-unlock-success": "editor",
  "create-vault|create-vault.commit-success": "unlock",
  "editor|editor.awaiting-approval": "pending-approval",
  "editor|editor.create-vault": "create-vault",
  "editor|editor.lock": "unlock",
  "editor|editor.restore-backup": "restore-backup",
  "editor|editor.switch-vault": "unlock",
  "picker|picker.create-vault": "create-vault",
  "picker|picker.join-success": "editor",
  "picker|picker.restore-backup": "restore-backup",
  "picker|picker.select-vault": "unlock",
  "recover|recover.cancel": POST_RECOVERY_CANCEL_STAGE,
  "recover|recover.complete-success": POST_RECOVERY_SUCCESS_STAGE,
  "unlock|unlock.back-to-picker": "picker",
  "unlock|unlock.restore-backup": "restore-backup",
  "unlock|unlock.resume-recovery": "recover",
  "unlock|unlock.start-recovery": "recover",
  "unlock|unlock.success": "editor",
  "welcome|create-vault.start": "create-vault",
  "welcome|welcome.join-success": "editor",
  "welcome|welcome.restore-backup": "restore-backup",
});
