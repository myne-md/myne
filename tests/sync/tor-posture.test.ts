// The posture derivation (MYND-650 task 8).
//
// `torPosture` is small enough to look obviously right and load-bearing enough
// that "obviously right" is not good enough: it is the UI's copy of a decision
// the Rust transport also makes (`ProxyGate::route`), and the two must agree
// about whether traffic is tunneled. The case that matters is the stale one —
// a `ready` phase left over from before the user turned Tor off. Rust checks
// `enabled` first and answers `Direct`; if this function answered `active`, the
// UI would tell a user their traffic is going through Tor while the transport
// sends it straight to the server.
//
// The `exempt` term is the same class of disagreement one step over: the gate
// is process-wide, and `proxy::installed_for` hands a loopback endpoint a
// direct-only gate. So `enabled` + `ready` over a loopback endpoint means zero
// bytes tunneled, and answering `active` there is the same lie about a
// different input.

import { describe, expect, it } from "vitest";

import { torPosture, type TorProxyState, type TorStateView } from "../../src/lib/tor-routing";

const PHASES: TorProxyState[] = [
  { kind: "starting" },
  { kind: "ready" },
  { kind: "failed" },
  { kind: "stopped" },
];

const view = (enabled: boolean, state: TorProxyState, exempt = false): TorStateView => ({
  enabled,
  state,
  exempt,
});

describe("torPosture", () => {
  it("is inactive whenever Tor mode is off, whatever the sidecar says", () => {
    for (const state of PHASES) {
      expect(torPosture(view(false, state)), `${state.kind} with Tor off`).toBe("inactive");
      // …and whatever the endpoint is. With the mode off there is nothing to
      // explain: direct sync is the default.
      expect(torPosture(view(false, state, true)), `${state.kind} exempt, Tor off`).toBe("inactive");
    }
  });

  it("maps each phase under Tor mode to what the user is getting", () => {
    expect(torPosture(view(true, { kind: "ready" }))).toBe("active");
    expect(torPosture(view(true, { kind: "starting" }))).toBe("connecting");
    // Both mean: sync is paused and nothing is going out directly. They differ
    // only in how the sidecar got there, which is our bookkeeping.
    expect(torPosture(view(true, { kind: "failed" }))).toBe("unavailable");
    expect(torPosture(view(true, { kind: "stopped" }))).toBe("unavailable");
  });

  it("calls exactly one phase active — every other one pauses sync", () => {
    const active = PHASES.filter((state) => torPosture(view(true, state)) === "active");
    expect(active).toEqual([{ kind: "ready" }]);
  });

  /// A Tor-exempt endpoint is not tunneled by ANY phase. Checking `exempt`
  /// before the phase is what stops a `ready` sidecar from being reported as a
  /// tunnel that carries none of this endpoint's traffic.
  it("never calls a Tor-exempt endpoint active, whatever the sidecar is doing", () => {
    for (const state of PHASES) {
      expect(torPosture(view(true, state, true)), `${state.kind} over loopback`).toBe("exempt");
    }
  });
});
