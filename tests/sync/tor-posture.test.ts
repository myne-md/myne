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

import { describe, expect, it } from "vitest";

import { torPosture, type TorProxyState } from "../../src/lib/tor-routing";

const PHASES: TorProxyState[] = [
  { kind: "starting" },
  { kind: "ready" },
  { kind: "failed" },
  { kind: "stopped" },
];

describe("torPosture", () => {
  it("is inactive whenever Tor mode is off, whatever the sidecar says", () => {
    for (const state of PHASES) {
      expect(torPosture({ enabled: false, state }), `${state.kind} with Tor off`).toBe("inactive");
    }
  });

  it("maps each phase under Tor mode to what the user is getting", () => {
    expect(torPosture({ enabled: true, state: { kind: "ready" } })).toBe("active");
    expect(torPosture({ enabled: true, state: { kind: "starting" } })).toBe("connecting");
    // Both mean: sync is paused and nothing is going out directly. They differ
    // only in how the sidecar got there, which is our bookkeeping.
    expect(torPosture({ enabled: true, state: { kind: "failed" } })).toBe("unavailable");
    expect(torPosture({ enabled: true, state: { kind: "stopped" } })).toBe("unavailable");
  });

  it("calls exactly one phase active — every other one pauses sync", () => {
    const active = PHASES.filter((state) => torPosture({ enabled: true, state }) === "active");
    expect(active).toEqual([{ kind: "ready" }]);
  });
});
