// The event vocabulary (myne-md/myne#1037, task 1). Spec: markdown-dialect.md §3.10.
//
// What each case is protecting, because a green reader proves nothing on its own:
//
// - the value-strict `kind` read is the IDENTITY of an event, so a quoted or
//   capitalized value must read as an ordinary note rather than file someone's
//   markdown into the calendar;
// - a value that does not type is REFUSED and surfaced, never repaired (§3.8.3),
//   which is why `2026-02-31` and an offset-bearing timestamp are cases here;
// - `repeat` is delegated to the closed §3.8.7 vocabulary, so an unrecognized
//   phrase must come back as unrecognized rather than as "no repeat": that
//   difference is the one where a user believes a meeting repeats and finds out
//   months later that it did not.

import { describe, expect, it } from "vitest";
import { readKindFromFmBody } from "../../src/dialect/surgery";
import {
  appendSkipDate,
  clearOverride,
  formatEventInstant,
  parseEventInstant,
  parseReminderLead,
  eventNoteBytes,
  parseOverrides,
  parseSkipDates,
  readEventFromFmBody,
  setOverride,
} from "../../src/dialect/event";

function fm(...lines: string[]): string {
  return lines.join("\n");
}

describe("readEventFromFmBody: identity", () => {
  it("reads kind: event as an event", () => {
    const read = readEventFromFmBody(fm("kind: event", "start: 2026-11-05 09:00"));
    expect(read.state).toBe("ok");
    if (read.state !== "ok") throw new Error("unreachable");
    expect(read.event.start.time).toBe("09:00");
    expect(read.event.allDay).toBe(false);
  });

  it("agrees with the value-strict kind reader", () => {
    expect(readKindFromFmBody(fm("kind: event"))).toBe("event");
  });

  it("leaves a non-event note absent, including the other canonical kinds", () => {
    for (const body of [
      fm("title: notes"),
      fm("kind: task", "start: 2026-11-05 09:00"),
      fm("kind: drawing"),
      fm('kind: "event"', "start: 2026-11-05"),
      fm("kind: Event", "start: 2026-11-05"),
      fm("kind: chore", "start: 2026-11-05"),
    ]) {
      expect(readEventFromFmBody(body), body).toEqual({ state: "absent" });
    }
  });

  it("resolves a duplicated kind line on the first, like every other managed field", () => {
    expect(readEventFromFmBody(fm("kind: event", "kind: task", "start: 2026-11-05")).state).toBe(
      "ok",
    );
    expect(readEventFromFmBody(fm("kind: task", "kind: event", "start: 2026-11-05")).state).toBe(
      "absent",
    );
  });
});

describe("readEventFromFmBody: the time shape", () => {
  it("treats a date with no time as all day", () => {
    const read = readEventFromFmBody(fm("kind: event", "start: 2026-11-05"));
    if (read.state !== "ok") throw new Error("expected ok");
    expect(read.event.allDay).toBe(true);
    expect(read.event.start).toEqual({ date: { year: 2026, month: 11, day: 5 }, time: null });
  });

  it("accepts both separators and both time precisions", () => {
    for (const value of ["2026-11-05 09:00", "2026-11-05T09:00", "2026-11-05T09:00:30"]) {
      const parsed = parseEventInstant(value);
      expect(parsed, value).not.toBeNull();
      expect(parsed?.time).toBe(value.length > 17 ? "09:00:30" : "09:00");
    }
  });

  it("refuses what it cannot type rather than repairing it", () => {
    for (const value of [
      "2026-02-31",
      "2026-13-01",
      "2026-11-05T24:00",
      "2026-11-05T09:60",
      "2026-11-05T09:00:00Z",
      "2026-11-05T09:00:00+03:00",
      "2026-11-05 9:00",
      "2026-11-05 09.00",
      "05/11/2026",
      "2026-11",
    ]) {
      expect(parseEventInstant(value), value).toBeNull();
    }
  });

  it("round-trips the emitted form, and emits one separator only", () => {
    const instant = parseEventInstant("2026-11-05T09:00");
    if (instant === null) throw new Error("expected an instant");
    expect(formatEventInstant(instant)).toBe("2026-11-05 09:00");
    expect(parseEventInstant(formatEventInstant(instant))).toEqual(instant);
  });
});

describe("readEventFromFmBody: the unreadable group", () => {
  it("names a missing start", () => {
    expect(readEventFromFmBody(fm("kind: event", "title: something"))).toEqual({
      state: "unreadable",
      reason: "start-missing",
    });
  });

  it("names an unreadable start", () => {
    expect(readEventFromFmBody(fm("kind: event", "start: next tuesday"))).toEqual({
      state: "unreadable",
      reason: "start-unreadable",
    });
  });

  it("names an unreadable end", () => {
    expect(readEventFromFmBody(fm("kind: event", "start: 2026-11-05", "end: soon"))).toEqual({
      state: "unreadable",
      reason: "end-unreadable",
    });
  });

  it("names an end before the start", () => {
    expect(
      readEventFromFmBody(fm("kind: event", "start: 2026-11-05 14:00", "end: 2026-11-05 09:00")),
    ).toEqual({ state: "unreadable", reason: "end-before-start" });
  });

  it("names a timed end on an all-day start", () => {
    expect(
      readEventFromFmBody(fm("kind: event", "start: 2026-11-05", "end: 2026-11-06 09:00")),
    ).toEqual({ state: "unreadable", reason: "end-time-without-start-time" });
  });

  it("names an illegal calendar name", () => {
    expect(readEventFromFmBody(fm("kind: event", "start: 2026-11-05", "calendar: Work/Home"))).toEqual(
      { state: "unreadable", reason: "calendar-unreadable" },
    );
  });
});

describe("readEventFromFmBody: the rest of the record", () => {
  it("reads a multi-day event", () => {
    const read = readEventFromFmBody(
      fm("kind: event", "start: 2026-11-05", "end: 2026-11-07", "calendar: Travel"),
    );
    if (read.state !== "ok") throw new Error("expected ok");
    expect(read.event.end?.date).toEqual({ year: 2026, month: 11, day: 7 });
    expect(read.event.calendar).toBe("Travel");
  });

  it("keeps the uid verbatim", () => {
    const read = readEventFromFmBody(
      fm("kind: event", "start: 2026-11-05", "uid: 040000008200E00074C5B7101A82E008"),
    );
    if (read.state !== "ok") throw new Error("expected ok");
    expect(read.event.uid).toBe("040000008200E00074C5B7101A82E008");
  });

  it("reads a quoted value and a trailing comment through the shared extractor", () => {
    const read = readEventFromFmBody(
      fm("kind: event", 'start: "2026-11-05 09:00" # standup', "calendar: 'Work'"),
    );
    if (read.state !== "ok") throw new Error("expected ok");
    expect(read.event.start.time).toBe("09:00");
    expect(read.event.calendar).toBe("Work");
  });

  it("delegates repeat to the closed vocabulary, and preserves an unrecognized rule", () => {
    const known = readEventFromFmBody(
      fm("kind: event", "start: 2026-11-05", "repeat: every tuesday and thursday"),
    );
    if (known.state !== "ok") throw new Error("expected ok");
    expect(known.event.repeat?.ok).toBe(true);

    const unknown = readEventFromFmBody(
      fm("kind: event", "start: 2026-11-05", "repeat: every other blue moon"),
    );
    if (unknown.state !== "ok") throw new Error("expected ok");
    expect(unknown.event.repeat?.ok).toBe(false);
    expect(unknown.event.repeatRaw).toBe("every other blue moon");
  });

  it("has no repeat when the field is absent", () => {
    const read = readEventFromFmBody(fm("kind: event", "start: 2026-11-05"));
    if (read.state !== "ok") throw new Error("expected ok");
    expect(read.event.repeat).toBeNull();
    expect(read.event.repeatRaw).toBeNull();
  });
});

describe("readEventFromFmBody: the relative reminder lead", () => {
  it("parses the three units into minutes", () => {
    expect(parseReminderLead("30m")).toEqual({ raw: "30m", minutes: 30 });
    expect(parseReminderLead("2h")).toEqual({ raw: "2h", minutes: 120 });
    expect(parseReminderLead("1d")).toEqual({ raw: "1d", minutes: 1440 });
    expect(parseReminderLead(" 15M ")).toEqual({ raw: "15M", minutes: 15 });
  });

  it("refuses zero and anything outside the grammar", () => {
    for (const value of ["0m", "0d", "-5m", "5", "m", "5s", "5 weeks", "1.5h", "99999d"]) {
      expect(parseReminderLead(value), value).toBeNull();
    }
  });

  it("flags a lead past the horizon without dropping it", () => {
    const read = readEventFromFmBody(fm("kind: event", "start: 2026-11-05", "remind: 30d"), {
      reminderHorizonDays: 7,
    });
    if (read.state !== "ok") throw new Error("expected ok");
    expect(read.event.remind?.minutes).toBe(43200);
    expect(read.event.remind?.beyondHorizon).toBe(true);

    const short = readEventFromFmBody(fm("kind: event", "start: 2026-11-05", "remind: 30m"), {
      reminderHorizonDays: 7,
    });
    if (short.state !== "ok") throw new Error("expected ok");
    expect(short.event.remind?.beyondHorizon).toBe(false);
  });

  it("reports no lead when the value does not parse, and never invents one", () => {
    const read = readEventFromFmBody(fm("kind: event", "start: 2026-11-05", "remind: soon"));
    if (read.state !== "ok") throw new Error("expected ok");
    expect(read.event.remind).toBeNull();
  });
});

describe("skip: the dates a series does not occur on", () => {
  it("reads a comma-separated list and keeps it in file order", () => {
    const read = readEventFromFmBody(
      fm("kind: event", "start: 2026-11-03 09:00", "repeat: every tuesday", "skip: 2026-11-10, 2026-11-17"),
    );
    if (read.state !== "ok") throw new Error("expected ok");
    expect(read.event.skip).toEqual([
      { year: 2026, month: 11, day: 10 },
      { year: 2026, month: 11, day: 17 },
    ]);
  });

  it("accepts whitespace instead of commas, because a hand-typed field uses both", () => {
    expect(parseSkipDates("2026-11-10 2026-11-17")).toHaveLength(2);
  });

  it("drops what does not parse rather than hiding the series", () => {
    const read = readEventFromFmBody(
      fm("kind: event", "start: 2026-11-03", "repeat: every tuesday", "skip: soon, 2026-11-10"),
    );
    if (read.state !== "ok") throw new Error("a typo in a cancellation is not a broken event");
    expect(read.event.skip).toEqual([{ year: 2026, month: 11, day: 10 }]);
  });

  it("carries no dates when the field is absent", () => {
    const read = readEventFromFmBody(fm("kind: event", "start: 2026-11-03"));
    if (read.state !== "ok") throw new Error("expected ok");
    expect(read.event.skip).toEqual([]);
  });
});

describe("appendSkipDate: the one spelling of the field", () => {
  it("adds a date in ascending order regardless of the order it is added", () => {
    const first = appendSkipDate(null, { year: 2026, month: 11, day: 17 });
    const second = appendSkipDate(first, { year: 2026, month: 11, day: 10 });
    const reversed = appendSkipDate(
      appendSkipDate(null, { year: 2026, month: 11, day: 10 }),
      { year: 2026, month: 11, day: 17 },
    );
    // Byte-for-byte equal, so two clients cancelling the same two dates in either
    // order cannot produce a conflict neither of them made.
    expect(second).toBe("2026-11-10, 2026-11-17");
    expect(reversed).toBe(second);
  });

  it("answers null when the date is already skipped, so the writer does nothing", () => {
    expect(appendSkipDate("2026-11-10", { year: 2026, month: 11, day: 10 })).toBeNull();
  });
});

describe("override: one occurrence retimed", () => {
  it("reads date+time pairs and keeps them in file order", () => {
    const read = readEventFromFmBody(
      fm("kind: event", "start: 2026-11-03 09:00", "repeat: every tuesday", "override: 2026-11-10 14:00, 2026-11-17 13:30"),
    );
    if (read.state !== "ok") throw new Error("expected ok");
    expect(read.event.overrides).toEqual([
      { date: { year: 2026, month: 11, day: 10 }, time: "14:00" },
      { date: { year: 2026, month: 11, day: 17 }, time: "13:30" },
    ]);
  });

  it("drops a bare date, because an override changes a TIME and a date alone changes nothing", () => {
    expect(parseOverrides("2026-11-10, 2026-11-17 13:30")).toHaveLength(1);
  });

  it("writes one entry per date, ordered, replacing a date that is already there", () => {
    const first = setOverride(null, { date: { year: 2026, month: 11, day: 17 }, time: "13:30" });
    const second = setOverride(first, { date: { year: 2026, month: 11, day: 10 }, time: "14:00" });
    const replaced = setOverride(second, { date: { year: 2026, month: 11, day: 17 }, time: "15:00" });
    expect(second).toBe("2026-11-10 14:00, 2026-11-17 13:30");
    expect(replaced).toBe("2026-11-10 14:00, 2026-11-17 15:00");
    // Order of writing cannot change the bytes, which is what keeps two clients
    // from conflicting over one schedule.
    expect(setOverride(setOverride(null, { date: { year: 2026, month: 11, day: 10 }, time: "14:00" }), { date: { year: 2026, month: 11, day: 17 }, time: "13:30" })).toBe(second);
  });

  it("clears one date and answers null when there was none", () => {
    expect(clearOverride("2026-11-10 14:00, 2026-11-17 13:30", { year: 2026, month: 11, day: 10 })).toBe("2026-11-17 13:30");
    expect(clearOverride("2026-11-10 14:00", { year: 2026, month: 11, day: 10 })).toBe("");
    expect(clearOverride(null, { year: 2026, month: 11, day: 10 })).toBeNull();
  });
});

describe("the writers keep what the reader cannot type", () => {
  it("leaves an unparseable skip entry in the file instead of deleting it", () => {
    // Found by review: the reader is told to drop such an entry and LEAVE IT, and the
    // writer shipped beside it dumped the parsed set back out, so cancelling one
    // occurrence deleted a different cancellation and resurrected that week.
    const next = appendSkipDate("2026-11-12, 2026-11-5, TBD", { year: 2026, month: 11, day: 5 });
    expect(next).toBe("2026-11-5, TBD, 2026-11-05, 2026-11-12");
  });

  it("treats an already-cancelled date as a no-op, so the writer writes nothing", () => {
    expect(appendSkipDate("2026-11-05", { year: 2026, month: 11, day: 5 })).toBeNull();
  });

  it("keeps a bare-date override entry when a real one is set", () => {
    const next = setOverride("2026-11-17, 2026-11-10 14:00", {
      date: { year: 2026, month: 11, day: 5 },
      time: "14:00",
    });
    expect(next).toBe("2026-11-17, 2026-11-05 14:00, 2026-11-10 14:00");
  });
});

describe("eventNoteBytes: one builder for both clients", () => {
  it("emits the field set in one order, so two clients cannot produce two notes", () => {
    // Found by review: the desktop and the phone each had a builder, and they had
    // already drifted (the phone wrote no `uid` and ordered `repeat` before
    // `calendar`), which made "a phone note is byte-identical to a laptop note" false
    // in the file that claimed it.
    const bytes = eventNoteBytes({
      title: "Standup",
      start: { date: { year: 2026, month: 11, day: 5 }, time: "09:00" },
      end: { date: { year: 2026, month: 11, day: 5 }, time: "09:30" },
      repeat: "every tuesday",
      remind: "10m",
      calendar: "Work",
      uid: "abc-123",
    });
    const text = new TextDecoder().decode(bytes);
    const order = ["kind: event", "start: 2026-11-05 09:00", "end: 2026-11-05 09:30", "calendar: Work", "repeat: every tuesday", "remind: 10m", "uid: abc-123"];
    const positions = order.map((line) => text.indexOf(line));
    expect(positions.every((at) => at >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("leaves out every absent field rather than writing an empty one", () => {
    const text = new TextDecoder().decode(
      eventNoteBytes({
        title: "Dentist",
        start: { date: { year: 2026, month: 11, day: 6 }, time: null },
      }),
    );
    expect(text).toContain("kind: event");
    for (const absent of ["end:", "calendar:", "repeat:", "remind:", "uid:"]) {
      expect(text).not.toContain(absent);
    }
  });
});
