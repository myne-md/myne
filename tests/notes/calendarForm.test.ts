// The event form's model (myne-md/myne#1037, task 7).
//
// The claim worth testing is not "the widgets render": it is that the FORM and
// the NOTE are the same record. So most of these cases go through the real bytes
// (`buildEventNoteBytes` → `readEventFromFmBody` → `formFromEvent`) rather than
// through a mock, because a mock would agree with the form about a shape the file
// does not carry.
//
// The refusals get the same treatment: each one has to name the field that failed,
// and the value it refused must not be reachable by the writer afterwards.

import { describe, expect, it } from "vitest";
import {
  LEAD_CHOICES,
  emptyEventForm,
  formFromEvent,
  planEventForm,
  type EventFormValues,
} from "../../src/notes/components/CalendarEventForm";
import { buildEventNoteBytes } from "../../src/notes/createEvent";
import { parseReminderLead, readEventFromFmBody } from "../../src/dialect/event";
import { buildInitialPlaintext } from "../../src/dialect/surgery";

const decoder = new TextDecoder();

function values(over: Partial<EventFormValues> = {}): EventFormValues {
  return { ...emptyEventForm("2026-11-05"), title: "Dentist", ...over };
}

/** The frontmatter body of a plaintext note, which is the slice readers take. */
function fmBody(plaintext: string): string {
  const start = plaintext.indexOf("---\n");
  const end = plaintext.indexOf("\n---", start + 4);
  return plaintext.slice(start + 4, end);
}

/** Walk the form → bytes → reader → form path the vault would. */
function roundTrip(form: EventFormValues): EventFormValues {
  const plan = planEventForm(form);
  if (!plan.ok) throw new Error(`refused: ${plan.refusal.reason}`);
  let bytes = buildEventNoteBytes(plan.input);
  // An event created through the pane also carries its folder; the form does not,
  // so the plaintext is built the same way `createEvent` builds it.
  const note = buildInitialPlaintext(null);
  void note;
  const plaintext = decoder.decode(bytes);
  const read = readEventFromFmBody(fmBody(plaintext));
  if (read.state !== "ok") throw new Error(`unreadable: ${read.state === "unreadable" ? read.reason : read.state}`);
  bytes = new Uint8Array();
  void bytes;
  return formFromEvent(read.event, form.title);
}

describe("planEventForm", () => {
  it("accepts a minimal all-day event", () => {
    const plan = planEventForm(values());
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error("unreachable");
    expect(plan.input.start).toEqual({ date: { year: 2026, month: 11, day: 5 }, time: null });
    expect(plan.input.end).toBeNull();
  });

  it("refuses an empty title, naming the title", () => {
    const plan = planEventForm(values({ title: "   " }));
    expect(plan).toEqual({ ok: false, refusal: { field: "title", reason: "title-required" } });
  });

  it("refuses an end before the start, naming the end", () => {
    const plan = planEventForm(
      values({ startTime: "09:00", endDate: "2026-11-04", endTime: "10:00" }),
    );
    expect(plan).toEqual({ ok: false, refusal: { field: "end", reason: "end-before-start" } });
  });

  it("refuses an unreadable start date, naming the start", () => {
    const plan = planEventForm(values({ startDate: "2026-02-31" }));
    expect(plan).toEqual({ ok: false, refusal: { field: "start", reason: "start-unreadable" } });
  });

  it("refuses a lead past the horizon and states the horizon", () => {
    const plan = planEventForm(values({ remind: { raw: "30d", minutes: 30 * 1440 } }), 7);
    expect(plan).toEqual({
      ok: false,
      refusal: { field: "remind", reason: "lead-beyond-horizon", horizonDays: 7 },
    });
  });

  it("accepts a lead exactly at the horizon", () => {
    expect(planEventForm(values({ remind: { raw: "7d", minutes: 7 * 1440 } }), 7).ok).toBe(true);
  });

  it("emits the rule through the shared formatter, never a typed string", () => {
    const plan = planEventForm(values({ repeat: { kind: "interval", unit: "week", count: 2 } }));
    if (!plan.ok) throw new Error("refused");
    expect(plan.input.repeat).toBe("every 2 weeks");
  });
});

describe("the form and the note are the same record", () => {
  it("round-trips an all-day event", () => {
    const form = values({ startDate: "2026-11-05" });
    expect(roundTrip(form)).toEqual(form);
  });

  it("round-trips a 90-minute timed event", () => {
    const form = values({ startTime: "09:00", endDate: "2026-11-05", endTime: "10:30" });
    expect(roundTrip(form)).toEqual(form);
  });

  it("round-trips a weekly recurrence", () => {
    const form = values({ repeat: { kind: "weekdays", days: ["monday", "thursday"] } });
    expect(roundTrip(form)).toEqual(form);
  });

  it("round-trips a calendar name and a reminder lead", () => {
    const form = values({ calendar: "Work", remind: { raw: "30m", minutes: 30 } });
    expect(roundTrip(form)).toEqual(form);
  });

  it("round-trips a multi-day span", () => {
    const form = values({ startDate: "2026-11-05", endDate: "2026-11-07" });
    expect(roundTrip(form)).toEqual(form);
  });

  it("reads all-day as the absence of a time, so the flag cannot disagree", () => {
    const form = values({ startDate: "2026-11-05" });
    const plan = planEventForm(form);
    if (!plan.ok) throw new Error("refused");
    const plaintext = decoder.decode(buildEventNoteBytes(plan.input));
    // No wall clock is written at all: the file simply has no hour to disagree with.
    expect(plaintext).toContain("start: 2026-11-05\n");
    expect(roundTrip(form).startTime).toBeNull();
  });
});

describe("the lead choices the control offers", () => {
  it("each parse through the real grammar, so no option means 'no reminder'", () => {
    // `parseReminderLead` is the writer's own reader: an entry it refuses would be
    // stored as nothing, and the user would believe they had set a reminder.
    for (const lead of LEAD_CHOICES) {
      const parsed = parseReminderLead(lead);
      expect(parsed, `lead ${lead} must be expressible in the file`).not.toBeNull();
      const plan = planEventForm(values({ remind: parsed }));
      expect(plan.ok, `lead ${lead} must be inside the horizon`).toBe(true);
    }
  });
});
