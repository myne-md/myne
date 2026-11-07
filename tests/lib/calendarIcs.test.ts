// `.ics` export mapping (myne-md/myne#1037).
//
// The rule this pins is the one that would silently corrupt a calendar: a
// projected occurrence is a RENDER of a series, so writing one per row would make
// every repeating event multiply on its next import. The test drives the real
// export path with the platform seams stubbed, so it exercises the mapper and the
// codec together rather than a copy of the mapping.

import { beforeEach, describe, expect, it, vi } from "vitest";

const saved: { path: string | null } = { path: null };
const invoked: { command: string; args: unknown }[] = [];

vi.mock("../../src/platform/core", () => ({
  invoke: async (command: string, args: unknown) => {
    invoked.push({ command, args });
  },
}));
vi.mock("../../src/platform/capabilities", () => ({
  // Desktop: it has both the import dialog and a path-taking save.
  has: (capability: string) => capability === "icsImport" || capability === "nativeSaveAs",
}));
vi.mock("../../src/platform/dialog", () => ({
  save: async () => saved.path,
}));
vi.mock("../../src/platform/download", () => ({
  deliverFile: async () => undefined,
}));
vi.mock("../../src/platform/filePicker", () => ({
  pickFiles: async () => null,
}));

import { exportIcsFile } from "../../src/lib/calendarIcs";
import type { CalendarRow } from "../../src/notes/vaultIndices";

function row(overrides: Partial<CalendarRow>): CalendarRow {
  return {
    noteId: "note-1",
    title: "Standup",
    folder: "Calendar/",
    calendar: "work",
    start: "2026-11-05 09:00",
    end: "2026-11-05 09:15",
    allDay: false,
    occurrenceOf: null,
    occurrenceDate: null,
    conflicts: false,
    repeat: null,
    remind: "10m",
    repeatUnrecognized: false,
    ...overrides,
  };
}

beforeEach(() => {
  invoked.length = 0;
  saved.path = "/tmp/calendar.ics";
});

describe("exportIcsFile", () => {
  it("writes the series once and skips every projected occurrence", async () => {
    const rows = [
      row({ noteId: "series", repeat: "every week" }),
      row({ noteId: "week-1", occurrenceOf: "series", occurrenceDate: "2026-11-05" }),
      row({ noteId: "week-2", occurrenceOf: "series", occurrenceDate: "2026-11-12" }),
      row({ noteId: "one-off", title: "Dentist" }),
    ];
    const outcome = await exportIcsFile(rows, "2026-11-07");
    expect(outcome).toBe("saved");

    const write = invoked.find((call) => call.command === "plugin:text-file|export_text_file");
    expect(write).toBeDefined();
    const content = (write?.args as { content: string }).content;
    // Two notes, not four occurrences.
    expect(content.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(content).toContain("Dentist");
    expect(content).toContain("work");
  });

  it("does not export a rule the dialect does not recognise", async () => {
    await exportIcsFile(
      [row({ repeat: "every other tuesday", repeatUnrecognized: true })],
      "2026-11-07",
    );
    const content = (invoked[0]?.args as { content: string }).content;
    // The string must not appear as an RRULE: a rule this client cannot read is
    // not a rule it may write back and call supported.
    expect(content).not.toContain("every other tuesday");
  });

  it("reports failure rather than writing an empty calendar", async () => {
    const outcome = await exportIcsFile([], "2026-11-07");
    expect(outcome).toBe("failed");
    expect(invoked).toHaveLength(0);
  });

  it("writes nothing when the save dialog is dismissed", async () => {
    saved.path = null;
    const outcome = await exportIcsFile([row({})], "2026-11-07");
    expect(outcome).toBe("cancelled");
    expect(invoked).toHaveLength(0);
  });
});
