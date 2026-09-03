/**
 * A civil date names a calendar DAY and an instant names a MOMENT — and only
 * one of them may move with the machine's timezone. myne-md/myne#555, the
 * `editor.frontmatter-properties` bullet:
 *
 *   > the civil-date-must-not-shift and instant-renders-in-zone assertions are
 *   > deterministic DOM reads.
 *
 * # What `tests/notes/propertyFormat.timezone.test.ts` already covers, and what
 * it cannot
 *
 * That file pins the half that shipped broken: a `date`-typed property renders
 * the same calendar day west of UTC. It is correct and it is one case — one
 * zone, one date, one direction — and it has a structural blind spot it states
 * itself: "in a UTC-only CI env this can only pass, never false-fail".
 *
 * The gap that matters is not more zones, though this adds them. It is that
 * **"never shifts" is satisfiable by ignoring the zone entirely.** A formatter
 * hard-pinned to `timeZone: "UTC"` for everything passes that test perfectly
 * and is wrong about every instant in the app: an attachment's `created_at` is
 * a real moment on the timeline, and printing it in UTC tells a user in Auckland
 * that a file they added this morning arrived yesterday evening.
 *
 * So the two claims are asserted against each other:
 *
 *  * a civil date is IDENTICAL in every zone — it is a calendar day, and
 *    anchoring it to an instant is what shifted it west of UTC in the first
 *    place;
 *  * an instant DIFFERS between zones far enough apart — because it is a
 *    moment, and rendering it in the user's zone is the whole point.
 *
 * Neither alone distinguishes a correct implementation from one of the two
 * plausible wrong ones.
 *
 * # Zones
 *
 * Chosen so the two claims can actually separate: `Pacific/Kiritimati` (UTC+14)
 * and `Pacific/Niue` (UTC-11) are 25 hours apart, so a single instant lands on
 * different calendar days in them. A matrix of European zones would agree under
 * every implementation and prove nothing.
 */

import { afterAll, describe, expect, it } from "vitest";
import {
  DEFAULT_DISPLAY,
  displayFromPrefs,
  formatInstant,
} from "../../src/lib/datetimeFormat";
// The PROPERTY RENDERER, not the primitive it happens to call today.
//
// A first draft asserted on `formatCivilDate` directly and did NOT notice the
// original defect when it was injected back in: rewriting `formatDateValue` to
// treat a civil date as an instant left every assertion here green, because the
// function under test sat one layer below the change. The sibling file caught
// it, which is what made the gap legible.
//
// A test aimed at a primitive is a test of that primitive. The claim is about
// what a date-typed PROPERTY renders as, so that is what is called.
import { formatDateValue } from "../../src/notes/views/propertyFormat";

/** 25 hours apart: the widest real span, so one instant is two calendar days. */
const ZONES = [
  "Pacific/Kiritimati", // UTC+14
  "Asia/Tokyo", // UTC+9
  "Europe/Berlin", // UTC+1/+2
  "UTC",
  "America/New_York", // UTC-5/-4
  "Pacific/Niue", // UTC-11
] as const;

/** A civil date: a calendar day, with no instant behind it. */
const CIVIL = "2026-06-11";
/** An instant near midnight UTC, so the zone genuinely decides the day. */
const INSTANT_MS = Date.parse("2026-06-11T23:30:00Z");

const REAL_TZ = process.env.TZ;
afterAll(() => {
  // Restored, unlike the sibling file, which sets `America/New_York` and leaves
  // it set for every test that runs after it in the same worker.
  if (REAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = REAL_TZ;
});

describe("a civil date is the same calendar day in every zone", () => {
  it.each(ZONES)("renders %s identically", (zone) => {
    // The display's OWN zone, not the host's — this is the app setting, and the
    // formatter must ignore it for a civil date exactly as it must ignore the
    // machine's.
    const out = formatDateValue(CIVIL, {
      ...DEFAULT_DISPLAY,
      dateFormat: "iso",
      timeZone: zone,
    });
    expect(
      out,
      `the civil date ${CIVIL} rendered as "${out}" under ${zone}. A date-typed ` +
        `property names a calendar day; anchoring it to an instant is what made ` +
        `it read a day early for every user west of UTC.`,
    ).toBe(CIVIL);
  });

  it("does not move with the HOST zone either", () => {
    // The app setting and the machine setting are two different doors to the
    // same failure, and the sibling test only covers the second.
    const seen = new Set<string>();
    for (const zone of ZONES) {
      process.env.TZ = zone;
      seen.add(formatDateValue(CIVIL, { ...DEFAULT_DISPLAY, dateFormat: "iso" }));
    }
    expect(
      [...seen],
      `the civil date rendered differently depending on the machine's own zone: ` +
        `${[...seen].join(", ")}`,
    ).toEqual([CIVIL]);
  });
});

describe("an instant DOES render in the chosen zone", () => {
  it("lands on different calendar days 25 hours apart", () => {
    // The counter-assertion, and without it every test above is satisfiable by
    // a formatter pinned to UTC for everything — which would tell a user in
    // Auckland that a file they added this morning arrived yesterday evening.
    const east = formatInstant(INSTANT_MS, {
      ...DEFAULT_DISPLAY,
      dateFormat: "iso",
      timeZone: "Pacific/Kiritimati",
    });
    const west = formatInstant(INSTANT_MS, {
      ...DEFAULT_DISPLAY,
      dateFormat: "iso",
      timeZone: "Pacific/Niue",
    });
    expect(
      east,
      `one instant rendered as "${east}" in both Pacific/Kiritimati (UTC+14) and ` +
        `Pacific/Niue (UTC-11), which are 25 hours apart. The zone setting is not ` +
        `reaching instant formatting at all — so "the civil date never shifts" is ` +
        `holding for the wrong reason: nothing is being converted.`,
    ).not.toBe(west);
  });

  it("puts the instant on the day the chosen zone is actually having", () => {
    // Not merely "different" — right. 23:30 UTC on the 11th is already the 12th
    // at UTC+14 and still the 11th at UTC-11.
    expect(
      formatInstant(INSTANT_MS, {
        ...DEFAULT_DISPLAY,
        dateFormat: "iso",
        timeZone: "Pacific/Kiritimati",
      }),
    ).toContain("2026-06-12");
    expect(
      formatInstant(INSTANT_MS, {
        ...DEFAULT_DISPLAY,
        dateFormat: "iso",
        timeZone: "Pacific/Niue",
      }),
    ).toContain("2026-06-11");
  });

  it("degrades an unformattable zone at the layer that owns the wire", () => {
    // The pref carries a FREE STRING, so an unknown zone must not reach a
    // formatter — `Intl.DateTimeFormat` raises a `RangeError`, and a date cell
    // is not worth an exception.
    //
    // A first draft asserted this on `formatInstant` itself, and it threw. That
    // is not a defect: `formatInstant` takes a resolved `DateTimeDisplay`, and
    // the ONLY thing that builds one from the wire is `displayFromPrefs`, which
    // is where the degrade lives (`isSupportedTimeZone` → `null`). Asserting it
    // one layer down would have been demanding a guarantee at a boundary that
    // does not make it — and "fixing" the throw by try/catching inside the
    // formatter would have put a silent wrong answer where a loud impossible
    // state used to be.
    //
    // So what is pinned is the real path: the wire value degrades, and the
    // degraded display formats.
    const display = displayFromPrefs(
      { date_format: "iso", time_format: "24h", timezone: "Not/AZone" },
      "en",
    );
    expect(
      display.timeZone,
      "an unsupported zone survived `displayFromPrefs` and would reach " +
        "Intl.DateTimeFormat, which throws a RangeError on it",
    ).toBeNull();
    expect(() => formatInstant(INSTANT_MS, display)).not.toThrow();

    // …and a SUPPORTED one is carried through, so the degrade above is not
    // simply "the zone setting never works".
    const kept = displayFromPrefs(
      { date_format: "iso", time_format: "24h", timezone: "Asia/Kolkata" },
      "en",
    );
    expect(kept.timeZone).toBe("Asia/Kolkata");
  });
});
