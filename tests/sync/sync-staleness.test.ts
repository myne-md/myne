import { describe, expect, it } from "vitest";
import { isSyncStale, SYNC_STALE_DAYS } from "../../src/lib/sync-staleness";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

// myne#583. The threshold that decides whether a four-day sync outage
// interrupts the user, tested at its edges rather than through the banner —
// the banner can only tell you the wiring works, and every bug this function
// can have is at a boundary.
describe("isSyncStale", () => {
  it("fires once the failure has lasted the threshold", () => {
    expect(isSyncStale(NOW - SYNC_STALE_DAYS * DAY, NOW)).toBe(true);
    expect(isSyncStale(NOW - 30 * DAY, NOW)).toBe(true);
  });

  it("stays quiet below the threshold", () => {
    expect(isSyncStale(NOW - 1000, NOW)).toBe(false);
    expect(isSyncStale(NOW - (SYNC_STALE_DAYS * DAY - 1), NOW)).toBe(false);
  });

  it("says nothing about a device that has never synced", () => {
    // Not a stale sync — an unfinished setup. The states that describe it
    // (not enrolled, no endpoint, awaiting approval) have their own honest
    // copy, and warning here would tell someone mid-setup that something
    // broke when the truth is that they have not finished.
    expect(isSyncStale(null, NOW)).toBe(false);
    expect(isSyncStale(undefined, NOW)).toBe(false);
  });

  it("does not read a backwards clock as an ancient failure", () => {
    // A corrected system time or a restored backup can put `now` behind the
    // recorded stamp. Subtracting would underflow into a huge positive on the
    // Rust side and here would simply be negative; either way the honest
    // answer is "no elapsed failure", not "thirty years".
    expect(isSyncStale(NOW + 10 * DAY, NOW)).toBe(false);
    expect(isSyncStale(NOW, NOW)).toBe(false);
  });
});
