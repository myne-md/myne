// Re-import matches on `uid` (myne-md/myne#1037).
//
// The failure this pins is the one a user would hit on the second import: every
// event duplicated, because nothing asked "do I already hold this one". The match
// key is the note's own `uid:`, read from the same range query the pane uses, so
// there is one owner of "what is on this calendar" and no second index over events.

import { beforeEach, describe, expect, it, vi } from "vitest";

const created: unknown[] = [];
const held = { rows: [] as { uid: string | null }[] };
const file: { name: string; result: unknown } = { name: "team.ics", result: null };

vi.mock("../../../src/lib/calendarIcs", async () => {
  const actual = await vi.importActual<typeof import("../../../src/lib/calendarIcs")>(
    "../../../src/lib/calendarIcs",
  );
  return { ...actual, readIcsFile: async () => file };
});
vi.mock("../../../src/notes/createEvent", () => ({
  createEvent: async (input: unknown) => {
    created.push(input);
    return "note-id";
  },
}));
vi.mock("../../../src/notes/vaultIndices", () => ({
  vaultIndicesCalendarRange: async () => ({ rows: held.rows, unreadable: [] }),
}));

import { importIcsIntoVault } from "../../../src/notes/calendar/icsImport";

function event(uid: string, title: string) {
  return {
    uid,
    title,
    start: "2026-11-05 09:00",
    end: null,
    allDay: false,
    repeat: null,
    description: null,
    remind: null,
    calendar: null,
  };
}

beforeEach(() => {
  created.length = 0;
  held.rows = [];
  file.result = { kind: "ok", events: [], warnings: [] };
});

describe("importIcsIntoVault", () => {
  it("creates the events this vault does not already hold", async () => {
    held.rows = [{ uid: "already-here@example.com" }];
    file.result = {
      kind: "ok",
      events: [event("already-here@example.com", "Old"), event("new@example.com", "New")],
      warnings: [],
    };
    const outcome = await importIcsIntoVault();
    expect(outcome).toMatchObject({ kind: "imported", created: 1, skipped: 1 });
    expect(created).toHaveLength(1);
  });

  it("carries the file's uid into the note it writes", async () => {
    file.result = { kind: "ok", events: [event("abc@example.com", "Standup")], warnings: [] };
    await importIcsIntoVault();
    expect(created[0]).toMatchObject({ uid: "abc@example.com", title: "Standup" });
  });

  it("imports everything when the calendar read yields nothing, rather than refusing the file", async () => {
    // A locked vault has no rows to compare against. Refusing the whole file would
    // be worse than an import the user can undo one note at a time.
    held.rows = [];
    file.result = { kind: "ok", events: [event("x@example.com", "X")], warnings: [] };
    const outcome = await importIcsIntoVault();
    expect(outcome).toMatchObject({ kind: "imported", created: 1, skipped: 0 });
  });

  it("reports a refusal by the codec's own reason", async () => {
    file.result = { kind: "too-large" };
    const outcome = await importIcsIntoVault();
    expect(outcome).toEqual({ kind: "refused", reason: "too-large" });
    expect(created).toHaveLength(0);
  });
});
