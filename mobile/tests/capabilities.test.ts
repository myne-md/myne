// The mobile capability descriptor (`mobile/src/platform/capabilities.ts`).
//
// Two things are worth testing here and nothing else is: that the three
// live-collab answers match desktop (which is this feature's whole reason for
// touching the descriptor), and that the closure the keyed record promises is
// real rather than asserted.

import { describe, expect, it } from "vitest";
import {
  ALL_CAPABILITIES,
  has,
  type Capability,
} from "../src/platform/capabilities";

describe("the live-collab answers", () => {
  it("answers all three the way desktop does", () => {
    expect(has("liveCollabPeerPresence")).toBe(true);
    expect(has("liveCollabAwarenessCursors")).toBe(true);
    expect(has("liveCollabMultiUser")).toBe(true);
  });
});

describe("the closure", () => {
  it("derives its roster from the shared keyed record, not from a hand list", () => {
    // Non-vacuity: a record that had silently shrunk would make every assertion
    // above pass against a smaller list.
    expect(ALL_CAPABILITIES.length).toBeGreaterThanOrEqual(37);
    expect(ALL_CAPABILITIES).toContain("liveCollabAwarenessCursors");
  });

  it("fails closed for a name the union does not carry", () => {
    // The descriptor is consulted by shared code, so an unknown name must be
    // ABSENT rather than accidentally available.
    expect(has("notACapability" as Capability)).toBe(false);
  });

  it("keeps the evidenced absences absent, so a flip is caught", () => {
    // Each of these is false for a reason recorded in the descriptor. Pinning a
    // few of them means a capability accidentally answered `true` fails here
    // rather than shipping an affordance against a command that refuses.
    expect(has("clipper")).toBe(false);
    expect(has("selfUpdate")).toBe(false);
    expect(has("detachedWindows")).toBe(false);
    expect(has("cliAccess")).toBe(false);
  });
});
