// Cancelling one appearance (decisions/storage/0795, myne-md/myne#1037).
//
// The two questions a cancellation has to answer, and neither is "does the field
// exist": does the file end up saying the right thing, and does a write that raced
// another one refuse instead of overwriting?

import { describe, expect, it } from "vitest";
import { readEventFromFmBody } from "../../../src/dialect/event";
import { locateFrontmatter } from "../../../src/dialect/lezer/frontmatter";
import { EventWriteRefused } from "../../../src/notes/calendar/dragWrite";
import { skipOccurrence } from "../../../src/notes/calendar/skipWrite";
import { sha256Hex } from "../../../src/notes/baseHash";

const SERIES = [
  "---",
  "title: Standup",
  "kind: event",
  "start: 2026-11-03 09:15",
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

describe("skipOccurrence", () => {
  it("appends the date to the series note and leaves the body alone", async () => {
    const writes: string[] = [];
    await skipOccurrence({
      noteId: "standup",
      occurrenceDate: "2026-11-10",
      io: io(SERIES, writes),
    });
    expect(writes).toHaveLength(1);
    const written = writes[0];
    expect(written).toContain("skip: 2026-11-10");
    expect(written).toContain("Body stays put.");
    // The field has to be READABLE by the same reader the projection uses, which is
    // the only assertion that says the write and the read agree.
    const range = locateFrontmatter(written);
    if (range === null) throw new Error("frontmatter survived");
    const read = readEventFromFmBody(written.slice(range.bodyStart, range.bodyEnd));
    if (read.state !== "ok") throw new Error("still an event");
    expect(read.event.skip).toEqual([{ year: 2026, month: 11, day: 10 }]);
  });

  it("keeps the list ordered when a second date is cancelled", async () => {
    const writes: string[] = [];
    const withOne = SERIES.replace("repeat: every tuesday", "repeat: every tuesday\nskip: 2026-11-17");
    await skipOccurrence({
      noteId: "standup",
      occurrenceDate: "2026-11-10",
      io: io(withOne, writes),
    });
    expect(writes[0]).toContain("skip: 2026-11-10, 2026-11-17");
  });

  it("writes nothing when the date is already cancelled", async () => {
    const writes: string[] = [];
    const already = SERIES.replace("repeat: every tuesday", "repeat: every tuesday\nskip: 2026-11-10");
    await skipOccurrence({
      noteId: "standup",
      occurrenceDate: "2026-11-10",
      io: io(already, writes),
    });
    expect(writes).toHaveLength(0);
  });

  it("refuses when the note is no longer an event, instead of inventing a field", async () => {
    const writes: string[] = [];
    await expect(
      skipOccurrence({
        noteId: "standup",
        occurrenceDate: "2026-11-10",
        io: io("---\ntitle: Standup\n---\nno longer an event", writes),
      }),
    ).rejects.toBeInstanceOf(EventWriteRefused);
    expect(writes).toHaveLength(0);
  });

  it("turns a raced write into a refusal rather than an overwrite", async () => {
    let calls = 0;
    await expect(
      skipOccurrence({
        noteId: "standup",
        occurrenceDate: "2026-11-10",
        io: {
          readNote: async () => SERIES,
          writeNote: async () => {
            calls += 1;
            // The shape the backend's guard recognises, not a message: a refusal
            // read by matching text on an error message is a refusal that stops
            // working the day somebody rewords it.
            throw { kind: "BaseMismatch" as const };
          },
        },
      }),
    ).rejects.toMatchObject({ reason: "base-mismatch" });
    expect(calls).toBe(1);
  });

  it("sends the hash of the bytes it read, so the backend checks the right base", async () => {
    const seen: string[] = [];
    await skipOccurrence({
      noteId: "standup",
      occurrenceDate: "2026-11-10",
      io: {
        readNote: async () => SERIES,
        writeNote: async (_id: string, _body: string, base: string) => {
          seen.push(base);
          return undefined;
        },
      },
    });
    expect(seen).toEqual([await sha256Hex(SERIES)]);
  });
});
