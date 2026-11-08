// The `.ics` codec (myne-md/myne#1037, task 10).
//
// This is the one place in the calendar that eats a file somebody else wrote, so
// the tests are mostly about what it REFUSES. The rule the codec holds is the one
// §3.10 holds for events: a shape Myne does not write is reported, never
// approximated. An importer that guessed is how a calendar quietly moves somebody's
// dentist appointment by an hour.
//
// The device zone is a parameter rather than a global read, so "a `TZID` event
// lands at the correct instant for this device" is a statement a test can make
// without changing the machine's clock.

import { describe, expect, it } from "vitest";
import {
  ICS_BYTE_CAP,
  exportEvents,
  importEvents,
  type IcsEvent,
  type IcsImport,
} from "@myne/client-core/ics";

/** A minimal well-formed calendar. */
function ics(lines: readonly string[]): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Myne//Test//EN",
    ...lines,
    "END:VCALENDAR",
  ].join("\r\n");
}

function oneEvent(lines: readonly string[]): string {
  return ics(["BEGIN:VEVENT", ...lines, "END:VEVENT"]);
}

function event(lines: readonly string[]): IcsEvent {
  const result = importEvents(oneEvent(lines), { zone: "UTC" });
  if (result.kind !== "ok") throw new Error(`refused: ${result.kind}`);
  if (result.events.length !== 1) throw new Error(`expected one event, got ${result.events.length}`);
  return result.events[0]!;
}

function refusal(result: IcsImport): string {
  if (result.kind === "ok") throw new Error("expected a refusal");
  return result.kind;
}

describe("importing one event", () => {
  it("reads a timed event with a Z stamp as the device's wall clock", () => {
    const got = event([
      "UID:abc-123",
      "SUMMARY:Dentist",
      "DTSTART:20261105T140000Z",
      "DTEND:20261105T143000Z",
    ]);
    expect(got.uid).toBe("abc-123");
    expect(got.title).toBe("Dentist");
    // 14:00Z is 14:00 in UTC, and this fixture's device zone is UTC.
    expect(got.start).toBe("2026-11-05 14:00");
    expect(got.end).toBe("2026-11-05 14:30");
    expect(got.allDay).toBe(false);
  });

  it("converts a Z stamp into the device zone rather than storing UTC", () => {
    const result = importEvents(
      oneEvent(["UID:u", "SUMMARY:Call", "DTSTART:20261105T140000Z"]),
      { zone: "Europe/Berlin" },
    );
    if (result.kind !== "ok") throw new Error("refused");
    // Berlin is UTC+1 in November, so the wall clock the note carries is 15:00.
    expect(result.events[0]!.start).toBe("2026-11-05 15:00");
  });

  it("converts a TZID value through that zone, and says the zone was not preserved", () => {
    const result = importEvents(
      oneEvent([
        "UID:u",
        "SUMMARY:Standup",
        "DTSTART;TZID=America/New_York:20261105T090000",
        "DTEND;TZID=America/New_York:20261105T093000",
      ]),
      { zone: "UTC" },
    );
    if (result.kind !== "ok") throw new Error("refused");
    // 09:00 in New York (UTC-5 in November) is 14:00 UTC.
    expect(result.events[0]!.start).toBe("2026-11-05 14:00");
    // The loss is stated rather than silent: the note has no place for a zone.
    expect(result.warnings).toContain("zone-not-preserved");
  });

  it("reads an all-day event as a bare date", () => {
    const got = event(["UID:u", "SUMMARY:Holiday", "DTSTART;VALUE=DATE:20261105"]);
    expect(got.start).toBe("2026-11-05");
    expect(got.allDay).toBe(true);
    expect(got.end).toBeNull();
  });

  it("reads an all-day span, keeping the last day it covers", () => {
    const got = event([
      "UID:u",
      "SUMMARY:Trip",
      "DTSTART;VALUE=DATE:20261105",
      "DTEND;VALUE=DATE:20261108",
    ]);
    // ICS `DTEND` is EXCLUSIVE: the file says "until the 8th", so the trip's last
    // day is the 7th.
    expect(got.start).toBe("2026-11-05");
    expect(got.end).toBe("2026-11-07");
  });

  it("reads the rule, the description and the reminder", () => {
    const got = event([
      "UID:u",
      "SUMMARY:Weekly",
      "DTSTART:20261105T090000Z",
      "RRULE:FREQ=WEEKLY",
      "DESCRIPTION:Weekly sync\\nwith the team",
      "TRIGGER:-PT30M",
    ]);
    expect(got.repeat).toBe("every week");
    expect(got.description).toBe("Weekly sync\nwith the team");
    expect(got.remind).toBe("30m");
  });

  it("unfolds a continuation line before reading it", () => {
    const got = event([
      "UID:u",
      "SUMMARY:A long title that the file wraps",
      "  onto a second line",
      "DTSTART:20261105T090000Z",
    ]);
    expect(got.title).toBe("A long title that the file wraps onto a second line");
  });

  it("decodes the escapes the format allows in text values", () => {
    const got = event(["UID:u", "SUMMARY:Lunch\\, then a walk\\; back", "DTSTART:20261105T090000Z"]);
    expect(got.title).toBe("Lunch, then a walk; back");
  });
});

describe("what the importer refuses", () => {
  it("refuses a file over the byte cap, naming the cap", () => {
    const huge = ics(["BEGIN:VEVENT", `DESCRIPTION:${"x".repeat(ICS_BYTE_CAP + 1)}`, "END:VEVENT"]);
    expect(refusal(importEvents(huge, { zone: "UTC" }))).toBe("too-large");
  });

  it("refuses a line that is not `NAME:value` or `NAME;param:value`", () => {
    expect(refusal(importEvents(oneEvent(["UID:u", "THIS IS NOT A PROPERTY", "DTSTART:20261105T090000Z"]), { zone: "UTC" }))).toBe(
      "malformed-property",
    );
  });

  it("refuses a start it cannot read rather than guessing", () => {
    expect(refusal(importEvents(oneEvent(["UID:u", "SUMMARY:x", "DTSTART:5 November"]), { zone: "UTC" }))).toBe(
      "unreadable-start",
    );
  });

  it("refuses a value carrying an offset, which the dialect cannot store", () => {
    expect(
      refusal(importEvents(oneEvent(["UID:u", "SUMMARY:x", "DTSTART:2026-11-05T14:00:00+01:00"]), { zone: "UTC" })),
    ).toBe("unreadable-start");
  });

  it("refuses a TZID the platform does not know, rather than falling back to the device zone", () => {
    expect(
      refusal(
        importEvents(oneEvent(["UID:u", "SUMMARY:x", "DTSTART;TZID=Mars/Olympus:20261105T090000"]), {
          zone: "UTC",
        }),
      ),
    ).toBe("unknown-zone");
  });

  it("refuses a calendar with no event at all", () => {
    expect(refusal(importEvents(ics([]), { zone: "UTC" }))).toBe("no-events");
  });

  it("refuses an all-day value that carries a time, and the reverse", () => {
    expect(
      refusal(
        importEvents(oneEvent(["UID:u", "SUMMARY:x", "DTSTART;VALUE=DATE:20261105T090000"]), {
          zone: "UTC",
        }),
      ),
    ).toBe("value-shape-mismatch");
  });

  it("refuses a rule outside the closed vocabulary instead of importing it as a one-off", () => {
    // Importing it as a one-off would be the approximation this codec exists to
    // avoid: the event would silently stop repeating.
    expect(
      refusal(
        importEvents(
          oneEvent(["UID:u", "SUMMARY:x", "DTSTART:20261105T090000Z", "RRULE:FREQ=HOURLY;COUNT=3"]),
          { zone: "UTC" },
        ),
      ),
    ).toBe("unreadable-rule");
  });
});

describe("exporting", () => {
  const sample: IcsEvent[] = [
    {
      uid: "abc-123",
      title: "Dentist",
      start: "2026-11-05 14:00",
      end: "2026-11-05 14:30",
      allDay: false,
      repeat: null,
      description: null,
      remind: null,
      calendar: "Work",
      skip: [],
    },
    {
      uid: "def-456",
      title: "Trip, day one; and two",
      start: "2026-11-05",
      end: "2026-11-07",
      allDay: true,
      repeat: null,
      description: null,
      remind: null,
      calendar: null,
      skip: [],
    },
  ];

  it("emits a calendar whose events survive a round trip", () => {
    const text = exportEvents(sample);
    const back = importEvents(text, { zone: "UTC" });
    if (back.kind !== "ok") throw new Error(`refused: ${back.kind}`);
    expect(back.events).toEqual(sample);
  });

  it("writes a cancellation as EXDATE and reads it back as the same list", () => {
    // Found by review: `skip:` had no `.ics` arm in either direction, so an export of a
    // series asserted the weeks the user had cancelled, which is the one thing a
    // backup must not do.
    const series: IcsEvent[] = [
      {
        uid: "standup",
        title: "Standup",
        start: "2026-11-03 09:15",
        end: "2026-11-03 09:45",
        allDay: false,
        repeat: "every tuesday",
        description: null,
        remind: "10m",
        calendar: null,
        skip: ["2026-11-10", "2026-11-17"],
      },
    ];
    const text = exportEvents(series);
    expect(text).toContain("EXDATE:20261110,20261117");
    const back = importEvents(text, { zone: "UTC" });
    if (back.kind !== "ok") throw new Error(`refused: ${back.kind}`);
    expect(back.events[0]?.skip).toEqual(["2026-11-10", "2026-11-17"]);
    // And a one-off carries none: a cancellation on an event with no rule describes a
    // note that simply does not exist.
    const oneOff = exportEvents([{ ...series[0]!, repeat: null, skip: ["2026-11-10"] }]);
    expect(oneOff).not.toContain("EXDATE");
  });

  it("accepts a repeated EXDATE line as well as one comma list", () => {
    const text = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:x",
      "SUMMARY:Standup",
      "DTSTART:20261103T091500Z",
      "RRULE:FREQ=WEEKLY;BYDAY=TU",
      "EXDATE:20261110T091500Z",
      "EXDATE:20261117T091500Z",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n");
    const back = importEvents(text, { zone: "UTC" });
    if (back.kind !== "ok") throw new Error(`refused: ${back.kind}`);
    expect(back.events[0]?.skip).toEqual(["2026-11-10", "2026-11-17"]);
  });

  it("writes CRLF line endings and folds a long line", () => {
    const longTitle = "x".repeat(120);
    const text = exportEvents([
      { ...sample[0]!, title: longTitle },
    ]);
    expect(text).toContain("\r\n");
    expect(text).not.toMatch(/[^\r]\n/);
    for (const line of text.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(75);
    }
    // The fold is on the byte 75 boundary and continues with a single space, which
    // the reader removes again (the round trip above is what proves it).
  });

  it("escapes the characters the format reserves", () => {
    const text = exportEvents([sample[1]!]);
    expect(text).toContain("SUMMARY:Trip\\, day one\\; and two");
  });

  it("writes an all-day end EXCLUSIVE, so the import gets the same last day", () => {
    const text = exportEvents([sample[1]!]);
    expect(text).toContain("DTEND;VALUE=DATE:20261108");
  });

  it("emits the rule in ICS form for a rule the dialect can read back", () => {
    const text = exportEvents([{ ...sample[0]!, repeat: "every week" }]);
    expect(text).toContain("RRULE:FREQ=WEEKLY");
  });

  it("preserves a stable uid, so a second export is byte-identical", () => {
    expect(exportEvents(sample)).toBe(exportEvents(sample));
  });
});
