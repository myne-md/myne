// Dragging and resizing an event (myne-md/myne#1037, task 6).
//
// An event's position on the grid is two frontmatter fields, so a drag is an
// ordinary note write: `start` and (if the row has one) `end` move by the same
// delta, and nothing else in the blob changes. There is no journal, no sidecar
// state and no calendar-specific store; the note IS the record, which is the
// whole reason an event is a note rather than a sealed family.
//
// Two properties make this safe enough to hang a gesture on:
//
// 1. **Value-anchored.** The drag carries the `start` the row was RENDERED from,
//    and the write refuses when the note no longer says that. Without it, a sync
//    pull-apply between the read and the drag lands the move on a note that has
//    since been rescheduled by another device.
// 2. **One write, base-hashed.** `end - start` is preserved as a duration, so a
//    moved event keeps its length, and the content hash the backend checks means
//    a raced write is refused rather than applied to bytes nobody read.
//
// A refusal REJECTS. It does not resolve quietly: a surface that swallows it goes
// on showing the row where the user dropped it while the note says otherwise, and
// every later drag in that session then fails for a reason nothing displayed. This
// file has one test whose only job is that a refusal is not swallowed.

import { describe, expect, it, vi } from "vitest";
import {
  EventWriteRefused,
  applyEventMove,
  planDrag,
  planResize,
  type EventSpan,
  type EventWriteIo,
} from "../../src/notes/calendar/dragWrite";
import { buildEventNoteBytes } from "../../src/notes/createEvent";
import { parseEventInstant } from "../../src/dialect/event";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function note(over: Partial<{ title: string; start: string; end: string | null }> = {}): string {
  const start = parseEventInstant(over.start ?? "2026-11-05 09:00");
  const end = over.end === undefined || over.end === null ? null : parseEventInstant(over.end);
  if (start === null) throw new Error("bad fixture start");
  return decoder.decode(
    buildEventNoteBytes({ title: over.title ?? "Standup", start, end }),
  );
}

function span(over: Partial<EventSpan> = {}): EventSpan {
  return { start: "2026-11-05 09:00", end: null, allDay: false, ...over };
}

/** A host whose `writeNote` records what it was asked to write. */
function io(source: string, over: Partial<EventWriteIo> = {}): EventWriteIo & {
  writes: Array<{ noteId: string; body: string; base: string }>;
  flushes: () => number;
} {
  const writes: Array<{ noteId: string; body: string; base: string }> = [];
  let flushes = 0;
  const base: EventWriteIo = {
    readNote: async () => source,
    writeNote: async (noteId, body, baseHashHex) => {
      writes.push({ noteId, body, base: baseHashHex });
    },
    flushDirtyPanes: async () => {
      flushes += 1;
    },
    ...over,
  };
  return Object.assign(base as never, { writes, flushes: () => flushes });
}

describe("planDrag", () => {
  it("shifts both ends by the same delta, preserving the duration", () => {
    const next = planDrag(span({ start: "2026-11-05 09:00", end: "2026-11-05 10:30" }), 1);
    expect(next.start).toBe("2026-11-06 09:00");
    expect(next.end).toBe("2026-11-06 10:30");
  });

  it("moves a point event without inventing an end", () => {
    const next = planDrag(span({ start: "2026-11-05 09:00" }), -2);
    expect(next.start).toBe("2026-11-03 09:00");
    expect(next.end).toBeNull();
  });

  it("keeps an all-day event all-day", () => {
    const next = planDrag(span({ start: "2026-11-05", end: "2026-11-07", allDay: true }), 1);
    expect(next.start).toBe("2026-11-06");
    expect(next.end).toBe("2026-11-08");
  });

  it("crosses a month and a year boundary", () => {
    expect(planDrag(span({ start: "2026-12-31 09:00" }), 1).start).toBe("2027-01-01 09:00");
    expect(planDrag(span({ start: "2026-03-01 09:00" }), -1).start).toBe("2026-02-28 09:00");
  });

  it("is a no-op for a zero delta", () => {
    const original = span({ start: "2026-11-05 09:00", end: "2026-11-05 10:00" });
    expect(planDrag(original, 0)).toEqual(original);
  });
});

describe("planResize", () => {
  it("changes only the end", () => {
    const next = planResize(span({ start: "2026-11-05 09:00", end: "2026-11-05 10:00" }), 1);
    expect(next.start).toBe("2026-11-05 09:00");
    expect(next.end).toBe("2026-11-06 10:00");
  });

  it("gives a point event an end rather than refusing the gesture", () => {
    const next = planResize(span({ start: "2026-11-05 09:00" }), 1);
    expect(next.end).toBe("2026-11-06 09:00");
  });

  it("refuses an end that would precede the start", () => {
    expect(planResize(span({ start: "2026-11-05 09:00", end: "2026-11-05 10:00" }), -1)).toBeNull();
  });
});

describe("applyEventMove", () => {
  it("writes start and end in one write, and nothing else in the note moves", async () => {
    const source = note({ start: "2026-11-05 09:00", end: "2026-11-05 10:30" });
    const host = io(source);
    await applyEventMove({
      noteId: "n1",
      rendered: span({ start: "2026-11-05 09:00", end: "2026-11-05 10:30" }),
      next: planDrag(span({ start: "2026-11-05 09:00", end: "2026-11-05 10:30" }), 1),
      io: host,
    });
    expect(host.writes).toHaveLength(1);
    const written = host.writes[0]!.body;
    expect(written).toContain("start: 2026-11-06 09:00");
    expect(written).toContain("end: 2026-11-06 10:30");
    // The title and the kind are untouched: this is a frontmatter edit, not a
    // rewrite of the note.
    expect(written).toContain("kind: event");
    expect(written).toContain("Standup");
  });

  it("keeps the day count of a multi-day span", async () => {
    const source = note({ start: "2026-11-05", end: "2026-11-07" });
    const host = io(source);
    const rendered = span({ start: "2026-11-05", end: "2026-11-07", allDay: true });
    await applyEventMove({ noteId: "n1", rendered, next: planDrag(rendered, 2), io: host });
    expect(host.writes[0]!.body).toContain("start: 2026-11-07");
    expect(host.writes[0]!.body).toContain("end: 2026-11-09");
  });

  it("flushes a dirty pane BEFORE it reads", async () => {
    const order: string[] = [];
    const source = note({ start: "2026-11-05 09:00" });
    await applyEventMove({
      noteId: "n1",
      rendered: span({ start: "2026-11-05 09:00" }),
      next: span({ start: "2026-11-06 09:00" }),
      io: {
        flushDirtyPanes: async () => {
          order.push("flush");
        },
        readNote: async () => {
          order.push("read");
          return source;
        },
        writeNote: async () => {
          order.push("write");
        },
      },
    });
    expect(order).toEqual(["flush", "read", "write"]);
  });

  it("refuses when the note no longer says what the row was rendered from", async () => {
    // The rendered row says the 5th; the note says the 6th, so another device (or
    // another pane) moved it and this drag would land on a stale position.
    const source = note({ start: "2026-11-06 09:00" });
    const host = io(source);
    await expect(
      applyEventMove({
        noteId: "n1",
        rendered: span({ start: "2026-11-05 09:00" }),
        next: span({ start: "2026-11-06 09:00" }),
        io: host,
      }),
    ).rejects.toBeInstanceOf(EventWriteRefused);
    // The refusal is not a silent return: nothing was written either.
    expect(host.writes).toHaveLength(0);
  });

  it("carries the reason on the refusal", async () => {
    const host = io(note({ start: "2026-11-06 09:00" }));
    await expect(
      applyEventMove({
        noteId: "n1",
        rendered: span({ start: "2026-11-05 09:00" }),
        next: span({ start: "2026-11-06 09:00" }),
        io: host,
      }),
    ).rejects.toMatchObject({ reason: "value-changed", noteId: "n1" });
  });

  it("refuses a note that is no longer an event", async () => {
    const host = io("# just a note\n");
    await expect(
      applyEventMove({
        noteId: "n1",
        rendered: span({ start: "2026-11-05 09:00" }),
        next: span({ start: "2026-11-06 09:00" }),
        io: host,
      }),
    ).rejects.toMatchObject({ reason: "start-missing" });
    expect(host.writes).toHaveLength(0);
  });

  it("reports a raced write as a refusal, not as a crash", async () => {
    const source = note({ start: "2026-11-05 09:00" });
    const host = io(source, {
      writeNote: async () => {
        throw Object.assign(new Error("base mismatch"), { kind: "BaseMismatch" });
      },
    });
    await expect(
      applyEventMove({
        noteId: "n1",
        rendered: span({ start: "2026-11-05 09:00" }),
        next: span({ start: "2026-11-06 09:00" }),
        io: host,
      }),
    ).rejects.toMatchObject({ reason: "base-mismatch" });
  });

  it("passes the content hash of the bytes it read, always", async () => {
    const source = note({ start: "2026-11-05 09:00" });
    const host = io(source);
    await applyEventMove({
      noteId: "n1",
      rendered: span({ start: "2026-11-05 09:00" }),
      next: span({ start: "2026-11-06 09:00" }),
      io: host,
    });
    expect(host.writes[0]!.base).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not write when the move changes nothing", async () => {
    const source = note({ start: "2026-11-05 09:00" });
    const host = io(source);
    const rendered = span({ start: "2026-11-05 09:00" });
    await applyEventMove({ noteId: "n1", rendered, next: rendered, io: host });
    expect(host.writes).toHaveLength(0);
    void encoder;
  });
});
