// @vitest-environment jsdom
//
// The Myne-owned date + time picker (myne-md/myne#614). Replaced the platform
// `<input type="date">` / `<input type="time">`, so what is worth pinning is
// what the platform control could never do: print in the user's chosen
// `date_format` / `time_format`, and agree across locales by drawing from Intl.

import { afterEach, describe, expect, it } from "vitest";
import { buildTaskDateTimeControl } from "@myne/editor/task-date-time-picker";
import {
  DEFAULT_DISPLAY,
  setDateTimeDisplay,
  __resetDateTimeDisplayForTest,
} from "@myne/editor/host/lib/datetimeFormat";

afterEach(() => __resetDateTimeDisplayForTest());

const day = (root: HTMLElement, iso: string): HTMLElement =>
  root.querySelector(`[data-date="${iso}"]`)!;
const byTestId = (root: HTMLElement, id: string): HTMLElement =>
  root.querySelector(`[data-testid="${id}"]`)!;
const press = (el: HTMLElement, key: string): void => {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
};

describe("date picker", () => {
  it("renders the stored month and marks the stored day selected", () => {
    const control = buildTaskDateTimeControl("2026-08-01");
    expect(byTestId(control.root, "editor.task-date-month").textContent).toContain("August");
    expect(byTestId(control.root, "editor.task-date-month").textContent).toContain("2026");
    const stored = day(control.root, "2026-08-01");
    expect(stored.classList.contains("is-selected")).toBe(true);
    expect(stored.parentElement!.getAttribute("aria-selected")).toBe("true");
    expect(control.getValue()).toBe("2026-08-01");
  });

  it("navigates months with the header buttons", () => {
    const control = buildTaskDateTimeControl("2026-08-01");
    byTestId(control.root, "editor.task-date-next").click();
    expect(byTestId(control.root, "editor.task-date-month").textContent).toContain("September");
    byTestId(control.root, "editor.task-date-prev").click();
    expect(byTestId(control.root, "editor.task-date-month").textContent).toContain("August");
  });

  it("moves a day with the arrow keys and a month with PageDown", () => {
    const control = buildTaskDateTimeControl("2026-08-01");
    const cursor = () => byTestId(control.root, "editor.task-field-input").getAttribute("data-date");
    press(day(control.root, "2026-08-01"), "ArrowRight");
    expect(cursor()).toBe("2026-08-02");
    // The committed value follows the focused day, so arrowing then Enter
    // commits the day the user can see focused.
    expect(control.getValue()).toBe("2026-08-02");
    press(day(control.root, "2026-08-02"), "PageDown");
    expect(byTestId(control.root, "editor.task-date-month").textContent).toContain("September");
    expect(cursor()).toBe("2026-09-02");
    expect(control.getValue()).toBe("2026-09-02");
  });

  it("prints the chosen day in the user's date_format (not the WebView's)", () => {
    setDateTimeDisplay({ ...DEFAULT_DISPLAY, dateFormat: "dmy" });
    const control = buildTaskDateTimeControl("2026-08-01");
    expect(byTestId(control.root, "editor.task-date-value").textContent).toBe("01/08/2026");
  });

  it("clears the whole field", () => {
    const control = buildTaskDateTimeControl("2026-08-01 09:00");
    byTestId(control.root, "editor.task-field-clear").click();
    expect(control.getValue()).toBe("");
  });
});

describe("time picker", () => {
  it("is optional, so a date-only value commits no time", () => {
    const control = buildTaskDateTimeControl("2026-08-01");
    expect(control.root.querySelector('[data-testid="editor.task-time-hour"]')).toBeNull();
    byTestId(control.root, "editor.task-time-add").click();
    expect(control.getValue()).toBe("2026-08-01 09:00");
  });

  it("uses a 24-hour control when time_format is 24h", () => {
    setDateTimeDisplay({ ...DEFAULT_DISPLAY, timeFormat: "24h" });
    const control = buildTaskDateTimeControl("2026-08-01 14:00");
    expect(byTestId(control.root, "editor.task-time-hour").getAttribute("aria-valuenow")).toBe("14");
    expect(control.root.querySelector('[data-testid="editor.task-time-meridiem"]')).toBeNull();
    expect(control.getValue()).toBe("2026-08-01 14:00");
  });

  it("uses a 12-hour control with a real AM/PM toggle when time_format is 12h", () => {
    setDateTimeDisplay({ ...DEFAULT_DISPLAY, timeFormat: "12h" });
    const control = buildTaskDateTimeControl("2026-08-01 14:00");
    const hour = byTestId(control.root, "editor.task-time-hour");
    const meridiem = byTestId(control.root, "editor.task-time-meridiem");
    expect(hour.getAttribute("aria-valuenow")).toBe("2");
    expect(meridiem.textContent).toBe("PM");
    meridiem.click();
    expect(hour.getAttribute("aria-valuenow")).toBe("2");
    expect(meridiem.textContent).toBe("AM");
    expect(control.getValue()).toBe("2026-08-01 02:00");
  });

  it("never emits a bare time, because a time with no date is no TaskInstant", () => {
    const control = buildTaskDateTimeControl("");
    byTestId(control.root, "editor.task-time-add").click();
    expect(control.getValue()).toBe("");
  });

  it("keeps the stored bytes exact", () => {
    const control = buildTaskDateTimeControl("2026-08-01 14:37");
    expect(control.getValue()).toBe("2026-08-01 14:37");
  });
});
