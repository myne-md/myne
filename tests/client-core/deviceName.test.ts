// The self-naming policy, unit-tested (myne-md/myne#973).
//
// This module is the ONE answer both clients render from, so the gates are
// asserted here rather than only through a panel: a client that got the panel
// wiring right but passed a stale names map would still be caught by the "does
// not overwrite a name" case below.
//
// The security clause is the `pending` case. A name beside an unverified device
// reads as a trust signal while nothing verifies it, which weakens the SYNC-40
// eye-compare that is the actual defense (`decisions/sync/0348` clause 2).

import { describe, expect, it } from "vitest";
import {
  hasDeviceName,
  selfDeviceId,
  selfNameDevice,
  type DeviceRow,
} from "@myne/client-core/device-name";

const SELF = "aa11bb22cc33dd44ee55ff6677889900";
const OTHER = "bb22cc33dd44ee55ff6677889900aa11";

function row(over: Partial<DeviceRow> = {}): DeviceRow {
  return { device_id_hex: SELF, approved: true, retired: false, is_current: true, ...over };
}

/** The three injected seams, each recording what it was asked for. */
function seams(over: {
  baseline?: string | null;
  name?: string | null;
  writeRejects?: boolean;
} = {}) {
  const calls = { baseline: 0, suggest: 0, writes: [] as Array<[string, string]> };
  return {
    calls,
    input: {
      readBaseline: async () => {
        calls.baseline += 1;
        return over.baseline === undefined ? "ABCD-EFGH" : over.baseline;
      },
      suggestName: async () => {
        calls.suggest += 1;
        return over.name === undefined ? "Mac" : over.name;
      },
      writeName: async (id: string, name: string) => {
        calls.writes.push([id, name]);
        if (over.writeRejects === true) throw { kind: "Io" };
      },
    },
  };
}

describe("hasDeviceName", () => {
  it("treats an absent and a whitespace-only entry the same way", () => {
    expect(hasDeviceName({}, SELF)).toBe(false);
    expect(hasDeviceName(undefined, SELF)).toBe(false);
    expect(hasDeviceName({ [SELF]: "   " }, SELF)).toBe(false);
  });

  it("accepts a real name", () => {
    expect(hasDeviceName({ [SELF]: "Studio Mac" }, SELF)).toBe(true);
  });
});

describe("selfDeviceId", () => {
  it("finds the approved, non-retired, current row", () => {
    expect(selfDeviceId([row({ device_id_hex: OTHER, is_current: false }), row()])).toBe(SELF);
  });

  it("answers null for a roster that has not loaded", () => {
    expect(selfDeviceId(null)).toBeNull();
  });

  it("refuses a pending device, which must never name itself", () => {
    expect(selfDeviceId([row({ approved: false })])).toBeNull();
  });

  it("refuses a retired row: it has no token left to write with", () => {
    expect(selfDeviceId([row({ retired: true })])).toBeNull();
  });
});

describe("selfNameDevice", () => {
  it("names an approved, unnamed device from the suggestion", async () => {
    const { calls, input } = seams();
    await selfNameDevice({ devices: [row()], names: {}, ...input });
    expect(calls.writes).toEqual([[SELF, "Mac"]]);
  });

  it("does nothing while the roster has not loaded", async () => {
    const { calls, input } = seams();
    await selfNameDevice({ devices: null, names: {}, ...input });
    expect(calls).toEqual({ baseline: 0, suggest: 0, writes: [] });
  });

  it("never overwrites a name, and does not even look at the baseline", async () => {
    const { calls, input } = seams();
    await selfNameDevice({ devices: [row()], names: { [SELF]: "Studio Mac" }, ...input });
    expect(calls).toEqual({ baseline: 0, suggest: 0, writes: [] });
  });

  it("waits for a completed cycle: no adopted head means no prefs write", async () => {
    const { calls, input } = seams({ baseline: null });
    await selfNameDevice({ devices: [row()], names: {}, ...input });
    expect(calls.writes).toEqual([]);
    expect(calls.suggest).toBe(0);
  });

  it("treats a blank suggestion as not nameable rather than calling the writer", async () => {
    // The backend refuses a blank name (a cleared rename field reads as cancel), so
    // a call carrying one could not write and would only cost a round trip.
    const { calls, input } = seams({ name: "   " });
    await selfNameDevice({ devices: [row()], names: {}, ...input });
    expect(calls.writes).toEqual([]);
  });

  it("writes nothing when the platform is not nameable", async () => {
    const { calls, input } = seams({ name: null });
    await selfNameDevice({ devices: [row()], names: {}, ...input });
    expect(calls.writes).toEqual([]);
  });

  it("propagates a refused write instead of reporting success, and does not retry", async () => {
    const { calls, input } = seams({ writeRejects: true });
    // The policy used to swallow this. A write that fails and resolves is a wire
    // nobody can see, so the rejection travels and the caller logs it.
    await expect(selfNameDevice({ devices: [row()], names: {}, ...input })).rejects.toBeTruthy();
    // The attempt is recorded, so the rejection cannot read as "never tried".
    expect(calls.writes).toEqual([[SELF, "Mac"]]);
    expect(calls.baseline).toBe(1);
  });

  it("never names a pending device even with a completed cycle behind it", async () => {
    const { calls, input } = seams();
    await selfNameDevice({ devices: [row({ approved: false })], names: {}, ...input });
    expect(calls.writes).toEqual([]);
  });
});
