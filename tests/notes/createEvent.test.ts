// Event creation bytes (myne-md/myne#1037, task 4).
//
// The shape IS the contract: an event is a note, so what this asserts is the
// frontmatter a cell click writes. A test that could only see the result through
// `invoke` would be asserting the mock, which is why the builder is exported and
// the bytes are asserted directly (the `initialNotePlaintext` precedent).
//
// The emitted form matters twice: `start:` is a wall clock (`markdown-dialect.md`
// §3.10.2), and it round-trips through the reader the pane uses. A second spelling
// on disk would make every save produce a spurious diff.

import { describe, expect, it } from "vitest";
import { buildEventNoteBytes } from "../../src/notes/createEvent";
import { parseEventInstant, readEventFromFmBody } from "../../src/dialect/event";
import { parseCivilDate } from "../../src/dialect/civilDate";

const decoder = new TextDecoder();

function bytesFor(start: string, extra: Record<string, unknown> = {}): string {
  const instant = parseEventInstant(start);
  if (instant === null) throw new Error(`bad fixture instant ${start}`);
  return decoder.decode(
    buildEventNoteBytes({
      title: "Dentist",
      start: instant,
      ...(extra as { end?: ReturnType<typeof parseEventInstant> }),
    }),
  );
}

/** The frontmatter body, which is the slice every reader takes. */
function fmBody(plaintext: string): string {
  const start = plaintext.indexOf("---\n");
  const end = plaintext.indexOf("\n---", start + 4);
  return plaintext.slice(start + 4, end);
}

describe("buildEventNoteBytes", () => {
  it("writes kind: event, the title and the start", () => {
    const plaintext = bytesFor("2026-11-05 09:00");
    const read = readEventFromFmBody(fmBody(plaintext));
    expect(read.state).toBe("ok");
    if (read.state !== "ok") throw new Error("unreachable");
    expect(read.event.start.time).toBe("09:00");
    expect(read.event.allDay).toBe(false);
    expect(plaintext).toContain("title:");
    expect(plaintext).toContain("kind: event");
  });

  it("writes an all-day event as a date with no time", () => {
    const plaintext = bytesFor("2026-11-05");
    const read = readEventFromFmBody(fmBody(plaintext));
    if (read.state !== "ok") throw new Error("expected ok");
    expect(read.event.allDay).toBe(true);
  });

  it("carries an end, a calendar, a rule and a relative lead", () => {
    const plaintext = decoder.decode(
      buildEventNoteBytes({
        title: "Standup",
        start: parseEventInstant("2026-11-05 09:15")!,
        end: parseEventInstant("2026-11-05 09:30")!,
        calendar: "Work",
        repeat: "every tuesday and thursday",
        remind: "30m",
      }),
    );
    const read = readEventFromFmBody(fmBody(plaintext), { reminderHorizonDays: 7 });
    if (read.state !== "ok") throw new Error("expected ok");
    expect(read.event.calendar).toBe("Work");
    expect(read.event.end).toEqual(parseEventInstant("2026-11-05 09:30"));
    expect(read.event.repeat?.ok).toBe(true);
    expect(read.event.remind?.minutes).toBe(30);
    expect(read.event.remind?.beyondHorizon).toBe(false);
  });

  it("uses the emitted form, so a re-read produces the same instant", () => {
    const plaintext = bytesFor("2026-11-05T09:00");
    // The builder never emits the `T` separator the reader also accepts.
    expect(plaintext).toContain("2026-11-05 09:00");
    expect(plaintext).not.toContain("2026-11-05T09:00");
  });

  it("omits the fields a caller did not supply instead of writing empty ones", () => {
    const body = fmBody(bytesFor("2026-11-05"));
    expect(body).not.toContain("calendar:");
    expect(body).not.toContain("repeat:");
    expect(body).not.toContain("remind:");
    expect(parseCivilDate("2026-11-05")).not.toBeNull();
  });
});
