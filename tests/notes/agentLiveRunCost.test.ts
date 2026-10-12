// @vitest-environment jsdom
//
// The run's cost is readable WHILE the run is working (myne-md/myne#456).
//
// `docs/decisions/ai/0515` rests the remote arm's lack of a volume bound on
// disclosure: "the residual is disclosed rather than capped: a finished run
// reports the requests it made, the notes it read, and how much text left the
// device". Rendering that only on a finished turn is what the entry said and it
// is not enough, because a run that does not finish has still spent its
// requests. Mobile makes that case ordinary rather than exotic: a run dies with
// the foreground, so locking the vault or pocketing the phone mid-run leaves a
// user who paid for several provider round-trips and was told about none of
// them.
//
// The claim under test is about the STORE rather than about a component, and
// deliberately so. `AgentProgress` reads these three fields directly, so a test
// that mounted it would be asserting that a component reads a prop; what can
// actually go wrong is the store not carrying a usable figure until the run
// settles. These tests are written against that.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  beginRun,
  clearAgent,
  currentRunEpoch,
  getAgent,
  openRun,
  reportRunProgress,
  settleStep,
} from "../../src/notes/agent/agentStore";
import type { AgentRunView } from "../../src/lib/agent-run";

const VIEW: AgentRunView = {
  runId: "r1",
  scopeTotal: 3,
  userGrants: 1,
  modelGrants: 0,
  cancelled: false,
};

/** A leg that has stopped, with the totals it spent. */
function settledLeg(
  iterations: number,
  notesRead: number,
  charsOffDevice: number | null,
  end: { kind: "finished" } | { kind: "cancelled" } = { kind: "finished" },
) {
  return {
    view: VIEW,
    proposal: { edits: [], newNotes: [], summary: "" },
    end,
    iterations,
    notesRead,
    charsOffDevice,
    excludedCount: 0,
  memoryUpdated: 0,};
}

beforeEach(() => clearAgent());
afterEach(() => clearAgent());

describe("reportRunProgress", () => {
  it("gives the surface a real figure while the run is still working", () => {
    beginRun(null);
    const epoch = currentRunEpoch();
    openRun(VIEW, epoch);

    // Before any report, this is the state the surface was in for the WHOLE
    // leg until myne-md/myne#456: a run in flight with nothing to disclose.
    expect(getAgent().iterations).toBe(0);
    expect(getAgent().charsOffDevice).toBeNull();

    reportRunProgress({ iterations: 1, notesRead: 1, charsOffDevice: 400 }, epoch);

    expect(getAgent().running).toBe(true);
    expect(getAgent().iterations).toBe(1);
    expect(getAgent().notesRead).toBe(1);
    expect(getAgent().charsOffDevice).toBe(400);
  });

  it("takes running totals rather than deltas, so a dropped message cannot under-report", () => {
    beginRun(null);
    const epoch = currentRunEpoch();
    openRun(VIEW, epoch);

    reportRunProgress({ iterations: 1, notesRead: 1, charsOffDevice: 400 }, epoch);
    // The host's SECOND report carries the leg's total, not the difference. A
    // receiver that summed would read 4 / 3 / 1150 here.
    reportRunProgress({ iterations: 3, notesRead: 2, charsOffDevice: 750 }, epoch);

    expect(getAgent().iterations).toBe(3);
    expect(getAgent().notesRead).toBe(2);
    expect(getAgent().charsOffDevice).toBe(750);
  });

  it("is dropped when the run it describes was let go of", () => {
    beginRun(null);
    const stale = currentRunEpoch();
    // A vault lock, a vault switch, "New chat", or a second run starting.
    beginRun(null);

    expect(
      reportRunProgress({ iterations: 9, notesRead: 9, charsOffDevice: 9999 }, stale),
    ).toBe(false);
    // The disclosure figure is exactly the number where a merged total would be
    // a false statement about how much text left the device, rather than a
    // cosmetic mix-up.
    expect(getAgent().iterations).toBe(0);
    expect(getAgent().charsOffDevice).toBeNull();
  });

  it("keeps the figures once the run stops, which is the case this exists for", () => {
    beginRun(null);
    const epoch = currentRunEpoch();
    openRun(VIEW, epoch);
    reportRunProgress({ iterations: 2, notesRead: 1, charsOffDevice: 500 }, epoch);

    // The user pressed Stop, or a phone locked the vault mid-run. The host
    // reports the leg it actually completed.
    settleStep(settledLeg(2, 1, 500, { kind: "cancelled" }), epoch);

    expect(getAgent().running).toBe(false);
    // Not 4 / 2 / 1000. The live report had already advanced the display to the
    // leg's total, so accumulating the settle onto it would count the leg
    // twice: and a doubled off-device figure is the disclosure control lying
    // in the direction that looks like caution.
    expect(getAgent().iterations).toBe(2);
    expect(getAgent().notesRead).toBe(1);
    expect(getAgent().charsOffDevice).toBe(500);
  });

  it("continues across legs rather than restarting at the second one", () => {
    beginRun(null);
    const epoch = currentRunEpoch();
    openRun(VIEW, epoch);

    // Leg one: the model asked to widen its scope.
    reportRunProgress({ iterations: 2, notesRead: 1, charsOffDevice: 500 }, epoch);
    settleStep(
      settledLeg(2, 1, 500, { kind: "finished" }),
      epoch,
    );

    // Leg two starts its own host-side counters at zero. Without the leg base
    // this first report would REPLACE the first leg's total, and the
    // disclosure figure would fall as the run progressed.
    reportRunProgress({ iterations: 1, notesRead: 2, charsOffDevice: 300 }, epoch);

    expect(getAgent().iterations).toBe(3);
    expect(getAgent().notesRead).toBe(3);
    expect(getAgent().charsOffDevice).toBe(800);
  });

  it("keeps a local run apart from a remote one that has sent nothing yet", () => {
    beginRun(null);
    const epoch = currentRunEpoch();
    openRun(VIEW, epoch);

    // `null` and `0` are different statements: "the run stayed on this device"
    // versus "the run is remote and has sent nothing yet", and `RunCostLine`
    // renders different sentences for them, so collapsing one into the other
    // reports the second as the first.
    reportRunProgress({ iterations: 1, notesRead: 1, charsOffDevice: null }, epoch);
    expect(getAgent().charsOffDevice).toBeNull();

    reportRunProgress({ iterations: 2, notesRead: 1, charsOffDevice: 0 }, epoch);
    expect(getAgent().charsOffDevice).toBe(0);
  });
});
