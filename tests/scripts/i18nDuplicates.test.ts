// Break tests for `scripts/check-i18n-duplicates.mjs` (myne-md/myne#649).
//
// Root `AGENTS.md`: "Verifying a guard means breaking it, not running it. Inject
// the exact defect the guard now claims to catch, watch it name that defect,
// then restore." Running the guard on the real tree proves only that the real
// tree is currently clean, which is what `check-i18n.mjs` and
// `check-i18n-coverage.mjs` already reported while #649's four duplicated
// sentences drifted apart in 21 catalogs.
//
// `duplicateGroups` / `checkGroups` take their whole world as arguments, so every
// case below is a synthetic catalog rather than a mutation of `locales/`: no
// `git restore`, no half-restored working copy, and the injections run on every
// commit.
//
// The cases nobody thinks to try, and why the guard is shaped that way:
//
//   - a NEW key joining a recorded sentence must fail. Membership is recorded
//     per group, not just the value: without it a second telling of an
//     approved sentence would land silently, which is #649 itself.
//   - a reworded side must fail STALE rather than pass. Without the reverse
//     direction a fix would leave its roster entry behind and the record would
//     stop describing anything.
//   - the --record placeholder must fail. `check-ipc-binding-callers.mjs`
//     seeded entries with a string its own length check accepted, so seven
//     entries licensed themselves; the placeholder here is rejected by exact
//     match, not by length.
//   - plural siblings must collapse. Without stem-collapsing every plural group
//     would report itself and the roster would be noise.
//   - short labels must stay out. "Cancel" is shared by 39 keys by design; the
//     floor is what keeps the roster at sentences.

import { describe, expect, it } from "vitest";

import {
  MIN_LEN,
  PLACEHOLDER,
  buildRecord,
  checkGroups,
  duplicateGroups,
} from "../../scripts/check-i18n-duplicates.mjs";

const SENTENCE = "This recording is too long to transcribe, so it stays attached.";
const OTHER = "Unlock your vault before transcribing anything at all.";

function catalog(entries: Record<string, unknown>) {
  return entries;
}

function recorded(value: string, keys: string[], reason = "A human reason saying why these share one sentence.") {
  return [{ value, keys: [...keys].sort(), reason }];
}

describe("duplicateGroups", () => {
  it("reports two keys sharing one sentence", () => {
    const groups = duplicateGroups(
      catalog({ a: { x: SENTENCE }, b: { y: SENTENCE } }),
    );
    expect([...groups.keys()]).toEqual([SENTENCE]);
    expect(groups.get(SENTENCE)).toEqual(["a.x", "b.y"]);
  });

  it("ignores values below the floor", () => {
    const groups = duplicateGroups(catalog({ a: { x: "Cancel" }, b: { y: "Cancel" } }));
    expect(groups.size).toBe(0);
  });

  it("collapses plural siblings of one stem", () => {
    const groups = duplicateGroups(
      catalog({ a: { x_one: SENTENCE, x_other: SENTENCE } }),
    );
    expect(groups.size).toBe(0);
  });

  it("still reports two stems sharing through plural forms", () => {
    const groups = duplicateGroups(
      catalog({ a: { x_one: SENTENCE }, b: { y_other: SENTENCE } }),
    );
    expect(groups.get(SENTENCE)).toEqual(["a.x", "b.y"]);
  });
});

describe("checkGroups", () => {
  it("passes an exact record match", () => {
    const actual = duplicateGroups(catalog({ a: { x: SENTENCE }, b: { y: SENTENCE } }));
    expect(checkGroups(actual, recorded(SENTENCE, ["a.x", "b.y"]))).toEqual([]);
  });

  it("names a new key joining a recorded sentence", () => {
    const actual = duplicateGroups(
      catalog({ a: { x: SENTENCE }, b: { y: SENTENCE }, c: { z: SENTENCE } }),
    );
    const failures = checkGroups(actual, recorded(SENTENCE, ["a.x", "b.y"]));
    expect(failures.length).toBe(1);
    expect(failures[0]).toContain("c.z");
  });

  it("names a wholly unrecorded pair", () => {
    const actual = duplicateGroups(catalog({ c: { z: OTHER }, d: { w: OTHER } }));
    const failures = checkGroups(actual, recorded(SENTENCE, ["a.x", "b.y"]));
    expect(failures.some((f) => f.includes("unrecorded") && f.includes("c.z") && f.includes("d.w"))).toBe(true);
  });

  it("fails stale when a side is reworded", () => {
    const actual = duplicateGroups(catalog({ a: { x: SENTENCE } }));
    const failures = checkGroups(actual, recorded(SENTENCE, ["a.x", "b.y"]));
    expect(failures.some((f) => f.includes("stale"))).toBe(true);
  });

  it("rejects the --record placeholder reason", () => {
    const actual = duplicateGroups(catalog({ a: { x: SENTENCE }, b: { y: SENTENCE } }));
    const failures = checkGroups(actual, [
      { value: SENTENCE, keys: ["a.x", "b.y"], reason: PLACEHOLDER },
    ]);
    expect(failures.some((f) => f.includes("placeholder"))).toBe(true);
  });

  it("rejects a short reason", () => {
    const actual = duplicateGroups(catalog({ a: { x: SENTENCE }, b: { y: SENTENCE } }));
    const failures = checkGroups(actual, [{ value: SENTENCE, keys: ["a.x", "b.y"], reason: "same" }]);
    expect(failures.length).toBe(1);
  });
});

describe("buildRecord", () => {
  it("keeps human reasons on matching groups and seeds placeholders for new ones", () => {
    const actual = duplicateGroups(
      catalog({ a: { x: SENTENCE }, b: { y: SENTENCE }, c: { z: OTHER }, d: { w: OTHER } }),
    );
    const next = buildRecord(actual, recorded(SENTENCE, ["a.x", "b.y"], "Kept reason for the old pair."));
    const old = next.find((e) => e.value === SENTENCE);
    const fresh = next.find((e) => e.value === OTHER);
    expect(old?.reason).toBe("Kept reason for the old pair.");
    expect(fresh?.reason).toBe(PLACEHOLDER);
    // And the seeded record does not pass: the writing half fails too.
    expect(checkGroups(actual, next).length).toBeGreaterThan(0);
  });

  it(`placeholder is longer than a naive length check would catch (the ipc-binding-callers lesson: ${PLACEHOLDER.length} chars)`, () => {
    // Guard against a future "simplification" to length-only: the exact match
    // must stay, because the placeholder is long enough to pass any sane floor.
    expect(PLACEHOLDER.length).toBeGreaterThan(10);
    const actual = duplicateGroups(catalog({ a: { x: SENTENCE }, b: { y: SENTENCE } }));
    const failures = checkGroups(actual, [
      { value: SENTENCE, keys: ["a.x", "b.y"], reason: PLACEHOLDER },
    ]);
    expect(failures.length).toBe(1);
  });
});

describe("floor calibration", () => {
  it(`MIN_LEN sits below the shortest #649 sentence (30 chars, "Unlock your vault to transcribe.")`, () => {
    expect(MIN_LEN).toBeLessThanOrEqual(25);
    expect("Unlock your vault to transcribe.".length).toBeGreaterThanOrEqual(MIN_LEN);
  });
});
