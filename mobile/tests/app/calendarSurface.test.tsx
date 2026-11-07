// @vitest-environment jsdom
//
// The phone's calendar (myne-md/myne#1037).
//
// What is under test is the SCREEN's own behaviour against the host answer: the
// month it draws comes from the shared grid math (not re-tested here, it has its
// own suite), a day with events shows a dot, picking that day lists them, and a
// failed read says so instead of rendering an empty month that reads as "nothing
// planned".

import i18n from "@myne/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const answer = { rows: [] as unknown[], unreadable: [] as unknown[] };
const failure = { on: false };

vi.mock("../../src/lib/calendar", () => ({
  vaultIndicesCalendarRange: async () => {
    if (failure.on) throw new Error("locked");
    return answer;
  },
}));

import { CalendarSurface } from "../../src/app/flows/CalendarSurface";
import { EventComposerSheet } from "../../src/app/flows/EventComposerSheet";

// Partial mock: `createEventNote` reaches `noteCreate`, and other modules in this
// graph (conflict copies, the list) import their own members from the same file, so
// replacing the whole module breaks them for a reason that has nothing to do with
// the subject here.
vi.mock("../../src/lib/notes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/notes")>();
  return {
    ...actual,
    noteCreate: vi.fn(async () => "note-id"),
    // The cancel path reads the series note and writes it back, so both halves are
    // mocked: a test that mocked only the write would exercise a read it never
    // supplied and pass on an empty body.
    noteRead: vi.fn(async () => ""),
    noteUpdate: vi.fn(async () => undefined),
  };
});

function projected(date: string, title: string, seriesId: string) {
  return {
    ...row(date, title),
    noteId: seriesId,
    occurrenceOf: seriesId,
    occurrenceDate: date,
  };
}

function row(date: string, title: string) {
  return {
    noteId: `note-${title}`,
    title,
    folder: "Calendar/",
    calendar: "work",
    start: `${date} 09:00`,
    end: null,
    allDay: false,
    occurrenceOf: null,
    occurrenceDate: null,
    conflicts: false,
    repeat: null,
    remind: null,
    repeatUnrecognized: false,
    uid: null,
  };
}

beforeEach(async () => {
  // The write assertions read `noteCreate`'s calls, so each case starts from an
  // empty record: `mock.calls[0]` otherwise belongs to whichever composer case ran
  // first, which is a green test measuring the previous test.
  vi.clearAllMocks();
  await i18n.changeLanguage("en");
  answer.rows = [];
  failure.on = false;
});

afterEach(cleanup);

describe("CalendarSurface", () => {
  it("draws a day with an event with a dot, and lists it when the day is picked", async () => {
    answer.rows = [row("2026-11-05", "Standup")];
    render(<CalendarSurface onClose={() => undefined} />);
    const cell = await screen.findByTestId("calendar.cell.2026-11-05");
    expect(screen.getByTestId("calendar.dot.2026-11-05")).toBeTruthy();
    fireEvent.click(cell);
    expect(await screen.findByTestId("calendar.event.note-Standup")).toBeTruthy();
  });

  it("says a picked day is empty rather than rendering nothing", async () => {
    answer.rows = [];
    render(<CalendarSurface onClose={() => undefined} />);
    fireEvent.click(await screen.findByTestId("calendar.cell.2026-11-05"));
    expect(await screen.findByTestId("calendar.day-empty")).toBeTruthy();
  });

  it("reports a failed read instead of an empty month", async () => {
    failure.on = true;
    render(<CalendarSurface onClose={() => undefined} />);
    expect(await screen.findByTestId("calendar.error")).toBeTruthy();
  });

  it("closes when the header's close control is pressed", async () => {
    const onClose = vi.fn();
    render(<CalendarSurface onClose={onClose} />);
    fireEvent.click(await screen.findByTestId("calendar.close"));
    expect(onClose).toHaveBeenCalled();
  });
});

// ── The composer (writing, not just reading) ─────────────────────────────────
//
// A phone that can only READ the calendar is a calendar you cannot use from a
// phone, so the surface carries a "+" and a three-field composer. What is asserted
// here is the write: the note the composer produces, and the refusal to produce one
// from a time no reader could parse.
describe("EventComposerSheet", () => {
  it("creates the event on the day it was opened for, with the time it was given", async () => {
    const { noteCreate } = await import("../../src/lib/notes");
    const onCreated = vi.fn();
    render(<EventComposerSheet date="2026-11-05" onClose={() => undefined} onCreated={onCreated} />);
    fireEvent.change(screen.getByTestId("calendar.composer.title-field"), {
      target: { value: "Standup" },
    });
    fireEvent.click(screen.getByTestId("calendar.composer.create"));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    // The BYTES, not the input object: an event is a note, so the contract is what
    // lands in the file, and it has to be what the desktop writer emits too.
    const body = vi.mocked(noteCreate).mock.calls.at(-1)?.[0] as string;
    // The title lands in the FRONTMATTER, not as an H1: `patchTitleField` writes
    // the field the dialect reads, and this note has no body to carry a heading.
    expect(body).toMatch(/title: Standup/);
    expect(body).toMatch(/kind:\s*event/);
    expect(body).toMatch(/start:\s*2026-11-05 09:00/);
    expect(body).toMatch(/folder:\s*Calendar/);
  });

  it("writes the repeat phrase and the reminder lead the dialect spells", async () => {
    const { formatRecurrenceRule } = await import("@myne/dialect/recurrence");
    const { noteCreate } = await import("../../src/lib/notes");
    render(
      <EventComposerSheet date="2026-11-05" onClose={() => undefined} onCreated={() => undefined} />,
    );
    fireEvent.change(screen.getByTestId("calendar.composer.title-field"), {
      target: { value: "Standup" },
    });
    fireEvent.click(await screen.findByTestId("calendar.composer.repeat-weekly"));
    fireEvent.click(screen.getByTestId("calendar.composer.remind-1h"));
    fireEvent.click(screen.getByTestId("calendar.composer.create"));
    await waitFor(() => expect(vi.mocked(noteCreate)).toHaveBeenCalled());
    const body = vi.mocked(noteCreate).mock.calls.at(-1)?.[0] as string;
    // The phrase the composer offers IS the phrase the shared formatter emits for
    // that rule, so the two clients cannot spell one rule two ways.
    expect(body).toContain(`repeat: ${formatRecurrenceRule({ kind: "interval", unit: "week", count: 1 })}`);
    expect(body).toContain("remind: 1h");
  });

  it("refuses an unreadable time rather than writing one", async () => {
    render(
      <EventComposerSheet date="2026-11-05" onClose={() => undefined} onCreated={() => undefined} />,
    );
    fireEvent.change(screen.getByTestId("calendar.composer.title-field"), {
      target: { value: "Standup" },
    });
    fireEvent.change(screen.getByTestId("calendar.composer.start-field"), {
      target: { value: "9am" },
    });
    expect(await screen.findByTestId("calendar.composer.invalid")).toBeTruthy();
    expect(screen.getByTestId("calendar.composer.create")).toHaveProperty("disabled", true);
  });
});

describe("cancelling one appearance", () => {
  it("writes the date onto the series note and re-reads", async () => {
    // The write path is shared with the desktop pane, so what this asserts is that
    // the phone reaches it with the SERIES id and the occurrence's own date rather
    // than with the series' start: getting that wrong cancels the first occurrence
    // every time, which looks like "skip does nothing" to the user.
    answer.rows = [projected("2026-11-05", "Standup", "standup")];
    const notes = await import("../../src/lib/notes");
    vi.mocked(notes.noteRead).mockResolvedValue(
      "---\ntitle: Standup\nkind: event\nstart: 2026-11-03 09:15\nrepeat: every tuesday\n---\n\n",
    );
    render(<CalendarSurface onClose={() => undefined} />);
    // The list is what the picked day shows, so the cell is pressed first: the
    // affordance lives on the day, not on the month grid.
    fireEvent.click(await screen.findByTestId("calendar.cell.2026-11-05"));
    const skipButton = await screen.findByTestId("calendar.skip.standup");
    fireEvent.click(skipButton);
    await waitFor(() => expect(vi.mocked(notes.noteUpdate)).toHaveBeenCalled());
    const [noteId, body] = vi.mocked(notes.noteUpdate).mock.calls.at(-1) ?? [];
    expect(noteId).toBe("standup");
    expect(body).toContain("skip: 2026-11-05");
  });
});

describe("retiming one appearance", () => {
  it("writes the typed clock onto the series note and keeps the day", async () => {
    answer.rows = [projected("2026-11-05", "Standup", "standup")];
    const notes = await import("../../src/lib/notes");
    vi.mocked(notes.noteRead).mockResolvedValue(
      "---\ntitle: Standup\nkind: event\nstart: 2026-11-03 09:15\nend: 2026-11-03 09:45\nrepeat: every tuesday\n---\n\n",
    );
    render(<CalendarSurface onClose={() => undefined} />);
    fireEvent.click(await screen.findByTestId("calendar.cell.2026-11-05"));
    fireEvent.click(await screen.findByTestId("calendar.retime.standup"));
    fireEvent.change(await screen.findByTestId("calendar.retime.time-field"), {
      target: { value: "14:00" },
    });
    fireEvent.click(screen.getByTestId("calendar.retime.save"));
    await waitFor(() => expect(vi.mocked(notes.noteUpdate)).toHaveBeenCalled());
    const [noteId, body] = vi.mocked(notes.noteUpdate).mock.calls.at(-1) ?? [];
    expect(noteId).toBe("standup");
    expect(body).toContain("override: 2026-11-05 14:00");
    // The series' own start and end are untouched: only the one appearance moved.
    expect(body).toContain("start: 2026-11-03 09:15");
    expect(body).toContain("end: 2026-11-03 09:45");
  });
});
