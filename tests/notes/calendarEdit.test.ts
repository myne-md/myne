// Editing an event through the form (myne-md/myne#1037).
//
// The form cannot draw every value a note may legally carry: `repeat: 1w` and
// `remind: 30` are hand-written and the reader keeps the note readable rather
// than refusing it. So the writer has to tell "the user cleared this" apart from
// "the control could not represent this", and only the first may delete a line.
// Getting it wrong is silent: the user opens an event to fix its title and loses
// the repeat, which also removes every projected occurrence.

import { describe, expect, it } from "vitest";
import { editFromPlan, applyEventEdit, type EventEdit } from "../../src/notes/calendar/updateEvent";
import type { EventSpan, EventWriteIo } from "../../src/notes/calendar/dragWrite";
import { formFromRow, planEventForm } from "../../src/notes/components/CalendarEventForm";

const NOTE = [
  "---",
  "title: Standup",
  "kind: event",
  "start: 2026-11-05 09:00",
  "calendar: work",
  "repeat: 1w",
  "remind: 30",
  "---",
  "",
  "Standup body.",
  "",
].join("\n");

function io(source: string): EventWriteIo & { body: () => string | null } {
  let written: string | null = null;
  const base: EventWriteIo = {
    readNote: async () => source,
    writeNote: async (_id, body) => {
      written = body;
    },
    flushDirtyPanes: async () => {},
  };
  return Object.assign(base as never, { body: () => written });
}

const span: EventSpan = { start: "2026-11-05 09:00", end: null, allDay: false };

/** The row the calendar would render for NOTE. */
const row = {
  title: "Standup",
  start: "2026-11-05 09:00",
  end: null,
  calendar: "work",
  repeat: "1w",
  remind: "30",
};

describe("an unrepresentable repeat or remind", () => {
  it("is marked untouched rather than read as cleared", () => {
    const values = formFromRow(row);
    expect(values.repeat).toBeNull();
    expect(values.remind).toBeNull();
    expect(values.repeatUntouched).toBe(true);
    expect(values.remindUntouched).toBe(true);
  });

  it("stays on the note when only the title is edited", async () => {
    const values = formFromRow(row);
    const plan = planEventForm({ ...values, title: "Standup renamed" });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const host = io(NOTE);
    await applyEventEdit({ noteId: "n1", rendered: span, next: editFromPlan(plan.input), io: host });
    expect(host.body()).toContain("repeat: 1w");
    expect(host.body()).toContain("remind: 30");
    expect(host.body()).toContain("title: Standup renamed");
  });

  it("is deleted when the user actually clears it", async () => {
    const next: EventEdit = {
      title: "Standup",
      start: "2026-11-05 09:00",
      end: null,
      calendar: "work",
      repeat: null,
      remind: null,
    };
    const host = io(NOTE);
    await applyEventEdit({ noteId: "n1", rendered: span, next, io: host });
    expect(host.body()).not.toContain("repeat:");
    expect(host.body()).not.toContain("remind:");
  });

  it("is absent from the edit when the plan leaves the field out", () => {
    const values = { ...formFromRow(row), title: "Standup" };
    const plan = planEventForm(values);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const edit = editFromPlan(plan.input);
    expect(edit.repeat).toBeUndefined();
    expect(edit.remind).toBeUndefined();
  });
});
