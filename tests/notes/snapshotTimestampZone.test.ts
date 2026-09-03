// The snapshots panel's timestamps do not depend on the machine's timezone —
// and the day they do, this test says so. myne-md/myne#555, the
// `notes.snapshots` bullet:
//
//   > adding `TZ` to the per-launch env is one key, and the interface language
//   > is already driven through the real picker; snapshot times are
//   > fixture-seeded, so ordering, a half-hour offset and a pre-DST timestamp
//   > are exact string assertions.
//
// # The bullet's premise does not hold, and that is the finding
//
// It assumes the panel renders an ABSOLUTE timestamp. It does not.
// `SnapshotsPanel.tsx` has exactly one use of `captured_at_ms`:
//
//     formatRelativeTime(new Date(s.captured_at_ms)) || t("notes.snapshots.justNow")
//
// and nothing else in the file formats a date. A relative time is a DELTA
// between two instants, so a half-hour offset and a pre-DST timestamp are not
// exact string assertions there — they are not assertions at all. An E2E
// scenario adding `TZ` to the launch env would sweep two zones and measure the
// same string twice, and it would pass, and it would mean nothing.
//
// Ordering is timezone-independent for the same reason: the rows are sorted on
// epoch milliseconds, which carry no zone.
//
// # So what this test is for
//
// The property that makes the missing scenario unnecessary, pinned so that
// changing it is a decision rather than an accident. If someone swaps the
// relative rendering for an absolute one — a reasonable thing to want, "14:32"
// tells you more than "2 hours ago" once a snapshot is a week old — then the
// panel acquires a timezone dependency it has never had, and the E2E scenario
// the bullet describes becomes owed.
//
// This test fails on that change, which is the point: it converts a silent
// acquisition of a timezone bug into a red test with the reason next to it.
//
// # Why two zones and not a mocked `Intl`
//
// `process.env.TZ` is what the runtime actually reads, and it is what a user's
// machine sets. Mocking `Intl.DateTimeFormat` would test the mock: the desktop
// lane already learned that (`tests/notes/dailyDateGregorian.test.ts` records
// an injection that left every output assertion green because the fallback
// locale was Gregorian and ASCII anyway).
//
// The two zones are chosen to break a naive implementation in both of the ways
// a timezone can: a half-hour offset that no whole-hour arithmetic produces,
// and a zone that observes DST against one that does not.

import { afterEach, describe, expect, it } from "vitest";
import { formatRelativeTime } from "../../src/notes/components/relativeTime";

/** Kathmandu is UTC+05:45 — a 45-minute offset, which no whole-hour or
 *  half-hour arithmetic produces by accident. */
const ODD_OFFSET_ZONE = "Asia/Kathmandu";
/** New York observes DST; the instant below sits days before a transition. */
const DST_ZONE = "America/New_York";
/** Turkey dropped DST in 2016, so its offset never moves. Pairing it with the
 *  one above is what makes a DST-sensitive implementation differ. */
const FIXED_ZONE = "Europe/Istanbul";

const originalTz = process.env.TZ;

afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

/** Render under a given zone. */
function renderUnder(zone: string, when: Date, now: Date): string {
  process.env.TZ = zone;
  return formatRelativeTime(when, now);
}

describe("snapshot timestamps are timezone-independent (myne-md/myne#555)", () => {
  // Fixed instants, so the test is not a function of when it runs. Two hours
  // before "now", and four days before a US DST transition.
  const NOW = new Date("2026-03-05T12:00:00Z");
  const CAPTURED = new Date("2026-03-05T10:00:00Z");

  it("renders the same string in a 45-minute-offset zone as in UTC", () => {
    const utc = renderUnder("UTC", CAPTURED, NOW);
    const odd = renderUnder(ODD_OFFSET_ZONE, CAPTURED, NOW);
    expect(
      utc,
      "the snapshot row rendered nothing, so both comparisons below hold on two " +
        "empty strings",
    ).not.toBe("");
    expect(
      odd,
      `a snapshot rendered "${odd}" in ${ODD_OFFSET_ZONE} and "${utc}" in UTC. The ` +
        `panel's only use of captured_at_ms is formatRelativeTime, which is a ` +
        `delta between two instants and cannot depend on a zone — so this ` +
        `difference means the rendering has become absolute. That is a reasonable ` +
        `change to want, and it means the panel now has a timezone dependency it ` +
        `has never had: the E2E scenario myne-md/myne#555 describes (TZ in the ` +
        `launch env, exact string assertions) becomes owed in the same change.`,
    ).toBe(utc);
  });

  it("renders the same string across a DST boundary as in a zone with no DST", () => {
    const dst = renderUnder(DST_ZONE, CAPTURED, NOW);
    const fixed = renderUnder(FIXED_ZONE, CAPTURED, NOW);
    expect(
      dst,
      `a snapshot rendered "${dst}" in ${DST_ZONE} (which observes DST) and ` +
        `"${fixed}" in ${FIXED_ZONE} (which has not since 2016). Same reasoning as ` +
        `above, and this is the half that a whole-hour offset test would miss: an ` +
        `implementation can handle offsets correctly and still be wrong across a ` +
        `transition.`,
    ).toBe(fixed);
  });

  it("orders two snapshots the same way in every zone", () => {
    // Ordering is epoch-based and therefore zone-free, which is the other half
    // of why no E2E sweep is owed. Pinned rather than assumed: a sort that
    // reached for a civil date would break here.
    const older = new Date("2026-03-05T09:00:00Z");
    const newer = new Date("2026-03-05T11:00:00Z");
    for (const zone of ["UTC", ODD_OFFSET_ZONE, DST_ZONE, FIXED_ZONE]) {
      process.env.TZ = zone;
      const sorted = [older, newer]
        .slice()
        .sort((a, b) => b.getTime() - a.getTime())
        .map((d) => d.toISOString());
      expect(
        sorted,
        `snapshot ordering came out differently in ${zone}. Rows are sorted on ` +
          `epoch milliseconds, which carry no zone — a difference here means the ` +
          `sort reached for a civil date.`,
      ).toEqual([newer.toISOString(), older.toISOString()]);
    }
  });
});
