// `Session.waitUntil`'s timeout message has to be able to name a cause the
// POLLS discovered, not only the one the caller knew up front.
//
// Every wait in the harness reports `waitUntil(<label>) timed out after N ms`,
// and for a long time the label could only be a fixed string. That is enough
// when there is one way to fail, and misleading when there are three:
// `clickByTestId` swallows "no such element", "element not interactable" and
// "element click intercepted" into the same silent retry, so its message said
// `sas-match located + clicked timed out` for all three. That message got the
// `sync-replication` failure diagnosed as a re-render race and answered with a
// bigger budget, which then measurably did not fix it.
//
// A lazy label closes that: it is evaluated only on the timeout path, so a
// passing wait pays nothing, and it can read whatever the predicate recorded on
// its way past. This file pins the three properties that make it safe to rely
// on — a thunk is CALLED, a plain string still works, and neither is evaluated
// on a wait that succeeds.
//
// `waitUntil` polls a caller-supplied predicate and never touches the wire, so a
// `Session` built on a dummy address exercises the real method rather than a
// re-implementation of it.

import { describe, expect, it, vi } from "vitest";

import { Session } from "../../e2e/support/webdriver";

const session = new Session("http://127.0.0.1:0", "not-a-real-session");

describe("Session.waitUntil label", () => {
  it("evaluates a thunk label on timeout, so a poll can name the cause", async () => {
    let reason = "never polled";
    await expect(
      session.waitUntil(
        async () => {
          reason = 'found, but the click reported "element click intercepted"';
          return null;
        },
        { label: () => `sync.sas-match located + clicked (last poll: ${reason})`, timeoutMs: 250, intervalMs: 20 },
      ),
    ).rejects.toThrow(/last poll: found, but the click reported "element click intercepted"/);
  });

  it("still accepts a plain string label", async () => {
    await expect(
      session.waitUntil(async () => null, {
        label: "a fixed description",
        timeoutMs: 120,
        intervalMs: 20,
      }),
    ).rejects.toThrow(/waitUntil\(a fixed description\) timed out after 120 ms/);
  });

  it("never evaluates the label when the wait succeeds", async () => {
    // The whole justification for allowing a thunk is that it is free on the
    // happy path. If it were evaluated eagerly, every passing wait in the suite
    // would pay for a diagnostic nobody reads.
    const label = vi.fn(() => "should not be built");
    await expect(
      session.waitUntil(async () => "done", { label, timeoutMs: 500 }),
    ).resolves.toBe("done");
    expect(label).not.toHaveBeenCalled();
  });
});
