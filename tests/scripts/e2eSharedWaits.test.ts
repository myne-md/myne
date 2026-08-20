// The two shared E2E waits extracted in myne-md/myne#534, `clickUntilTrue` and
// `settleOn` (`e2e/support/flows.ts`), pinned against a fake `Session`.
//
// Both replaced private copies that had lost the property under test, and
// neither loss is reproducible on demand in a container: the click one needs a
// state commit slower than one 100 ms poll, the settle one needs a sample stream
// caught mid-transition. A container run that happens not to hit either reports
// green, which is exactly how the copies drifted.
//
// The fake carries only what the two helpers call. `waitUntil` is the REAL
// method (`Session` polls a caller-supplied predicate and never touches the wire
// for it, the `e2eWaitUntilLabel.test.ts` precedent), and `findElements` /
// `byTestIdAll` are scripted.

import { describe, expect, it } from "vitest";

import { clickUntilTrue, settleOn } from "../../e2e/support/flows";
import { Session } from "../../e2e/support/webdriver";

/** A `Session` whose element lookups are scripted and whose `waitUntil` is real. */
function fakeSession(onFind: () => Array<{ click: () => Promise<void> }>): Session {
  const s = new Session("http://127.0.0.1:0", "not-a-real-session");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the fake supplies
  // exactly the two lookups the helpers under test call.
  (s as any).findElements = async () => onFind();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (s as any).byTestIdAll = async () => onFind();
  return s;
}

describe("clickUntilTrue", () => {
  it("gives each click its own window, so a slow commit is not clicked a second time", async () => {
    // The defect this exists for: the control is a TOGGLE, and the first click
    // takes longer than one poll interval to land. A loop that re-fires on the
    // next poll toggles it back, and the two clicks cancel forever.
    let clicks = 0;
    let doneAt: number | null = null;
    const s = fakeSession(() => [
      {
        click: async () => {
          clicks += 1;
          // Lands 300 ms later, three poll intervals, inside the per-attempt
          // window but well past a single poll.
          doneAt = clicks;
          setTimeout(() => {
            if (doneAt === clicks) doneAt = -1;
          }, 300);
        },
      },
    ]);

    await clickUntilTrue(s, "[data-testid='toggle']", {
      done: async () => doneAt === -1,
      label: "the toggle flips",
    });

    expect(clicks, "one click, not one per poll").toBe(1);
  });

  it("never clicks when the outcome already holds", async () => {
    let clicks = 0;
    const s = fakeSession(() => [{ click: async () => void (clicks += 1) }]);
    await clickUntilTrue(s, "[data-testid='toggle']", {
      done: async () => true,
      label: "already done",
    });
    expect(clicks).toBe(0);
  });

  it("says the trigger never rendered, which is a different bug from a missed click", async () => {
    const s = fakeSession(() => []);
    await expect(
      clickUntilTrue(s, "[data-testid='absent']", {
        done: async () => false,
        label: "never",
        what: "collapseNotesSidebar",
        trigger: "[the toggle]",
        timeoutMs: 300,
      }),
    ).rejects.toThrow(/collapseNotesSidebar: \[the toggle\] NEVER RENDERED/);
  });

  it("says the click landed but the outcome did not, when the trigger WAS there", async () => {
    const s = fakeSession(() => [{ click: async () => {} }]);
    await expect(
      clickUntilTrue(s, "[data-testid='toggle']", {
        done: async () => false,
        label: "never",
        trigger: "[the toggle]",
        outcome: "[the panel]",
        // ONE attempt's own 2 s window, and no more. `everSawTrigger` is set
        // before the click, so a single attempt already produces the message
        // under test, and a budget that bought two attempts put this case at
        // 4.2 s of Vitest's 5 s default. `pnpm test` is a blocking pre-push and
        // CI step, so a case sitting at 84 % of its budget on an idle machine
        // is one scheduler hiccup from reddening the gate over timing rather
        // than over what it asserts.
        timeoutMs: 2_100,
      }),
    ).rejects.toThrow(/\[the toggle\] rendered and was clicked, but \[the panel\] never appeared/);
  });
});

describe("settleOn", () => {
  it("refuses a first reading, which is how a geometry probe passes against an unfixed build", async () => {
    // A transition: three distinct frames, then rest. A helper that returned the
    // first sample would report the mid-animation value.
    const frames = ["100", "200", "300", "400", "400", "400"];
    let i = 0;
    const s = fakeSession(() => []);
    const settled = await settleOn(s, async () => frames[i++] ?? "400", {
      label: "the box settles",
      parse: (raw) => Number(raw),
    });
    expect(settled).toBe(400);
  });

  it("resets the run on an unmeasurable reading rather than counting it", async () => {
    // `null` is "not measurable yet" (the element has not mounted). Two nulls in
    // a row must not read as two agreeing samples.
    const frames: Array<string | null> = [null, null, "7", null, "7", "7"];
    let i = 0;
    const s = fakeSession(() => []);
    const settled = await settleOn(s, async () => (i < frames.length ? frames[i++]! : "7"), {
      label: "the value settles",
      parse: (raw) => Number(raw),
    });
    expect(settled).toBe(7);
    // The two trailing 7s are the first agreeing pair; the earlier lone 7 was
    // separated by a null and must not have counted toward it.
    expect(i).toBe(6);
  });

  it("settles on a FALSY parsed value instead of polling out its budget", async () => {
    // `waitUntil` returns only on a truthy predicate result, so an unboxed
    // `parse` that yields 0 reads as "not settled yet" and the helper reports
    // that a value never settled when it settled on the second sample. A
    // resting scroll offset and a resting count are both 0, and both are what a
    // generic settle helper gets pointed at next.
    const frames = ["0", "0"];
    let i = 0;
    const s = fakeSession(() => []);
    const settled = await settleOn(s, async () => frames[i++] ?? "0", {
      label: "a value that rests at zero",
      parse: (raw) => Number(raw),
      timeoutMs: 2_000,
    });
    expect(settled).toBe(0);
    expect(i, "returned on the second agreeing sample, not on a timeout").toBe(2);
  });

  it("honours a wider stability window", async () => {
    const frames = ["1", "1", "1", "1"];
    let i = 0;
    const s = fakeSession(() => []);
    const settled = await settleOn(s, async () => frames[i++] ?? "1", {
      label: "three agreeing samples",
      stable: 3,
      parse: (raw) => Number(raw),
    });
    expect(settled).toBe(1);
    expect(i, "stopped at the third agreeing sample, not the second").toBe(3);
  });
});
