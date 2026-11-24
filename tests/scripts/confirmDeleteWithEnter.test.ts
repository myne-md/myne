// `confirmDeleteWithEnter` (`e2e/support/flows.ts`), pinned against a fake `Session`.
//
// The helper confirmed an open delete-confirm dialog with ONE Enter press, and it used to
// press a second time after a 5 s grace when the first press did not take. That retry was
// hiding a product defect rather than covering a harness race: the dialog's Enter guard
// was a 16 ms window that opened when React ran the arming effect, and this harness's own
// press sequence is 10 to 14 ms long, so under load the first press was refused on a
// dialog whose ring sat on the confirm button with every other guard reading correct
// (myne-md/myne#683, `decisions/ui/0685`). The retry is gone and the helper now lets
// a refused press FAIL.
//
// Nothing in the container lane can hold that: the scenario only fails when the race
// happens to land, and a run that misses it reports green. So the contract is pinned
// here, where "one press, then a failure" is cheap and deterministic. The press count is
// the assertion, which makes re-adding a rescue visible as a test that goes red rather
// than as a flake that comes back.
//
// The fake carries only what the helper calls. `pressKey` goes through `Session.send`
// (scripted, and counted); `activeTestId` needs `execute`; `waitForGone` is the REAL
// method, over a scripted `findElements`, with only its budget shortened so an
// intentionally-stuck dialog does not spend the full 45 s proving it is stuck. Shortening
// that budget is what keeps the assertion honest rather than what decides it: the press
// count is read from the wire the helper actually drives.

import { describe, expect, it } from "vitest";

import { confirmDeleteWithEnter } from "../../e2e/support/flows";
import { Session } from "../../e2e/support/webdriver";

/** A `Session` whose dialog state, wire and lookups are scripted. */
function fakeSession(opts: { closesOnPress: boolean }): {
  session: Session;
  presses: () => number;
} {
  const session = new Session("http://127.0.0.1:0", "not-a-real-session");
  let presses = 0;
  let dialogUp = true;
  const anySession = session as unknown as Record<string, unknown>;

  // The wire. `pressKey` sends POST /actions (the press) and DELETE /actions (releasing
  // the driver's input state); only the press is counted.
  anySession.send = async (method: string, path: string): Promise<unknown> => {
    if (method === "POST" && path === "/actions") {
      presses += 1;
      if (opts.closesOnPress) dialogUp = false;
    }
    return {};
  };
  anySession.execute = async (): Promise<unknown> => "delete-confirm.confirm";
  anySession.byTestId = async (): Promise<unknown> => ({
    click: async (): Promise<void> => undefined,
  });
  anySession.findElements = async (): Promise<unknown[]> => (dialogUp ? [{}] : []);
  // The REAL `waitUntil`, with a budget that makes a stuck dialog cheap to assert on.
  const realWaitUntil = (
    session as unknown as {
      waitUntil: (fn: () => Promise<unknown>, opts?: unknown) => Promise<unknown>;
    }
  ).waitUntil;
  anySession.waitUntil = (fn: () => Promise<unknown>, o?: unknown): Promise<unknown> =>
    realWaitUntil.call(session, fn, {
      ...(o as Record<string, unknown> | undefined),
      timeoutMs: 60,
    });

  return { session, presses: () => presses };
}

describe("confirmDeleteWithEnter", () => {
  it("presses once and lets a refused press fail, rather than pressing again", async () => {
    // The #683 shape: the ring is on the confirm button, the press is dispatched, and the
    // dialog stays up. One press, then the failure. A second press here is the retired
    // rescue, and it is exactly what made every `et1`-shaped scenario green while the
    // product refused real users' first Enter.
    const { session, presses } = fakeSession({ closesOnPress: false });

    await expect(confirmDeleteWithEnter(session)).rejects.toThrow(/waitForGone/);
    expect(presses()).toBe(1);
  });

  it("presses once when the press takes", async () => {
    // The other direction, so the assertion above cannot pass merely because the helper
    // stopped pressing at all.
    const { session, presses } = fakeSession({ closesOnPress: true });

    await expect(confirmDeleteWithEnter(session)).resolves.toBeUndefined();
    expect(presses()).toBe(1);
  });
});
