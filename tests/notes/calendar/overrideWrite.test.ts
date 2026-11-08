// Retiming one appearance (decisions/storage/0796, myne-md/myne#1037).
//
// The interesting cases are the ones a "set the time" helper gets wrong: the
// duration must follow the new start, an already-retimed date must be REPLACED
// rather than duplicated, and a time the vocabulary cannot read must be refused
// rather than written and then dropped by every reader.

import { describe, expect, it } from "vitest";
import { readEventFromFmBody } from "../../../src/dialect/event";
import { locateFrontmatter } from "../../../src/dialect/lezer/frontmatter";
import { EventWriteRefused } from "../../../src/notes/calendar/dragWrite";
import { overrideOccurrence } from "../../../src/notes/calendar/overrideWrite";

const SERIES = [
  "---",
  "title: Standup",
  "kind: event",
  "start: 2026-11-03 09:15",
  "end: 2026-11-03 09:45",
  "repeat: every tuesday",
  "---",
  "",
  "Body stays put.",
].join("\n");

function io(source: string, writes: string[]) {
  return {
    readNote: async () => source,
    writeNote: async (_id: string, body: string) => {
      writes.push(body);
      return undefined;
    },
  };
}

function overridesOf(body: string) {
  const range = locateFrontmatter(body);
  if (range === null) throw new Error("frontmatter survived");
  const read = readEventFromFmBody(body.slice(range.bodyStart, range.bodyEnd));
  if (read.state !== "ok") throw new Error("still an event");
  return read.event.overrides;
}

describe("overrideOccurrence", () => {
  it("writes the date and the new time, and leaves the rest of the note alone", async () => {
    const writes: string[] = [];
    await overrideOccurrence({
      noteId: "standup",
      occurrenceDate: "2026-11-10",
      time: "14:00",
      io: io(SERIES, writes),
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("override: 2026-11-10 14:00");
    expect(writes[0]).toContain("Body stays put.");
    // The series itself is untouched: the day, the duration and the rule all stay.
    expect(writes[0]).toContain("start: 2026-11-03 09:15");
    expect(writes[0]).toContain("end: 2026-11-03 09:45");
    expect(overridesOf(writes[0])).toHaveLength(1);
  });

  it("replaces the entry for a date instead of adding a second one", async () => {
    const writes: string[] = [];
    const once = SERIES.replace("repeat: every tuesday", "repeat: every tuesday\noverride: 2026-11-10 14:00");
    await overrideOccurrence({
      noteId: "standup",
      occurrenceDate: "2026-11-10",
      time: "15:30",
      io: io(once, writes),
    });
    expect(writes[0]).toContain("override: 2026-11-10 15:30");
    expect(writes[0]).not.toContain("14:00");
    expect(overridesOf(writes[0])).toHaveLength(1);
  });

  it("keeps two retimed dates ordered", async () => {
    const writes: string[] = [];
    const once = SERIES.replace("repeat: every tuesday", "repeat: every tuesday\noverride: 2026-11-17 13:30");
    await overrideOccurrence({
      noteId: "standup",
      occurrenceDate: "2026-11-10",
      time: "14:00",
      io: io(once, writes),
    });
    expect(writes[0]).toContain("override: 2026-11-10 14:00, 2026-11-17 13:30");
  });

  it("refuses a time the vocabulary cannot read, because the readers would drop it", async () => {
    const writes: string[] = [];
    await expect(
      overrideOccurrence({
        noteId: "standup",
        occurrenceDate: "2026-11-10",
        time: "14.00",
        io: io(SERIES, writes),
      }),
    ).rejects.toBeInstanceOf(EventWriteRefused);
    expect(writes).toHaveLength(0);
  });

  it("refuses when the note is no longer an event", async () => {
    const writes: string[] = [];
    await expect(
      overrideOccurrence({
        noteId: "standup",
        occurrenceDate: "2026-11-10",
        time: "14:00",
        io: io("---\ntitle: Standup\n---\ngone", writes),
      }),
    ).rejects.toBeInstanceOf(EventWriteRefused);
    expect(writes).toHaveLength(0);
  });
});
