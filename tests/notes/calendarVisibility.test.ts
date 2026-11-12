// Which calendar an event belongs to, and which calendars a view draws
// (owner, 2026-11-10: "hangi calendarı seçmesi lazım", "takvimini kapatıp
// açılabilmesi lazım", "event de o renk ile backgroundunda olması lazım").
//
// Three claims, and each one is a place the two clients could disagree:
//
// 1. the FORM offers the calendars the vault knows rather than a free text box, so a
//    typo cannot invent a seventh calendar nobody assigned a colour to;
// 2. a calendar switched OFF is filtered out of the rows before any layout, so it is
//    absent from the month grid, the axis and the agenda alike (and cannot count as a
//    conflict) — and the choice is stored per name in the same prefs map the colours
//    use, so it survives a restart and merges per entry across devices;
// 3. the chip paints itself from ONE variable, which is what makes a calendar's colour
//    its event's background as well as its spine.

import { describe, expect, it } from "vitest";
import {
  CALENDAR_HIDDEN_SETTING_PREFIX,
  hiddenSettingFor,
  isCalendarVisible,
  knownCalendars,
  visibleRows,
} from "../../src/notes/calendar/visibility";
import { CALENDAR_COLOUR_SETTING_PREFIX, calendarColour } from "../../src/notes/calendar/colour";
import { emptyEventForm, formFromRow, planEventForm } from "../../src/notes/components/CalendarEventForm";

function row(calendar: string | null, date = "2026-11-05") {
  return {
    noteId: `note-${calendar ?? "none"}`,
    title: calendar ?? "None",
    folder: "",
    calendar,
    start: `${date} 09:00`,
    end: null,
    allDay: false,
    occurrenceOf: null,
    occurrenceDate: null,
    conflicts: false,
    repeat: null,
    repeatUnrecognized: false,
    remind: null,
    uid: null,
  };
}

describe("the calendars a vault knows", () => {
  it("is the names with a colour plus the names an event carries, deduplicated", () => {
    // `Work` and `work` are one calendar: the fold is the same one the colour
    // resolver applies, so a name typed with a capital does not become a second.
    const settings = { [`${CALENDAR_COLOUR_SETTING_PREFIX}Work`]: "group-2" };
    const names = knownCalendars(settings, [row("work"), row("Side"), row("Work")], CALENDAR_COLOUR_SETTING_PREFIX);
    expect(names).toEqual(["Side", "Work"]);
  });

  it("does not list a calendar that only appears as a hidden flag", () => {
    const settings = { [`${CALENDAR_HIDDEN_SETTING_PREFIX}Old`]: "1" };
    expect(knownCalendars(settings, [], CALENDAR_COLOUR_SETTING_PREFIX)).toEqual(["Old"]);
  });
});

describe("hiding a calendar", () => {
  it("removes its events from the rows a view draws, and nothing else", () => {
    const settings = { [`${CALENDAR_HIDDEN_SETTING_PREFIX}Work`]: "1" };
    const rows = [row("Work"), row("Side"), row(null)];
    expect(visibleRows(settings, rows).map((r) => r.calendar)).toEqual(["Side", null]);
  });

  it("is per name and case-folded, so a stray capital does not leak events", () => {
    const settings = { [`${CALENDAR_HIDDEN_SETTING_PREFIX}work`]: "1" };
    expect(isCalendarVisible(settings, "WORK")).toBe(false);
    expect(isCalendarVisible(settings, "Side")).toBe(true);
  });

  it("is written as one prefs entry, and shown is the absence of it", () => {
    expect(hiddenSettingFor("Work", true)).toEqual({ key: "hidden.Work", value: "1" });
    // `null` deletes the entry rather than storing "0": a visible calendar is the
    // default, and a second spelling of the default is a second state to merge.
    expect(hiddenSettingFor("Work", false)).toEqual({ key: "hidden.Work", value: null });
  });
});

describe("the event form's calendar row", () => {
  it("emits the chosen calendar", () => {
    const plan = planEventForm({ ...emptyEventForm("2026-11-05", "Work"), startTime: "09:00", title: "Standup" });
    expect(plan.ok).toBe(true);
    expect(plan.ok && plan.input.calendar).toBe("Work");
  });

  it("refuses to create an event with no calendar", () => {
    // Owner, 2026-11-11: "calendaari olmayan bir event olusturulamamali". The
    // calendar is what colours the event and what the view filter switches off, so
    // an event without one is a row nothing can find or hide.
    const plan = planEventForm(
      { ...emptyEventForm("2026-11-05", null), startTime: "09:00", title: "Standup" },
      undefined,
      { requireCalendar: true },
    );
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.refusal).toMatchObject({
      field: "calendar",
      reason: "calendar-required",
    });
  });

  it("still lets an event that already has no calendar be edited", () => {
    // The rule is about CREATING. A note hand-written elsewhere carries no
    // calendar, and refusing to save it back would make it uneditable rather than
    // fixing its colour.
    const plan = planEventForm({ ...emptyEventForm("2026-11-05", null), startTime: "09:00", title: "Coffee" });
    expect(plan.ok).toBe(true);
    expect(plan.ok && plan.input.calendar).toBeNull();
  });

  it("keeps a name the vault does not know instead of reassigning the event", () => {
    // A note hand-written elsewhere may carry a calendar nobody assigned a colour
    // to. Opening the form must not silently move it to another one.
    const values = formFromRow(row("Side"));
    const plan = planEventForm({ ...values, title: "Standup" });
    expect(plan.ok && plan.input.calendar).toBe("Side");
  });
});

describe("the chip's colour", () => {
  it("is one variable, so the spine and the wash cannot drift", () => {
    // The value a row hands the stylesheet: `var(--group-N)` from the token the user
    // assigned, never a colour literal, so a custom theme repaints the calendar.
    expect(calendarColour({ [`${CALENDAR_COLOUR_SETTING_PREFIX}Work`]: "group-olive" }, "Work")).toBe(
      "var(--group-olive, var(--fg-2))",
    );
  });

  it("still answers for a calendar nobody assigned a colour to", () => {
    // Two calendars that collide are acceptable; one that renders identically to its
    // neighbour because the user never opened Settings is not.
    const colour = calendarColour({}, "Side");
    expect(colour.startsWith("var(--group-")).toBe(true);
    expect(calendarColour({}, "Side")).toBe(colour);
    expect(calendarColour({}, "Other")).not.toBe(colour);
  });
});
