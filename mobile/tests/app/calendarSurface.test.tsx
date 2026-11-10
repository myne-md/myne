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
import { formatLocalDate } from "../../src/lib/localDateTime";

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
    // No `folder:` line and no `Calendar/` folder: an event lands at the vault
    // root unless the caller names a folder (owner, 2026-11-08). The assertion is
    // the ABSENCE, because a default that reappears here is a folder the user
    // never asked for and cannot get rid of while the deliberate-folder registry
    // remembers it.
    expect(body).not.toMatch(/folder:/);
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

// ── The three views and the two gestures ─────────────────────────────────────
//
// A phone that only shows a month and lists a day is a calendar you cannot move an
// event on. These assert the axis: the same hour grid the desktop draws, a press on
// empty space that opens the form ON that minute, a drag of a block's body that
// reschedules it in ONE write, and a drag of its end that changes that instant.
//
// jsdom computes no layout, so a column's box is stubbed to one pixel per minute:
// with `height: 1440` a pointer at y=540 IS 09:00, and the assertion is about the
// mapping rather than about a rect.
/** The day the axis opens on: `todayCivil()` in the surface, so the tests agree. */
const TODAY = formatLocalDate(new Date());

function stubColumn(host: HTMLElement, date: string): HTMLElement {
  const column = host.querySelector<HTMLElement>(`[data-testid="calendar.cell.${date}"]`);
  if (column === null) throw new Error(`no column for ${date}`);
  column.getBoundingClientRect = () =>
    ({ top: 0, left: 0, bottom: 1440, right: 200, width: 200, height: 1440, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  return column;
}

function pointer(target: EventTarget, type: string, minutes: number): void {
  fireEvent.pointerDown;
  target.dispatchEvent(
    new PointerEvent(type, { bubbles: true, cancelable: true, clientX: 100, clientY: minutes, button: 0, pointerId: 1 }),
  );
}

describe("choosing a view", () => {
  it("draws the hour axis for the day view, with a block over its own minutes", async () => {
    answer.rows = [{ ...row(TODAY, "Standup"), start: `${TODAY} 09:00`, end: `${TODAY} 10:30` }];
    const { container } = render(<CalendarSurface onClose={() => undefined} />);
    fireEvent.click(await screen.findByTestId("calendar.view-day"));
    const block = await screen.findByTestId("calendar.block");
    // 09:00 is minute 540 and the block spans ninety of them, so it covers the
    // hour after nine instead of sitting inside the hour it starts in.
    expect(block.getAttribute("data-start-minute")).toBe("540");
    expect(block.getAttribute("data-end-minute")).toBe("630");
    expect(container.querySelector('[data-hour="9"]')).toBeTruthy();
  });

  it("shows all-day rows in the band above the axis, not at midnight", async () => {
    answer.rows = [{ ...row(TODAY, "Trip"), start: TODAY, end: null, allDay: true }];
    render(<CalendarSurface onClose={() => undefined} />);
    fireEvent.click(await screen.findByTestId("calendar.view-week"));
    expect(await screen.findByTestId("calendar.allday")).toBeTruthy();
    expect(screen.queryByTestId("calendar.block")).toBeNull();
  });
});

describe("creating from the axis", () => {
  it("opens the form on the hour that was tapped", async () => {
    const { container } = render(<CalendarSurface onClose={() => undefined} />);
    fireEvent.click(await screen.findByTestId("calendar.view-day"));
    stubColumn(container, TODAY);
    // A press that does not move is a TAP: it opens the form at 14:00 rather than
    // asking for a drag on a phone keyboard-less surface.
    pointer(container.querySelector('[data-hour="14"]')!, "pointerdown", 840);
    pointer(window, "pointerup", 840);
    const startField = await screen.findByTestId("calendar.composer.start-field");
    expect((startField as HTMLInputElement).value).toBe("14:00");
  });

  it("opens the form over the RANGE a drag drew", async () => {
    const { container } = render(<CalendarSurface onClose={() => undefined} />);
    fireEvent.click(await screen.findByTestId("calendar.view-day"));
    stubColumn(container, TODAY);
    pointer(container.querySelector('[data-hour="9"]')!, "pointerdown", 540);
    pointer(window, "pointermove", 660);
    pointer(window, "pointerup", 660);
    const startField = await screen.findByTestId("calendar.composer.start-field");
    const endField = screen.getByTestId("calendar.composer.end-field");
    expect((startField as HTMLInputElement).value).toBe("09:00");
    expect((endField as HTMLInputElement).value).toBe("11:00");
  });
});

describe("moving an event on the axis", () => {
  it("reschedules the whole span in one write, keeping its duration", async () => {
    answer.rows = [{ ...row(TODAY, "Standup"), start: `${TODAY} 09:00`, end: `${TODAY} 09:30` }];
    const notes = await import("../../src/lib/notes");
    vi.mocked(notes.noteRead).mockResolvedValue(
      `---\ntitle: Standup\nkind: event\nstart: ${TODAY} 09:00\nend: ${TODAY} 09:30\n---\n\n`,
    );
    const { container } = render(<CalendarSurface onClose={() => undefined} />);
    fireEvent.click(await screen.findByTestId("calendar.view-day"));
    stubColumn(container, TODAY);
    const block = await screen.findByTestId("calendar.block");
    // Pressed at the block's own start and dragged to 10:00: both edges move an
    // hour, so the event is 10:00-10:30 rather than a thirty-minute stretch.
    pointer(block, "pointerdown", 540);
    pointer(window, "pointermove", 600);
    pointer(window, "pointerup", 600);
    await waitFor(() => expect(vi.mocked(notes.noteUpdate)).toHaveBeenCalledTimes(1));
    const [, body] = vi.mocked(notes.noteUpdate).mock.calls.at(-1) ?? [];
    expect(body).toContain(`start: ${TODAY} 10:00`);
    expect(body).toContain(`end: ${TODAY} 10:30`);
  });

  it("moves one instant when an end grip is dragged", async () => {
    answer.rows = [{ ...row(TODAY, "Standup"), start: `${TODAY} 09:00`, end: `${TODAY} 09:30` }];
    const notes = await import("../../src/lib/notes");
    vi.mocked(notes.noteRead).mockResolvedValue(
      `---\ntitle: Standup\nkind: event\nstart: ${TODAY} 09:00\nend: ${TODAY} 09:30\n---\n\n`,
    );
    const { container } = render(<CalendarSurface onClose={() => undefined} />);
    fireEvent.click(await screen.findByTestId("calendar.view-day"));
    stubColumn(container, TODAY);
    const grip = (await screen.findByTestId("calendar.block")).querySelector('[data-edge="end"]')!;
    pointer(grip, "pointerdown", 570);
    pointer(window, "pointermove", 690);
    pointer(window, "pointerup", 690);
    await waitFor(() => expect(vi.mocked(notes.noteUpdate)).toHaveBeenCalledTimes(1));
    const [, body] = vi.mocked(notes.noteUpdate).mock.calls.at(-1) ?? [];
    expect(body).toContain(`end: ${TODAY} 11:30`);
    expect(body).toContain(`start: ${TODAY} 09:00`);
  });

  it("opens the editor on a TAP, prefilled, and saves through the shared writer", async () => {
    answer.rows = [{ ...row(TODAY, "Standup"), start: `${TODAY} 09:00`, end: `${TODAY} 09:30` }];
    const notes = await import("../../src/lib/notes");
    vi.mocked(notes.noteRead).mockResolvedValue(
      `---\ntitle: Standup\nkind: event\nstart: ${TODAY} 09:00\nend: ${TODAY} 09:30\n---\n\n`,
    );
    const { container } = render(<CalendarSurface onClose={() => undefined} />);
    fireEvent.click(await screen.findByTestId("calendar.view-day"));
    stubColumn(container, TODAY);
    pointer(await screen.findByTestId("calendar.block"), "pointerdown", 540);
    pointer(window, "pointerup", 540);
    const titleField = (await screen.findByTestId("calendar.composer.title-field")) as HTMLInputElement;
    expect(titleField.value).toBe("Standup");
    fireEvent.change(titleField, { target: { value: "Standup with tea" } });
    fireEvent.click(screen.getByTestId("calendar.composer.create"));
    await waitFor(() => expect(vi.mocked(notes.noteUpdate)).toHaveBeenCalledTimes(1));
    const [noteId, body] = vi.mocked(notes.noteUpdate).mock.calls.at(-1) ?? [];
    expect(noteId).toBe("note-Standup");
    expect(body).toContain("title: Standup with tea");
  });
});
