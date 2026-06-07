// Unit tests for src/notes/dailyNote.ts (MYND-191) — the idempotent "open
// today" resolver. Pure function; all clock input is the injected `now`.

import { describe, it, expect } from "vitest";
import {
  formatDailyDate,
  resolveTodayNote,
  DEFAULT_DAILY_FOLDER,
  DEFAULT_DAILY_DATE_FORMAT,
} from "../../src/notes/dailyNote";
import type { TitleRecord } from "../../src/notes/loadNoteBatch";

function rec(
  uuid: string,
  title: string | null,
  folder: string | null,
  over: Partial<TitleRecord> = {},
): TitleRecord {
  return {
    noteUuid: uuid,
    title,
    folder,
    updatedAt: null,
    trashed: null,
    template: false,
    ...over,
  };
}

// Fixed local instant: 2026-06-07 (a Sunday) at 01:00.
const NOW = new Date(2026, 5, 7, 1, 0, 0);

describe("formatDailyDate", () => {
  it("formats the default YYYY-MM-DD in local time", () => {
    expect(formatDailyDate(NOW, DEFAULT_DAILY_DATE_FORMAT)).toBe("2026-06-07");
  });
  it("supports a custom separator format", () => {
    expect(formatDailyDate(NOW, "YYYY/MM/DD")).toBe("2026/06/07");
  });
  it("keeps the local calendar day for an early-morning instant", () => {
    expect(formatDailyDate(new Date(2026, 5, 7, 0, 30), "YYYY-MM-DD")).toBe(
      "2026-06-07",
    );
  });
});

describe("resolveTodayNote", () => {
  it("revisit same day → opens the existing note (no create)", () => {
    const notes = [rec("a", "2026-06-07", "Daily/")];
    const r = resolveTodayNote(NOW, null, null, notes);
    expect(r).toEqual({ kind: "open", id: "a", dateTitle: "2026-06-07" });
  });

  it("first-ever daily note → create signal with the date-title + folder", () => {
    const r = resolveTodayNote(NOW, null, null, []);
    expect(r).toEqual({
      kind: "create",
      dateTitle: "2026-06-07",
      folder: "Daily/",
    });
  });

  it("renamed title no longer matches → create", () => {
    const notes = [rec("a", "Sunday notes", "Daily/")];
    expect(resolveTodayNote(NOW, null, null, notes).kind).toBe("create");
  });

  it("moved out of the daily folder no longer matches → create", () => {
    const notes = [rec("a", "2026-06-07", "Archive/")];
    expect(resolveTodayNote(NOW, null, null, notes).kind).toBe("create");
  });

  it("case-fold + NFC: folder + title variants resolve to the same note", () => {
    // daily/ vs Daily/, and a date title compared case-insensitively.
    const notes = [rec("a", "2026-06-07", "daily/")];
    const r = resolveTodayNote(NOW, null, "Daily/", notes);
    expect(r).toEqual({ kind: "open", id: "a", dateTitle: "2026-06-07" });
  });

  it("a trashed today-note is excluded → create", () => {
    const notes = [
      rec("a", "2026-06-07", "Daily/", { trashed: "2026-06-07T00:00:00Z" }),
    ];
    expect(resolveTodayNote(NOW, null, null, notes).kind).toBe("create");
  });

  it("a template-flagged today-note is excluded → create", () => {
    const notes = [rec("a", "2026-06-07", "Daily/", { template: true })];
    expect(resolveTodayNote(NOW, null, null, notes).kind).toBe("create");
  });

  it("honors a custom folder + format", () => {
    const notes = [rec("a", "2026/06/07", "Journal/")];
    const r = resolveTodayNote(NOW, "YYYY/MM/DD", "Journal/", notes);
    expect(r).toEqual({ kind: "open", id: "a", dateTitle: "2026/06/07" });
  });

  it("matches only within the daily folder, not a same-named root note", () => {
    const notes = [rec("a", "2026-06-07", null)]; // root note, same title
    expect(resolveTodayNote(NOW, null, null, notes).kind).toBe("create");
  });

  it("uses the documented defaults when prefs are null", () => {
    // Sanity on the exported defaults.
    expect(DEFAULT_DAILY_FOLDER).toBe("Daily/");
    expect(DEFAULT_DAILY_DATE_FORMAT).toBe("YYYY-MM-DD");
  });
});
