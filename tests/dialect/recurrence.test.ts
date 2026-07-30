// Recurrence rule vocabulary and parser (MYND-615, task 1).
//
// The vocabulary is CLOSED. These tests pin both halves of that: every supported
// phrase parses to the expected variant, and anything outside the list yields the
// unrecognized result — never an exception, and never a silent fallback to some
// default rule, which would make a rule Myne cannot read look like one that works.

import { describe, expect, it } from "vitest";
import {
  formatRecurrenceRule,
  parseRecurrenceRule,
  recurrenceFamily,
  type RecurrenceRule,
} from "../../src/dialect/recurrence";

function ruleOf(text: string): RecurrenceRule {
  const parsed = parseRecurrenceRule(text);
  if (!parsed.ok) throw new Error(`expected "${text}" to parse`);
  return parsed.rule;
}

describe("tier 1 — plain intervals", () => {
  it("parses the four bare units", () => {
    expect(ruleOf("every day")).toEqual({ kind: "interval", unit: "day", count: 1 });
    expect(ruleOf("every week")).toEqual({ kind: "interval", unit: "week", count: 1 });
    expect(ruleOf("every month")).toEqual({ kind: "interval", unit: "month", count: 1 });
    expect(ruleOf("every year")).toEqual({ kind: "interval", unit: "year", count: 1 });
  });

  it("parses counted intervals", () => {
    expect(ruleOf("every 3 days")).toEqual({ kind: "interval", unit: "day", count: 3 });
    expect(ruleOf("every 2 weeks")).toEqual({ kind: "interval", unit: "week", count: 2 });
    expect(ruleOf("every 6 months")).toEqual({ kind: "interval", unit: "month", count: 6 });
  });

  it("is case- and whitespace-tolerant, because the value comes from a file", () => {
    expect(ruleOf("Every  3   Days")).toEqual({ kind: "interval", unit: "day", count: 3 });
  });
});

describe("tier 2 — weekday sets", () => {
  it("parses a single weekday", () => {
    expect(ruleOf("every monday")).toEqual({ kind: "weekdays", days: ["monday"] });
  });

  it("parses a two-day set", () => {
    expect(ruleOf("every tuesday and thursday")).toEqual({
      kind: "weekdays",
      days: ["tuesday", "thursday"],
    });
  });

  it("parses a comma list", () => {
    expect(ruleOf("every monday, wednesday and friday")).toEqual({
      kind: "weekdays",
      days: ["monday", "wednesday", "friday"],
    });
  });

  it("normalizes order and duplicates, so two spellings of one set compare equal", () => {
    expect(ruleOf("every friday and monday")).toEqual(ruleOf("every monday and friday"));
    expect(ruleOf("every monday and monday")).toEqual({ kind: "weekdays", days: ["monday"] });
  });
});

describe("tier 3 — ordinal-in-month", () => {
  it("parses an ordinal weekday", () => {
    expect(ruleOf("first monday of every month")).toEqual({
      kind: "ordinal",
      ordinal: "first",
      weekday: "monday",
    });
    expect(ruleOf("last friday of every month")).toEqual({
      kind: "ordinal",
      ordinal: "last",
      weekday: "friday",
    });
  });

  it("parses a day-of-month rule — the direct answer to the month-end question", () => {
    // "keep it on the 31st" is expressible, so nothing has to remember a hidden
    // anchor day the file does not carry.
    expect(ruleOf("day 31 of every month")).toEqual({ kind: "dayOfMonth", day: 31 });
    expect(ruleOf("last day of every month")).toEqual({ kind: "dayOfMonth", day: "last" });
  });
});

describe("the vocabulary is closed", () => {
  const unsupported = [
    "",
    "sometimes",
    "every fortnight",
    "every 2 fortnights",
    "every blursday",
    "fifth monday of every month",
    "day 0 of every month",
    "day 99 of every month",
    "every monday and blursday",
    "FREQ=DAILY;INTERVAL=1",
    "every 3",
  ];

  it("yields the unrecognized result, never an exception", () => {
    for (const text of unsupported) {
      expect(() => parseRecurrenceRule(text)).not.toThrow();
      const parsed = parseRecurrenceRule(text);
      expect(parsed.ok, `"${text}" must not parse`).toBe(false);
    }
  });

  it("keeps the raw text on the unrecognized result, so it can be shown verbatim", () => {
    const parsed = parseRecurrenceRule("every fortnight");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.raw).toBe("every fortnight");
  });

  it("does not fall back to a default rule", () => {
    // The failure mode this guards: an unreadable rule silently behaving as
    // "every day" would repeat a task the user never asked to repeat.
    const parsed = parseRecurrenceRule("whenever");
    expect(parsed.ok).toBe(false);
  });
});

describe("canonical round-trip", () => {
  const canonical = [
    "every day",
    "every 3 days",
    "every week",
    "every 2 weeks",
    "every month",
    "every year",
    "every monday",
    "every tuesday and thursday",
    "every monday, wednesday and friday",
    "first monday of every month",
    "last friday of every month",
    "day 31 of every month",
    "last day of every month",
  ];

  it("every canonical phrase survives parse → format unchanged", () => {
    for (const text of canonical) {
      expect(formatRecurrenceRule(ruleOf(text))).toBe(text);
    }
  });
});

describe("rule families", () => {
  it("interval and weekday rules drift; ordinal and day-of-month do not", () => {
    expect(recurrenceFamily(ruleOf("every month"))).toBe("interval");
    expect(recurrenceFamily(ruleOf("every monday"))).toBe("interval");
    expect(recurrenceFamily(ruleOf("first monday of every month"))).toBe("calendar");
    expect(recurrenceFamily(ruleOf("day 31 of every month"))).toBe("calendar");
  });
});

describe("localized display over canonical storage (task 11)", () => {
  it("returns an i18n descriptor, not an English string", async () => {
    const { describeRecurrenceRule } = await import("../../src/dialect/recurrence");
    // The point: the host translates through its own catalogue. Returning
    // English here and translating elsewhere would put the vocabulary in two
    // places.
    const d = describeRecurrenceRule(ruleOf("every 3 days"));
    expect(d.key).toBe("recurrence.everyN.day");
    expect(d.values).toEqual({ count: 3 });
  });

  it("describes every tier", async () => {
    const { describeRecurrenceRule } = await import("../../src/dialect/recurrence");
    expect(describeRecurrenceRule(ruleOf("every week")).key).toBe("recurrence.every.week");
    expect(describeRecurrenceRule(ruleOf("every monday")).key).toBe("recurrence.everyWeekday");
    expect(describeRecurrenceRule(ruleOf("every monday and friday")).key).toBe(
      "recurrence.everyWeekdays",
    );
    expect(describeRecurrenceRule(ruleOf("first monday of every month")).key).toBe(
      "recurrence.ordinalOfMonth",
    );
    expect(describeRecurrenceRule(ruleOf("day 31 of every month")).key).toBe(
      "recurrence.dayOfMonth",
    );
    expect(describeRecurrenceRule(ruleOf("last day of every month")).key).toBe(
      "recurrence.lastDayOfMonth",
    );
  });

  it("does not change what is stored", async () => {
    const { describeRecurrenceRule } = await import("../../src/dialect/recurrence");
    const rule = ruleOf("every 3 days");
    describeRecurrenceRule(rule);
    expect(formatRecurrenceRule(rule)).toBe("every 3 days");
  });
});
