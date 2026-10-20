// The apply failure, named by cause (myne-md/myne#894).
//
// Before this, one sentence covered a dozen whole-call causes and the `catch`
// threw the error away, so a report of "The changes could not be applied." could
// not be told from "the run is gone" or "the vault locked" without a rebuild.

import { describe, expect, it } from "vitest";

import {
  agentErrorTag,
  applyFailureMessage,
  normalizeAgentErrorTag,
} from "../../src/notes/agent/applyFailure";

/** The `t` the helper takes: the key back, so an assertion names the key. */
const t = (key: string): string => key;

describe("agentErrorTag", () => {
  it("reads the tag off a structured rejection", () => {
    expect(agentErrorTag({ kind: "write_failed" })).toBe("write_failed");
  });

  it("reads a bare variant string", () => {
    // Some paths reject with the variant name and nothing else.
    expect(agentErrorTag("cancelled")).toBe("cancelled");
  });

  it("is empty for a shape it does not recognize", () => {
    // The rule `engineErrorTag` states: an unrecognized shape must not be
    // mistaken for a known kind, or every failure would be reported as whichever
    // arm the default happened to be.
    expect(agentErrorTag(undefined)).toBe("");
    expect(agentErrorTag(null)).toBe("");
    expect(agentErrorTag(new Error("boom"))).toBe("");
    expect(agentErrorTag({ detail: "boom" })).toBe("");
  });
});

describe("normalizeAgentErrorTag", () => {
  it("folds the three spellings of one variant together", () => {
    // **The defect this test was written for.** `AgentError` carries no
    // `rename_all`, so a failure crosses IPC as `WriteFailed`; `kind()`, the
    // tag the host logs, is `write_failed`; and a hand-written table might be
    // written in either. All three are one variant, and the map has to see them
    // as one or it silently falls through to the generic sentence.
    for (const spelling of ["WriteFailed", "writeFailed", "write_failed"]) {
      expect(normalizeAgentErrorTag({ kind: spelling })).toBe("writefailed");
    }
    expect(normalizeAgentErrorTag("NoSuchRun")).toBe("nosuchrun");
    expect(normalizeAgentErrorTag(undefined)).toBe("");
  });
});

describe("applyFailureMessage", () => {
  it("names the cause from the WIRE spelling, which is the one that arrives", () => {
    // Asserted in the spelling the derive produces, not the one the host logs:
    // the first version of this file tested `no_such_run` and passed, while
    // every real failure arrived as `NoSuchRun` and read as the generic
    // sentence. A fixture that cannot hold the real state is not a test.
    expect(applyFailureMessage({ kind: "WriteFailed" }, t)).toBe(
      "agent.review.applyFailedCause.write",
    );
    expect(applyFailureMessage({ kind: "NoSuchRun" }, t)).toBe(
      "agent.review.applyFailedCause.noSuchRun",
    );
    expect(applyFailureMessage({ kind: "SlotNotUnlocked" }, t)).toBe(
      "agent.review.applyFailedCause.locked",
    );
  });

  it("names the causes a user can act on or be told about", () => {
    expect(applyFailureMessage({ kind: "cancelled" }, t)).toBe(
      "agent.review.applyFailedCause.cancelled",
    );
    expect(applyFailureMessage({ kind: "AiDisabled" }, t)).toBe(
      "agent.review.applyFailedCause.aiDisabled",
    );
    expect(applyFailureMessage({ kind: "ReadFailed" }, t)).toBe(
      "agent.review.applyFailedCause.read",
    );
    expect(applyFailureMessage({ kind: "RestorePointFailed" }, t)).toBe(
      "agent.review.applyFailedCause.restorePoint",
    );
  });

  it("distinguishes the causes rather than collapsing them", () => {
    // The point of the taxonomy: "the run is gone" and "the write was refused"
    // are different facts about the vault, and only one of them is worth
    // retrying.
    const seen = new Set([
      applyFailureMessage({ kind: "no_such_run" }, t),
      applyFailureMessage({ kind: "write_failed" }, t),
      applyFailureMessage({ kind: "slot_not_unlocked" }, t),
    ]);
    expect(seen.size).toBe(3);
  });

  it("falls back to the generic sentence for an unknown or absent tag", () => {
    // A cause this surface cannot name is still a failure the user has to be
    // told about, so the fallback is a sentence and never an empty string.
    expect(applyFailureMessage({ kind: "gate_refused" }, t)).toBe("agent.review.applyFailed");
    expect(applyFailureMessage(undefined, t)).toBe("agent.review.applyFailed");
    expect(applyFailureMessage({ detail: "boom" }, t)).toBe("agent.review.applyFailed");
  });
});
