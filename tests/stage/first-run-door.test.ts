// The two doors into the first run, and the ONE thing that differs between them
// (myne-md/myne#911 follow-up).
//
// What this pins, stated as the failure: the welcome screen's invited row runs
// the same identity ceremony as Create, and if it landed where Create lands, a
// person invited to someone else's vault would be asked to create a vault of
// their own before they could accept. The difference is carried by `after` and
// nothing else, which is why it is asserted on the payload rather than on the
// stage name: both doors produce `first-run`, and a test that only checked the
// name would pass on the broken wiring.
//
// Pure-`transition` assertions, the same level `verifyTransitionTable` walks.

import { describe, expect, it, vi } from "vitest";
import { transition, type Action, type Stage } from "../../src/lib/stage";

/** Run a deliberately illegal pair without the dev-only `rejectIllegal` warn. */
function transitionQuietly(prev: Stage, action: Action): Stage {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    return transition(prev, action);
  } finally {
    warn.mockRestore();
  }
}

describe("the first run's two doors", () => {
  it("the create door leaves the landing at its default, which is vault creation", () => {
    const next = transition({ name: "welcome" }, { type: "welcome.start" });
    expect(next.name).toBe("first-run");
    if (next.name !== "first-run") throw new Error("unreachable");
    // undefined, NOT "vault": the default is the absence of the field, and
    // pinning that keeps one wire format for both doors.
    expect(next.after).toBeUndefined();
  });

  it("the invited door lands on the identity home instead", () => {
    const next = transition({ name: "welcome" }, { type: "welcome.invited-start" });
    expect(next.name).toBe("first-run");
    if (next.name !== "first-run") throw new Error("unreachable");
    expect(next.after).toBe("identity-home");
  });

  it("the invited action is legal only from the stage that offers the door", () => {
    const elsewhere: Stage[] = [
      { name: "editor" },
      { name: "picker" },
      { name: "unlock", initialStatus: { kind: "Exists" } },
      { name: "first-run" },
    ];
    for (const prev of elsewhere) {
      const next = transitionQuietly(prev, { type: "welcome.invited-start" });
      expect(next).toBe(prev);
    }
  });
});
