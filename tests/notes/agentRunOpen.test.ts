// @vitest-environment jsdom
//
// The run becomes addressable while it is still working (myne-md/myne#544).
//
// `agent_start` returns only when the loop has stopped, which on a remote
// provider is minutes, and its reply used to be the only thing that ever
// carried a run id. So the whole first leg was a `running` run with no `view`,
// and `AiChatTab` mounts `AgentProgress` on `view !== null` — no status, no
// running scope total, and no Stop, on a run that is at that moment sending
// note text to a provider. `AgentProgress`'s own module note calls the scope
// total "continuously" shown; during the first leg it was not shown at all.
//
// `openRun` is the host saying "the run exists" through `agentStart`'s channel
// before the loop is driven. Two properties are load-bearing and neither is
// visible from the call site: the run must stay `running` (this is the same
// step reporting that it started, not a step settling), and the epoch guard
// must be the same one `settleStep` uses, or a run the user let go of
// mid-flight repopulates the store behind them.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  beginRun,
  clearAgent,
  currentRunEpoch,
  getAgent,
  openRun,
  resumeRun,
  settleStep,
} from "../../src/notes/agent/agentStore";
import type { AgentRunView } from "../../src/lib/agent-run";

const VIEW: AgentRunView = {
  runId: "r1",
  scopeTotal: 7,
  userGrants: 1,
  modelGrants: 0,
  cancelled: false,
};

beforeEach(() => clearAgent());
afterEach(() => clearAgent());

describe("openRun", () => {
  it("gives the surface the run id while the run is still working", () => {
    beginRun(null);
    const epoch = currentRunEpoch();
    expect(getAgent().view).toBeNull();

    expect(openRun(VIEW, epoch)).toBe(true);

    expect(getAgent().view).toEqual(VIEW);
    expect(getAgent().running).toBe(true);
    // The number `AgentProgress` shows continuously, and the whole bound on
    // scope accumulation, is readable now rather than when the run ends.
    expect(getAgent().view?.scopeTotal).toBe(7);
  });

  it("is dropped when the user let go of the run while it was in flight", () => {
    beginRun(null);
    const epoch = currentRunEpoch();
    // A vault lock, a vault switch, or "New chat": every one of them bumps the
    // epoch, and the host's channel message is still on its way.
    clearAgent();

    expect(openRun(VIEW, epoch)).toBe(false);
    expect(getAgent().view).toBeNull();
  });

  it("is dropped when a SECOND run started while the first was in flight", () => {
    beginRun(null);
    const first = currentRunEpoch();
    beginRun(null);

    expect(openRun(VIEW, first)).toBe(false);
    expect(getAgent().view).toBeNull();

    // ...and the second run's own message lands.
    expect(openRun(VIEW, currentRunEpoch())).toBe(true);
    expect(getAgent().view).toEqual(VIEW);
  });

  it("does not settle the run: the step that follows still writes the end", () => {
    beginRun(null);
    const epoch = currentRunEpoch();
    openRun(VIEW, epoch);

    settleStep(
      {
        view: { ...VIEW, scopeTotal: 9 },
        proposal: { edits: [], newNotes: [], summary: "" },
        end: { kind: "stalled", barrenIterations: 3 },
        iterations: 4,
        notesRead: 1,
        charsOffDevice: 120,
        excludedCount: 0,
      memoryUpdated: 0,},
      epoch,
    );

    expect(getAgent().running).toBe(false);
    expect(getAgent().end).toEqual({ kind: "stalled", barrenIterations: 3 });
    expect(getAgent().view?.scopeTotal).toBe(9);
  });
});

describe("resumeRun", () => {
  it("clears the awaiting-scope end, so the dialog that asked unmounts", () => {
    // myne-md/myne#559. The scope-expansion dialog derives its visibility from
    // `end?.kind === "awaitingScope"`. Leaving `end` alone kept it on screen
    // while the approval was in flight, so pressing Allow looked like it did
    // nothing and the second press raced the first. A run that has been
    // resumed is not awaiting anything, which is what `running: true` beside
    // it already claimed.
    beginRun(null);
    const epoch = currentRunEpoch();
    openRun(VIEW, epoch);
    settleStep(
      {
        view: VIEW,
        proposal: { edits: [], newNotes: [], summary: "" },
        end: { kind: "awaitingScope", folder: "Personal", reason: "needs it" },
        iterations: 2,
        notesRead: 1,
        charsOffDevice: null,
        excludedCount: 0,
      memoryUpdated: 0,},
      epoch,
    );
    expect(getAgent().end?.kind).toBe("awaitingScope");

    resumeRun();

    expect(getAgent().end).toBeNull();
    expect(getAgent().running).toBe(true);
  });
});
