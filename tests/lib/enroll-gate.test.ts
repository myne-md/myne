// The enrol gate, in the one place all three clients read it.
//
// Desktop had this predicate inline and correct; mobile had no predicate at all
// and offered "Add this device" to a phone that was already syncing, where
// pressing it mints a fresh `device_id` and strands a second pending record
// (myne-md/myne-mobile#38). The fix was to give the condition a home — so the
// table below is the contract that home owes, and it is asserted once rather
// than per client.

import { describe, expect, it } from "vitest";

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

  it("says yes to exactly the two not-a-member states", () => {
    // The rows above each assert one state; this asserts the SHAPE — run the
    // whole enum through the predicate and pin the accepting set. A widened
    // gate (a `default: return true`, say) passes row-by-row review far more
    // easily than it passes this.
    const all: SyncStatusState[] = [
      "disabled",
      "not_enrolled",
      "pending",
      "idle",
      "syncing",
      "error",
      "conflicts",
    ];
    expect(all.filter((s) => canAddThisDevice(s))).toEqual([
      "disabled",
      "not_enrolled",
    ]);
  });
});
