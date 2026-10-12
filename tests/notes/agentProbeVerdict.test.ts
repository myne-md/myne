// @vitest-environment jsdom
//
// How long the edit-format probe's verdict lives (myne-md/myne#568).
//
// **What this is worth, in provider requests.** The probe issues
// `threshold.attempts` requests to the configured backend; on a remote one that
// was measured at 8 seconds in the session that found this. It used to be held
// in `ChatComposer`'s own `useState`, and `AiChatTab` mounts conditionally on
// the right panel's active tab, so switching that tab away and back paid for the
// whole probe again, as did every restart of the app. The user sees only
// "Checking the model", so the cost was invisible from the surface and the
// repetition was invisible from the code.
//
// **The three rules are not the same rule.** Keeping it across a new run and
// across closing the review screen is the saving; dropping it on a vault leave
// is the correctness half, and it is the one a "just cache it" fix skips. The
// AI provider settings live in `vault.prefs`, so the next vault opened can be
// configured against a different backend entirely, in both directions: a
// refusal earned by one vault's model would block a capable one, and a pass
// would let the composer skip the check on a model nobody measured.
//
// This file deliberately does not test WHEN the probe fires. That rule
// (`design-notes/ai/0518` point 2, TB13: the first Send, never a mount and
// never a control change) is unchanged and lives with the composer.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProbeVerdict } from "../../src/lib/agent-run";
import {
  beginRun,
  clearAgent,
  clearAgentForLock,
  getAgent,
  setProbeVerdict,
} from "../../src/notes/agent/agentStore";

const PASSED: ProbeVerdict = {
  passed: true,
  passes: 3,
  threshold: { attempts: 3, required: 2, provisional: false },
  attempts: [{ kind: "passed" }, { kind: "passed" }, { kind: "passed" }],
};

beforeEach(() => clearAgentForLock());
afterEach(() => clearAgentForLock());

describe("the probe verdict outlives the composer", () => {
  it("is null until the probe has been run", () => {
    expect(getAgent().probeVerdict).toBeNull();
  });

  it("survives a new run", () => {
    // A second message does not change the backend, and re-probing would spend
    // the provider requests again for every message the user sends.
    setProbeVerdict(PASSED);
    beginRun(null);
    expect(getAgent().probeVerdict).toEqual(PASSED);
  });

  it("survives closing the review screen", () => {
    // `clearAgent` is what the review's own close button calls. Dropping the
    // verdict here would make every review cost the next message a fresh probe,
    // which is the same defect wearing a different call site.
    setProbeVerdict(PASSED);
    clearAgent();
    expect(getAgent().probeVerdict).toEqual(PASSED);
  });

  it("keeps a FAILED verdict across a new run too", () => {
    // The gate direction. `"failed"` blocks the composer, so losing it on the
    // next message would silently reopen a door the probe closed, and the user
    // would pay for the same three requests to have it closed again.
    setProbeVerdict("failed");
    beginRun(null);
    expect(getAgent().probeVerdict).toBe("failed");
  });
});

describe("the probe verdict does not outlive the vault", () => {
  it("is dropped by the lock teardown", () => {
    setProbeVerdict(PASSED);
    clearAgentForLock();
    expect(getAgent().probeVerdict).toBeNull();
  });

  it("is dropped by the lock teardown when it FAILED", () => {
    // Both directions, because the wrong one is not obviously wrong: carrying a
    // refusal forward would block agent mode in a vault whose provider was
    // never measured, and the surface would give the previous vault's model as
    // the reason.
    setProbeVerdict("failed");
    clearAgentForLock();
    expect(getAgent().probeVerdict).toBeNull();
  });
});
