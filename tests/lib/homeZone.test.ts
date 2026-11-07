// The second clock (decisions/storage/0797).
//
// The claim under test is narrow and it is the whole claim of the feature: reading
// the same stored wall clock from another zone produces that zone's clock, and the
// stored value is only ever interpreted, never rewritten.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deviceZone,
  homeClockFor,
  isKnownZone,
  readHomeZone,
  writeHomeZone,
} from "../../src/lib/homeZone";

// A store of its own rather than `jsdom`: the preference is a `localStorage` value,
// so the test supplies one and does not depend on which test environment this suite
// happens to run under.
const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("homeClockFor", () => {
  it("reads a stored instant as the home zone's clock", () => {
    // 09:00 on the device in London is 12:00 in Istanbul (UTC+3, no DST in force).
    expect(homeClockFor("2026-11-05 09:00", "Europe/Istanbul", "Europe/London")).toEqual({
      time: "12:00",
      dayOffset: 0,
    });
  });

  it("says when the home clock is already on another day", () => {
    // 23:30 in London is 02:30 the next day in Istanbul.
    expect(homeClockFor("2026-11-05 23:30", "Europe/Istanbul", "Europe/London")).toEqual({
      time: "02:30",
      dayOffset: 1,
    });
    // And 01:00 in London is 22:00 the previous day in New York.
    expect(homeClockFor("2026-11-05 01:00", "America/New_York", "Europe/London")?.dayOffset).toBe(-1);
  });

  it("adds nothing when the preference is the device's own zone", () => {
    expect(homeClockFor("2026-11-05 09:00", "Europe/Istanbul", "Europe/Istanbul")).toBeNull();
  });

  it("adds nothing to an all-day event, because a date has no clock to convert", () => {
    expect(homeClockFor("2026-11-05", "Europe/Istanbul", "Europe/London")).toBeNull();
    expect(homeClockFor("2026-11-05 09:00", null, "Europe/London")).toBeNull();
  });

  it("does not touch the value it was given", () => {
    const stored = "2026-11-05 09:00";
    homeClockFor(stored, "Europe/Istanbul", "Europe/London");
    expect(stored).toBe("2026-11-05 09:00");
  });
});

describe("the stored preference", () => {
  it("round-trips a known zone and refuses to store an unknown one", () => {
    expect(isKnownZone("Europe/Istanbul")).toBe(true);
    expect(isKnownZone("Mars/Olympus")).toBe(false);
    writeHomeZone("Europe/Istanbul");
    expect(readHomeZone()).toBe("Europe/Istanbul");
    writeHomeZone("Mars/Olympus");
    // A stored zone the runtime cannot resolve would silently produce no second
    // clock at all, which reads as a bug rather than as a setting.
    expect(readHomeZone()).toBeNull();
  });

  it("answers the device's own zone", () => {
    expect(deviceZone()).not.toBe("");
  });
});
