// The seed's staleness rule (myne-md/myne#915): a 14-day cooldown AND a 25%
// change in the live note set, derived from the seed date and the notes'
// `updatedAt` rather than stored. Pure, so the boundary is cheap to pin.

import { describe, expect, it } from "vitest";

import {
  SEED_STALE_COOLDOWN_DAYS,
  SEED_STALE_RATIO,
  isSeedStale,
} from "../../src/lib/seed-memory";

const DAY = 24 * 60 * 60 * 1000;
const seededAt = 1_700_000_000_000;

function notes(updatedAts: Array<number | null>) {
  return updatedAts.map((t) => ({ updatedAt: t === null ? null : new Date(t) }));
}

describe("isSeedStale", () => {
  it("is false before the cooldown, however much changed", () => {
    const now = seededAt + (SEED_STALE_COOLDOWN_DAYS - 1) * DAY;
    expect(isSeedStale(seededAt, notes([now, now, now, now]), now)).toBe(false);
  });

  it("is false when too little of the vault moved", () => {
    const now = seededAt + SEED_STALE_COOLDOWN_DAYS * DAY;
    // One of ten changed: 10%, below the 25% rule.
    expect(
      isSeedStale(seededAt, notes([now, seededAt - DAY, seededAt - DAY, seededAt - DAY, seededAt - DAY, seededAt - DAY, seededAt - DAY, seededAt - DAY, seededAt - DAY, seededAt - DAY]), now),
    ).toBe(false);
  });

  it("is true at the cooldown when a quarter changed", () => {
    const now = seededAt + SEED_STALE_COOLDOWN_DAYS * DAY;
    const changed = Math.ceil(4 * SEED_STALE_RATIO);
    const list = [
      ...Array.from({ length: changed }, () => now),
      ...Array.from({ length: 4 - changed }, () => seededAt - DAY),
    ];
    expect(isSeedStale(seededAt, notes(list), now)).toBe(true);
  });

  it("ignores notes with no timestamp and an unseeded vault", () => {
    const now = seededAt + 30 * DAY;
    expect(isSeedStale(null, notes([now]), now)).toBe(false);
    expect(isSeedStale(seededAt, notes([null, null]), now)).toBe(false);
  });
});
