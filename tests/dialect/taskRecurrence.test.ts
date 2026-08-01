// The recurring-task line arithmetic, as pure functions (myne#198).
//
// These moved out of the editor so the Tasks panel could reach them without an
// `EditorView`. What is tested here is the computation itself; the two callers'
// own tests cover the transactions and the note write they wrap it in.
//
// The cases that matter are the DECLINES. A rule that cannot be evaluated must
// produce nothing rather than a plausible default — inventing "every day" would
// repeat a task the user never asked to repeat — and the orphan predicate must
// refuse anything it cannot positively identify, because it authorizes deleting
// a line of the user's file.

import { describe, expect, it } from "vitest";
import {
  canRecur,
  matchesMaterializedOccurrence,
  planNextOccurrence,
  planSkippedOccurrence,
} from "../../src/dialect/taskRecurrence";
import type { CivilDate } from "../../src/dialect/civilDate";

const TODAY: CivilDate = { year: 2026, month: 7, day: 28 };

/** Apply an in-line edit plan to the line it was planned against. */
function applied(line: string, edit: { range: { start: number; end: number }; text: string }): string {
  return line.slice(0, edit.range.start) + edit.text + line.slice(edit.range.end);
}

describe("planNextOccurrence", () => {
  it("advances the due date and drops the completion field", () => {
    const out = planNextOccurrence(
      "- [x] pay rent [due:: 2026-07-01] [repeat:: every month] [done:: 2026-07-28]",
      TODAY,
    );
    expect(out).toContain("[due:: 2026-08-01]");
    expect(out).not.toContain("done::");
  });

  it("returns an UNTICKED line whatever the source marker's case", () => {
    expect(planNextOccurrence("- [X] x [due:: 2026-07-01] [repeat:: every month]", TODAY)).toMatch(
      /^- \[ \]/,
    );
  });

  it("carries the reminder by the same interval the anchor moved", () => {
    // The gap is carried, not recomputed — recomputing lets it drift every
    // cycle, and "ten minutes before the meeting" must not become "three hours
    // after".
    const out = planNextOccurrence(
      "- [ ] standup [due:: 2026-07-01] [remind:: 2026-06-29] [repeat:: every month]",
      TODAY,
    );
    expect(out).toContain("[due:: 2026-08-01]");
    expect(out).toContain("[remind:: 2026-07-30]"); // 31-day step, same as the anchor
  });

  it("declines on a line with no repeat field", () => {
    expect(planNextOccurrence("- [x] one-off [due:: 2026-07-01]", TODAY)).toBeNull();
  });

  it("declines on a rule outside the vocabulary rather than assuming one", () => {
    expect(
      planNextOccurrence("- [x] x [due:: 2026-07-01] [repeat:: every fortnight]", TODAY),
    ).toBeNull();
  });

  it("declines when the rule has no anchor date to advance from", () => {
    // myne#197's case. Here it simply produces nothing — this module has no
    // surface to complain on.
    expect(planNextOccurrence("- [x] shower [repeat:: every day]", TODAY)).toBeNull();
  });

  it("leaves the description's bytes alone", () => {
    const out = planNextOccurrence(
      "  * [x] Buy **milk** & eggs [due:: 2026-07-01] [repeat:: every month]",
      TODAY,
    );
    expect(out).toContain("Buy **milk** & eggs");
    expect(out).toMatch(/^ {2}\* \[ \]/); // indentation and bullet style preserved
  });
});

describe("canRecur", () => {
  // The predicate the chip layer asks before deciding a rule "types"
  // (myne#197). Parseable and evaluable are different questions, and asking
  // only the first is what let an anchorless rule render as a confident chip.

  it("accepts a readable rule with a due date", () => {
    expect(canRecur("- [ ] pay rent [due:: 2026-07-01] [repeat:: every month]")).toBe(true);
  });

  it("accepts a reminder as the anchor when there is no due date", () => {
    // "remind me Tuesday to call my mother" — a pure reminder still recurs, so
    // it must still chip.
    expect(canRecur("- [ ] call mother [remind:: 2026-07-01] [repeat:: every week]")).toBe(true);
  });

  it("rejects a rule with no anchor at all", () => {
    expect(canRecur("- [ ] shower [repeat:: every day]")).toBe(false);
  });

  it("rejects a rule outside the vocabulary even when anchored", () => {
    expect(canRecur("- [ ] x [due:: 2026-07-01] [repeat:: every fortnight]")).toBe(false);
  });

  it("rejects a line carrying no repeat field", () => {
    expect(canRecur("- [ ] one-off [due:: 2026-07-01]")).toBe(false);
    expect(canRecur("just some prose")).toBe(false);
  });

  it("rejects an anchor whose date does not parse", () => {
    // Present-but-unreadable is not an anchor: `advancePair` would drop it and
    // the rule would silently produce nothing.
    expect(canRecur("- [ ] x [due:: whenever] [repeat:: every month]")).toBe(false);
  });

  it("agrees with planNextOccurrence on every case, so the two cannot drift", () => {
    // `canRecur` deliberately takes no `today` — a display layer must not read a
    // clock — which means it re-states the conditions the date computation
    // applies. This pins them together.
    const today = TODAY;
    for (const line of [
      "- [ ] pay rent [due:: 2026-07-01] [repeat:: every month]",
      "- [ ] call mother [remind:: 2026-07-01] [repeat:: every week]",
      "- [ ] shower [repeat:: every day]",
      "- [ ] x [due:: 2026-07-01] [repeat:: every fortnight]",
      "- [ ] x [due:: whenever] [repeat:: every month]",
      "- [ ] one-off [due:: 2026-07-01]",
      "- [ ] x [due:: 2026-07-01] [remind:: 2026-06-29] [repeat:: every 3 days when done]",
      "plain prose",
    ]) {
      expect(canRecur(line)).toBe(planNextOccurrence(line, today) !== null);
    }
  });
});

describe("planSkippedOccurrence", () => {
  it("advances the line in place, writing no completion field", () => {
    const line = "- [ ] water plants [due:: 2026-07-01] [repeat:: every 3 days]";
    const edit = planSkippedOccurrence(line, TODAY);
    expect(edit).not.toBeNull();

    const out = applied(line, edit!);
    expect(out).toContain("[repeat:: every 3 days]");
    expect(out).not.toContain("done::");
    // Still one line, still unticked — a skipped occurrence did not happen.
    expect(out.split("\n").length).toBe(1);
    expect(out).toMatch(/^- \[ \]/);
    expect(out).not.toContain("[due:: 2026-07-01]");
  });

  it("counts from today in completion-anchored mode", () => {
    // There is no completion to anchor on, so today is the only defensible
    // anchor for an occurrence that did not happen.
    const line = "- [ ] stretch [due:: 2026-01-01] [repeat:: every 3 days when done]";
    const out = applied(line, planSkippedOccurrence(line, TODAY)!);
    expect(out).toContain("[due:: 2026-07-31]"); // today + 3, not 2026-01-04
  });

  it("declines on an unreadable rule and on an anchorless one", () => {
    expect(
      planSkippedOccurrence("- [ ] x [due:: 2026-07-01] [repeat:: every fortnight]", TODAY),
    ).toBeNull();
    expect(planSkippedOccurrence("- [ ] shower [repeat:: every day]", TODAY)).toBeNull();
  });
});

describe("matchesMaterializedOccurrence", () => {
  const COMPLETED = "- [x] pay rent [due:: 2026-07-01] [repeat:: every month]";
  const ORPHAN = planNextOccurrence(COMPLETED.replace("[x]", "[ ]"), TODAY)!;

  it("recognizes exactly the line the completion would have produced", () => {
    expect(matchesMaterializedOccurrence(COMPLETED, ORPHAN, TODAY)).toBe(true);
  });

  it("refuses a successor the user edited", () => {
    // The whole point of the predicate: an occurrence carrying the user's own
    // change is user content, and deleting it would be unrecoverable.
    expect(matchesMaterializedOccurrence(COMPLETED, `${ORPHAN} [priority:: high]`, TODAY)).toBe(
      false,
    );
    expect(
      matchesMaterializedOccurrence(COMPLETED, ORPHAN.replace("pay rent", "pay the rent"), TODAY),
    ).toBe(false);
  });

  it("refuses a successor that is ticked, or carries a completion field", () => {
    expect(matchesMaterializedOccurrence(COMPLETED, ORPHAN.replace("[ ]", "[x]"), TODAY)).toBe(
      false,
    );
    expect(
      matchesMaterializedOccurrence(COMPLETED, `${ORPHAN} [done:: 2026-07-28]`, TODAY),
    ).toBe(false);
  });

  it("refuses an unrelated following line", () => {
    expect(matchesMaterializedOccurrence(COMPLETED, "some prose", TODAY)).toBe(false);
    expect(matchesMaterializedOccurrence(COMPLETED, "", TODAY)).toBe(false);
  });

  it("refuses when the completed line is not a recurring task at all", () => {
    expect(matchesMaterializedOccurrence("- [x] one-off", ORPHAN, TODAY)).toBe(false);
  });
});
