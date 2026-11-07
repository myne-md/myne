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
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const answer = { rows: [] as unknown[], unreadable: [] as unknown[] };
const failure = { on: false };

vi.mock("../../src/lib/calendar", () => ({
  vaultIndicesCalendarRange: async () => {
    if (failure.on) throw new Error("locked");
    return answer;
  },
}));

import { CalendarSurface } from "../../src/app/flows/CalendarSurface";

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
