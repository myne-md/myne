// The enrol gate, in the one place all three clients read it.
//
// Desktop had this predicate inline and correct; mobile had no predicate at all
// and offered "Add this device" to a phone that was already syncing, where
// pressing it mints a fresh `device_id` and strands a second pending record
// (myne-md/myne-mobile#38). The fix was to give the condition a home — so the
// table below is the contract that home owes, and it is asserted once rather
// than per client.

import { describe, expect, it } from "vitest";
import { ENROLL_NON_DISTINGUISHING_BANNER } from "../../src/lib/load-bearing-copy";

import {
  canAddThisDevice,
  type SyncStatusState,
} from "../../src/lib/enroll-gate";

/** Every `SyncRuntimeStatus` variant, plus the unread status. */
const CASES: Array<[SyncStatusState | undefined, boolean, string]> = [
  ["disabled", true, "no endpoint yet — this is where a fresh device starts"],
  ["not_enrolled", true, "endpoint, no identity — the case the form is FOR"],
  ["pending", false, "already queued; enrolling again strands a second record"],
  ["idle", false, "token on disk — this device is a member"],
  ["syncing", false, "a member, mid-cycle"],
  ["error", false, "a failed cycle is transport news, not a second registration"],
  ["conflicts", false, "a member with unresolved copies"],
  [undefined, false, "status unread — withhold rather than flash the form"],
];

describe("canAddThisDevice", () => {
  it.each(CASES)("%s → %s (%s)", (state, expected) => {
    expect(canAddThisDevice(state)).toBe(expected);
  });

});

// #268: the server says WHY it refused; the client used to throw that away.
//
// A frozen account and a hit device cap are 403s with an `error_code`, and both
// flattened into `Unauthenticated` → the non-distinguishing "Account number,
// password, or recovery phrase is incorrect" banner. The credentials were
// correct in both cases, so the instruction the app gave could never work.
//
// The non-distinguishing banner stays the DEFAULT — which of account number,
// password or phrase was wrong is an enumeration signal, and these three are
// only reachable AFTER the SCRAM proof has already succeeded.
describe("enrolment failure messages (#268)", () => {
  it("names the remedy for a refusal that is not a credential failure", async () => {
    const { failureMessageForTest } = await import(
      "../../src/components/sync/EnrollDeviceForm"
    );
    for (const kind of [
      "AccountFrozen",
      "DeviceLimitReached",
      "AwaitingApproval",
      "FingerprintMismatch",
    ]) {
      const msg = failureMessageForTest(kind);
      expect(msg, `${kind} must not use the credential banner`).not.toBe(
        ENROLL_NON_DISTINGUISHING_BANNER,
      );
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  it("still refuses to distinguish an actual credential failure", async () => {
    const { failureMessageForTest } = await import(
      "../../src/components/sync/EnrollDeviceForm"
    );
    for (const kind of ["Unauthenticated", "AccountMismatch", "BadRequest"]) {
      expect(failureMessageForTest(kind)).toBe(ENROLL_NON_DISTINGUISHING_BANNER);
    }
  });
});
