// @vitest-environment jsdom
//
// jsdom, not node, because the join's own answer is persisted in `localStorage`
// (`@myne/client-core/approval-wait`) and node's store is absent without
// `--localstorage-file`, which would make the marker silently a no-op and the
// three cases below pass for the wrong reason.
//
// The awaiting-approval verdict (myne-md/myne#535, mobile half).
//
// The failure this covers, in one line: a phone that lost its join overlay could
// never show the §6.3 compare code again, so the approving device waited on a
// comparison nothing could make while the phone sat on an unlock form whose
// password worked. The verdict is what routes it back to the wait.
//
// The cases below are the four answers that decide routing, and each one is a
// property rather than a branch count:
//   * an adopted head means approved, whatever the network or the token says;
//   * a failure to read the baseline must route TOWARD the compare, because the
//     compare is the mitigation (`threat-model.md` §7);
//   * an unenrolled or disabled container is waiting for nothing;
//   * no host at all answers `false` rather than logging a read failure per boot.
//
// The ORDER is asserted too, and it has two halves. Status-first would let the
// sync loop claim a token before the baseline is read, and an early return on that
// would skip the compare entirely. And the join's own marker outranks the baseline
// (myne#957 follow-up): a head is not a comparison, and a joined vault's first pull
// lands before this verdict runs.

import { beforeEach, describe, expect, it, vi } from "vitest";

let hasTauri = true;
vi.mock("../src/lib/app-window", () => ({
  get HAS_TAURI() {
    return hasTauri;
  },
}));

const invoke = vi.fn();
vi.mock("../src/platform/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

import { clearApprovalWait, isApprovalWait, markApprovalWait } from "@myne/client-core/approval-wait";
import { awaitingApprovalVerdict } from "../src/lib/pending-approval";

/** Answer the two reads the verdict makes, in order, by command name. */
function answers(map: {
  baseline: string | null | Error;
  status?: { state: string } | Error;
}): void {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "plugin:sync|sync_head_fingerprint") {
      if (map.baseline instanceof Error) throw map.baseline;
      return map.baseline;
    }
    if (cmd === "plugin:sync|sync_status") {
      if (!map.status) throw new Error("status should not be read here");
      if (map.status instanceof Error) throw map.status;
      return map.status;
    }
    throw new Error(`unexpected command ${cmd}`);
  });
}

beforeEach(() => {
  hasTauri = true;
  invoke.mockReset();
  clearApprovalWait("vault-a");
});

describe("awaitingApprovalVerdict", () => {
  it("answers false for a device that has adopted a head, without asking for a status", async () => {
    // The discriminator `sync-protocol.md` §6.2 names: a persisted baseline means
    // it synced, so it was approved, and it belongs in the editor whatever the
    // network is doing. `status` is left to throw, and the CALL LIST is asserted
    // rather than the return value alone: a status read here is the
    // skip-the-compare shape, and swapping the two reads still answers `false`
    // through the catch, so the return value cannot see it.
    answers({ baseline: "ABCD-1234" });
    await expect(awaitingApprovalVerdict()).resolves.toBe(false);
    expect(invoke.mock.calls.map(([cmd]) => cmd)).toEqual(["plugin:sync|sync_head_fingerprint"]);
  });

  it("asks for the baseline before the status, so a claimed token cannot skip the compare", async () => {
    answers({ baseline: null, status: { state: "pending" } });
    await awaitingApprovalVerdict();
    expect(invoke.mock.calls.map(([cmd]) => cmd)).toEqual([
      "plugin:sync|sync_head_fingerprint",
      "plugin:sync|sync_status",
    ]);
  });

  it("answers true for an enrolled device with no baseline", () => {
    answers({ baseline: null, status: { state: "pending" } });
    return expect(awaitingApprovalVerdict()).resolves.toBe(true);
  });

  it("answers true for a held token with no baseline", () => {
    // A token with no adopted head is a device whose first adoption has not
    // happened yet, so it still owes the compare.
    answers({ baseline: null, status: { state: "idle" } });
    return expect(awaitingApprovalVerdict()).resolves.toBe(true);
  });

  it("answers false when the container is enrolled in nothing", () => {
    answers({ baseline: null, status: { state: "not_enrolled" } });
    return expect(awaitingApprovalVerdict()).resolves.toBe(false);
  });

  it("answers false when sync is disabled", () => {
    answers({ baseline: null, status: { state: "disabled" } });
    return expect(awaitingApprovalVerdict()).resolves.toBe(false);
  });

  it("routes toward the compare when the baseline cannot be read", () => {
    // An unreadable answer must not be read as "already synced": the compare is
    // the mitigation, so the failure direction is the wait, never the editor.
    answers({ baseline: new Error("ipc down"), status: { state: "pending" } });
    return expect(awaitingApprovalVerdict()).resolves.toBe(true);
  });

  it("stays in the editor when both reads fail", () => {
    // The conservative direction for a status that cannot be read: a wrong `true`
    // sends someone to a wait for an approval they already have.
    answers({ baseline: new Error("ipc down"), status: new Error("ipc down") });
    return expect(awaitingApprovalVerdict()).resolves.toBe(false);
  });

  it("does not touch IPC at all with no host (browser dev)", async () => {
    hasTauri = false;
    await expect(awaitingApprovalVerdict()).resolves.toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  // The marker half (#535), and the order it holds against the baseline (myne#957
  // follow-up). The join writes down the answer it was told, because the derived
  // status answered `not_enrolled` for a phone that had just joined and this verdict
  // therefore never fired on the device that shipped it.
  describe("the join's own answer", () => {
    it("routes to the wait from the marker without asking anything", async () => {
      markApprovalWait("vault-a");
      // `answers` throws on any command it was not given, so a read here fails the
      // case rather than being merely unasserted: the marker is the only one of the
      // three facts that is known without inference, so it costs nothing to trust.
      answers({ baseline: null });
      await expect(awaitingApprovalVerdict("vault-a")).resolves.toBe(true);
      expect(invoke).not.toHaveBeenCalled();
    });

    it("keeps the marker when a head already exists, because a head is not a comparison", async () => {
      // The case that was silently skipped before this order: the first pull lands
      // on the locked→unlocked edge, so by the time this verdict runs the baseline
      // is non-null and the compare has still never happened. Retiring the marker
      // here is the skip `threat-model.md` §7 cannot absorb.
      markApprovalWait("vault-a");
      answers({ baseline: "ABCD-1234" });
      await expect(awaitingApprovalVerdict("vault-a")).resolves.toBe(true);
      // Retired by the compare ("they match"), by a local un-enrol, or by the
      // wait's own Cancel, and never by the passage of a head.
      expect(isApprovalWait("vault-a")).toBe(true);
    });

    it("stays in the editor when a head exists and no join wrote a marker", () => {
      answers({ baseline: "ABCD-1234" });
      return expect(awaitingApprovalVerdict("vault-a")).resolves.toBe(false);
    });

    it("is per vault, so one pending join does not route another vault", async () => {
      markApprovalWait("vault-a");
      answers({ baseline: null, status: { state: "disabled" } });
      await expect(awaitingApprovalVerdict("vault-b")).resolves.toBe(false);
    });
  });
});
