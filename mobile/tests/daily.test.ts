import { describe, it, expect } from "vitest";
import { formatDailyDate, resolveTodayNote } from "../src/lib/daily";

describe("formatDailyDate", () => {
  it("replaces YYYY/MM/DD tokens (local clock, zero-padded)", () => {
    const d = new Date(2026, 6, 4); // local: 4 July 2026 (month index 6 = July)
    expect(formatDailyDate(d, "YYYY-MM-DD")).toBe("2026-07-04");
    expect(formatDailyDate(d, "YYYY/MM/DD")).toBe("2026/07/04");
    expect(formatDailyDate(d, "Daily YYYY")).toBe("Daily 2026");
  });
});

describe("resolveTodayNote", () => {
  const now = new Date(2026, 6, 4);

  it("returns create with the default folder + date title when nothing matches", () => {
    expect(resolveTodayNote(now, null, null, [])).toEqual({
      kind: "create",
      dateTitle: "2026-07-04",
      folder: "Daily/",
    });
  });

  it("opens an existing today-note in the daily folder", () => {
    const notes = [{ id: "x", title: "2026-07-04", folder: "Daily/" }];
    expect(resolveTodayNote(now, null, null, notes)).toEqual({ kind: "open", id: "x", dateTitle: "2026-07-04" });
  });

  it("matches case-insensitively on folder + title", () => {
    const notes = [{ id: "y", title: "2026-07-04", folder: "daily/" }];
    expect(resolveTodayNote(now, null, null, notes).kind).toBe("open");
  });

  it("does not match a same-titled note in a different folder", () => {
    const notes = [{ id: "z", title: "2026-07-04", folder: "Other/" }];
    expect(resolveTodayNote(now, null, null, notes).kind).toBe("create");
  });

  it("honors a custom date format + folder", () => {
    const r = resolveTodayNote(now, "YYYY/MM/DD", "Journal/", []);
    expect(r).toEqual({ kind: "create", dateTitle: "2026/07/04", folder: "Journal/" });
  });
});
