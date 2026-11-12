// @vitest-environment jsdom
//
// The event form's SHAPE (myne-md/myne#1037), which the model tests cannot see.
//
// Three claims, each of them a defect that shipped in the stacked-caption
// version. An end that was never chosen read as a value ("No date") with nothing
// saying which field it belonged to, so there was no way to tell it from the
// start date above it. Turning the clock back on after choosing All day gave the
// END no time, and `planEventForm` reads the stored value: it became midnight and
// the form refused its own default on save. And a repeat rule the picker cannot
// build (a hand-written `first monday of every month`) sat in the note untouched
// only until the user chose something - the "leave that line alone" flag outlived
// the choice it was there to protect.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  setDateTimeDisplay,
  __resetDateTimeDisplayForTest,
  DEFAULT_DISPLAY,
} from "@myne/editor/host/lib/datetimeFormat";

import {
  CalendarEventForm,
  emptyEventForm,
  formFromRow,
  type EventFormValues,
} from "../../src/notes/components/CalendarEventForm";

async function render(node: React.ReactNode): Promise<{ host: HTMLElement; cleanup: () => void }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
  });
  return {
    host,
    cleanup: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function at(host: HTMLElement, testId: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${testId}"]`);
}

async function press(target: HTMLElement | null): Promise<void> {
  await act(async () => {
    target?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const TIMED: EventFormValues = {
  ...emptyEventForm("2026-11-05"),
  title: "Standup",
  startTime: "09:00",
};

beforeEach(() => {
  setDateTimeDisplay({ ...DEFAULT_DISPLAY, dateFormat: "iso", timeFormat: "24h", locale: "en" });
});
afterEach(() => {
  __resetDateTimeDisplayForTest();
});

describe("the event form's end", () => {
  it("opens as an offer rather than as a value nobody chose", async () => {
    const { host, cleanup } = await render(
      <CalendarEventForm initial={TIMED} onClose={() => undefined} />,
    );
    expect(at(host, "calendar.form.endAdd")).not.toBeNull();
    expect(at(host, "calendar.form.endDate")).toBeNull();

    await press(at(host, "calendar.form.endAdd"));

    // The start's own day, so the common case is one press, and an hour later
    // rather than the start's instant: an end equal to the start draws nothing.
    expect(at(host, "calendar.form.endDate")?.getAttribute("data-value")).toBe("2026-11-05");
    expect(at(host, "calendar.form.endTime")?.getAttribute("data-value")).toBe("10:00");
    expect(at(host, "calendar.form.endAdd")).toBeNull();
    cleanup();
  });

  it("goes back to the offer when its ✕ is pressed", async () => {
    const { host, cleanup } = await render(
      <CalendarEventForm initial={{ ...TIMED, endDate: "2026-11-05", endTime: "10:30" }} onClose={() => undefined} />,
    );
    expect(at(host, "calendar.form.endDate")).not.toBeNull();

    await press(at(host, "calendar.form.endClear"));

    expect(at(host, "calendar.form.endDate")).toBeNull();
    expect(at(host, "calendar.form.endAdd")).not.toBeNull();
    cleanup();
  });
});

describe("the all-day choice", () => {
  it("gives the end a time of its own when the clock comes back", async () => {
    // A day-long span, as a note carries one: no times at either end.
    const { host, cleanup } = await render(
      <CalendarEventForm
        initial={formFromRow({ title: "Away", start: "2026-11-05", end: "2026-11-06" })}
        onClose={() => undefined}
      />,
    );
    expect(at(host, "calendar.form.startTime")).toBeNull();

    await press(at(host, "calendar.form.allDayToggle-timed"));

    expect(at(host, "calendar.form.startTime")?.getAttribute("data-value")).toBe("09:00");
    // Not "00:00": the plan compares the stored value, and midnight on the same
    // day lands before a 09:00 start, which is a refusal the user never caused.
    expect(at(host, "calendar.form.endTime")?.getAttribute("data-value")).toBe("10:00");
    cleanup();
  });
});

describe("a repeat rule the picker cannot build", () => {
  it("is shown as the rule it is", async () => {
    const { host, cleanup } = await render(
      <CalendarEventForm
        initial={formFromRow({
          title: "Standup",
          start: "2026-11-05 09:00",
          repeat: "first monday of every month",
        })}
        onClose={() => undefined}
      />,
    );
    // The four options the picker OFFERS could not express this rule, and the
    // trigger used to print "Never" over a note that repeats every month.
    expect(at(host, "calendar.form.repeatKind")?.textContent).toMatch(/monday of every month/i);
    cleanup();
  });

  it("is left as written until the user chooses something else", async () => {
    const onSubmit = vi.fn();
    const { host, cleanup } = await render(
      <CalendarEventForm
        initial={formFromRow({ title: "Standup", start: "2026-11-05 09:00", repeat: "every other blue moon" })}
        mode="edit"
        onSubmit={onSubmit}
        onClose={() => undefined}
      />,
    );
    await press(at(host, "calendar.form")?.querySelector('[data-variant="primary"]') as HTMLElement);
    // Unreadable to the picker, so the writer must not delete it on a save the
    // user did not ask to change it with.
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ repeatUntouched: true }));
    cleanup();
  });

  it("is replaced once the user does choose", async () => {
    const onSubmit = vi.fn();
    const { host, cleanup } = await render(
      <CalendarEventForm
        initial={formFromRow({ title: "Standup", start: "2026-11-05 09:00", repeat: "every other blue moon" })}
        mode="edit"
        onSubmit={onSubmit}
        onClose={() => undefined}
      />,
    );
    await press(at(host, "calendar.form.repeatKind"));
    const every = [...document.querySelectorAll('[data-testid="calendar.form.repeatKind-option"]')].find(
      (option) => option.textContent?.trim() === "Every",
    ) as HTMLElement | undefined;
    await press(every ?? null);

    await press(at(host, "calendar.form")?.querySelector('[data-variant="primary"]') as HTMLElement);
    // The flag protects a rule from being deleted by accident, not from being
    // replaced: a choice that does not outlive it writes nothing at all.
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ repeatUntouched: false, repeat: { kind: "interval", unit: "week", count: 1 } }),
    );
    cleanup();
  });
});
