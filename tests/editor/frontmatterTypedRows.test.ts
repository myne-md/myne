// @vitest-environment jsdom
//
// The Properties widget renders each row by its property's TYPE (myne-md/myne#777).
//
// `propertyTyping.ts` is the single type authority — markdown-dialect.md 3.6.4,
// pinned by the `property-coercion` golden vectors — and the widget ignored it.
// Every scalar rendered as a plain text input, so a date was a text field, a
// checkbox was a text field the user had to type the word "true" into, and a
// number was a text field that accepted "banana".
//
// This spec pins the TYPING, which is the part that has to agree with the query
// engine. The DOM the widget builds from it is exercised through the editor's
// own integration tests; what would be a silent regression is this file
// re-deriving an opinion about what `2026-01-02` is, because then the widget and
// Saved Views could disagree about the same note.

import { describe, expect, it } from "vitest";
import { coerceSourceScalar } from "../../editor/src/host/notes/propertyTyping";
import { isCalendarDate } from "../../editor/src/decorations/frontmatter";

describe("the type authority answers what the widget needs", () => {
  it("recognises an RFC-3339 full date, quoted or not", () => {
    expect(coerceSourceScalar("2026-01-02").type).toBe("date");
    expect(coerceSourceScalar("2026-01-02T10:00:00Z").type).toBe("date");
  });

  it("recognises a number, and does not mistake a version string for one", () => {
    expect(coerceSourceScalar("42").type).toBe("number");
    // `1.2.3` is not a number, and a numeric input that accepted it would
    // silently drop what the user typed on the next commit.
    expect(coerceSourceScalar("1.2.3").type).toBe("string");
  });

  it("recognises a boolean", () => {
    expect(coerceSourceScalar("true").type).toBe("checkbox");
    expect(coerceSourceScalar("false").type).toBe("checkbox");
  });

  it("falls back to string for anything else", () => {
    // The fallback matters more than the recognisers: an unrecognised value
    // must render as the text field it always did, not as an empty picker that
    // has quietly lost the user's data.
    expect(coerceSourceScalar("banana").type).toBe("string");
    expect(coerceSourceScalar("").type).toBe("string");
  });

  it("types an IMPOSSIBLE date as a date, which is correct and is a trap", () => {
    // The recogniser is shape-only, so `2026-13-45` is a `date`. That is right
    // for the index — it is answering "what kind of value is this" — and it is
    // pinned by the published `property-coercion` vectors, so it is not the
    // widget's to change.
    //
    // It is also exactly why the widget cannot hand every `date` to a native
    // `<input type="date">`: that control silently refuses a value it cannot
    // parse, the field renders EMPTY, and the user's text looks deleted. See
    // the `isCalendarDate` block below.
    expect(coerceSourceScalar("2026-13-45").type).toBe("date");
  });
});

describe("the widget refuses the native date control for a date it would eat", () => {
  it("accepts a real calendar date", () => {
    expect(isCalendarDate("2026-01-02")).toBe(true);
    expect(isCalendarDate("2024-02-29")).toBe(true); // a leap year
  });

  it("rejects an impossible one, so the row stays a text field", () => {
    for (const bad of ["2026-13-45", "2026-04-31", "2025-02-29", "2026-00-10"]) {
      expect(isCalendarDate(bad), bad).toBe(false);
    }
  });

  it("rejects a date-TIME, which the native control cannot hold either", () => {
    // `<input type="date">` takes `YYYY-MM-DD` and nothing else. A timestamp
    // types as `date` and must still render as text, or its time component is
    // dropped on the first commit.
    expect(isCalendarDate("2026-01-02T10:00:00Z")).toBe(false);
  });

  it("round-trips the value verbatim, whatever the type", () => {
    // The widget writes `value` back into the YAML. A coercion that normalised
    // `2026-01-02` to some other spelling would rewrite the user's file on a
    // render, which is the one thing this layer must never do.
    for (const v of ["2026-01-02", "42", "true", "banana", "1.2.3"]) {
      expect(coerceSourceScalar(v).value).toBe(v);
    }
  });
});
