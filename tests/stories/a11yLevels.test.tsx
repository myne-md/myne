// @vitest-environment jsdom
//
// The accessibility GATE over the catalogue (myne-md/myne#845).
//
// The Accessibility TAB in the catalogue is a view. This is the half that
// decides something, and keeping the two apart is the whole point: Storybook's
// model is that the panel shows you the facts and the `test` level decides
// whether they block, so "is the a11y panel a gate or a view" stops being a
// question anybody argues about.
//
// Three levels, defined in `A11yLevel` and decided by `a11yVerdict`:
//
//   error. Axe must find nothing; a violation FAILS this spec. THE DEFAULT.
//   todo . A finding is recorded and printed, never hidden, and does not fail
//           yet. Nine stories carry it today, each one line, each saying why.
//   off  . Axe does not run here, and the story carries the reason.
//
// `error` is the default rather than `todo` because the tree could meet it: 197
// of 206 measured stories were axe-clean on this gate's first run. That is the
// opposite trade from `manual-test-ratchet`'s (which starts small and grows) and
// for a measured reason. There the gate was 163 hours against one maintainer,
// here it was nine one-line records. The direction is what makes it durable: a
// story added tomorrow is gated from birth rather than inheriting silent debt.
//
// TWO things this spec has to do beyond the loop, or it is a spec that can pass
// while measuring nothing:
//
//   1. Prove the `error` arm REJECTS a violation. That is the direct
//      `a11yVerdict` injection below, so it cannot pass merely because no story
//      happens to be dirty today.
//   2. Count what axe actually RAN on and assert it equals every story that is
//      not `off`. A loop over an empty list. A bad filter, a skipped fixture ,
//      otherwise reads as a clean run.

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { STORIES } from "../../stories/src/registry";
import { resolveFixture } from "../../stories/fixtures";
import { setStoryFixture } from "../../stories/src/host/internals";
import { formatViolations, runAxe } from "../a11y/axe-config";
import {
  A11Y_LEVELS,
  A11Y_REASON_MIN,
  DEFAULT_A11Y_LEVEL,
  a11yLevelOf,
  a11yVerdict,
  invalidOffReason,
} from "../../stories/src/a11y-level";
import type { A11yLevel } from "../../stories/src/types";

interface Measured {
  id: string;
  level: A11yLevel;
  rules: string[];
}

/** Filled by the run, read by the two reporting tests after it. */
const measured: Measured[] = [];
let ranOn = 0;

afterEach(() => {
  cleanup();
});

describe("the level roster is well formed", () => {
  it("every declared level is one of the three", () => {
    const bad = STORIES.filter(
      (story) => story.a11y !== undefined && !(A11Y_LEVELS as readonly string[]).includes(story.a11y),
    );
    expect(bad.map((s) => s.id)).toEqual([]);
  });

  it("every `off` story carries a reason that names a mechanism", () => {
    // An `off` with no reason is the one shape that must never exist: it is how
    // "axe cannot measure this" becomes indistinguishable from "this failed and
    // was switched off".
    const bad = STORIES.filter(invalidOffReason).map((s) => ({
      id: s.id,
      reason: s.a11yReason ?? "(none)",
    }));
    expect(
      bad,
      `an "off" story needs an a11yReason of at least ${A11Y_REASON_MIN} characters`,
    ).toEqual([]);
  });

  it("the error arm rejects a violation, and only the error arm does", () => {
    expect(a11yVerdict("error", ["color-contrast"])).toBe("fail");
    expect(a11yVerdict("error", [])).toBe("pass");
    expect(a11yVerdict("todo", ["color-contrast"])).toBe("debt");
    expect(a11yVerdict("todo", [])).toBe("pass");
    expect(a11yVerdict("off", ["color-contrast"])).toBe("pass");
    expect(a11yVerdict("off", [])).toBe("pass");
  });

  it("a story that declares nothing is gated, not excused", () => {
    expect(DEFAULT_A11Y_LEVEL).toBe("error");
    expect(a11yLevelOf({})).toBe("error");
  });
});

describe("axe over every story", () => {
  it("runs, and no `error` story has a violation", async () => {
    measured.length = 0;
    ranOn = 0;
    const failures: string[] = [];

    for (const story of STORIES) {
      const level = a11yLevelOf(story);
      if (level === "off") continue;

      setStoryFixture(resolveFixture(story.fixture));
      let container: HTMLElement | null = null;
      await act(async () => {
        container = render(story.render()).container;
      });
      ranOn += 1;

      const results = await runAxe(container as unknown as Element);
      const rules = results.violations.map((v) => v.id);
      measured.push({ id: story.id, level, rules });

      if (a11yVerdict(level, rules) === "fail") {
        failures.push(`${story.id}\n${formatViolations(results)}`);
      }
      cleanup();
    }

    expect(
      failures,
      `an \`a11y: "error"\` story has an axe violation (fix it, or record it as \`todo\`)`,
    ).toEqual([]);
  }, 900_000);

  it("measured every story it did not skip", () => {
    const notOff = STORIES.filter((s) => a11yLevelOf(s) !== "off").length;
    expect(ranOn, "axe must RUN, not skip").toBeGreaterThan(0);
    expect(ranOn, "every non-off story must be measured").toBe(notOff);
    expect(measured.length).toBe(notOff);
  });

  it("publishes where the tree stands, and the debt does not grow", () => {
    // The ceiling must measure its OWN input: this test is read alone by
    // `vitest -t`, and a ceiling over an empty array is a gate reporting on
    // nothing (myne-md/myne#847 review).
    const notOff = STORIES.filter((s) => a11yLevelOf(s) !== "off").length;
    expect(measured.length, "the ceiling must measure every non-off story").toBe(notOff);
    const gated = measured.filter((m) => m.level === "error");
    const debt = measured.filter((m) => m.level === "todo" && m.rules.length > 0);
    console.log(
      `[a11y] ${gated.length} gated (error), ${debt.length} in debt (todo with findings), ` +
        `${measured.length} measured`,
    );
    for (const entry of debt) console.log(`[a11y]   todo ${entry.id}: ${entry.rules.join(", ")}`);

    // A CEILING, not an equality. Fixing or triaging a story must never redden
    // this spec, so the count is free to FALL; it may not RISE. Without this the
    // page's claim that the debt "may only fall" would be prose backed by
    // nothing, which is the failure this repository records most often. Nine is
    // the measured number on the day the gate landed; raising it is the edit
    // that is never legitimate (myne-md/myne#845).
    const CEILING = 9;
    expect(
      debt.length,
      `the recorded a11y debt grew from ${CEILING} to ${debt.length}; ` +
        `fix the finding or record why it is not a product defect`,
    ).toBeLessThanOrEqual(CEILING);
    // And the roster must not be emptied to satisfy the ceiling: `off` is a
    // declared exemption with a reason, never a way to hide a failure.
    const off = STORIES.filter((s) => a11yLevelOf(s) === "off").length;
    expect(off, "`off` is for a story axe cannot measure, not for one that fails").toBe(0);
  });
});
