// @vitest-environment jsdom
//
// Unit tests for the shared property-by-type formatting module (Saved Views #5,
// MYND-275, task 6). The cards renderer uses it now; the future table/list
// renderers reuse it. Golden, behavior-level: each §3.6.4 type renders in its
// typed form (date humanized, list → pills, checkbox → glyph, number/string
// plain), and the pure helpers format/skip correctly.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  CHECKBOX_CHECKED,
  CHECKBOX_UNCHECKED,
  PropertyValue,
  formatDateValue,
  formatScalarText,
  hasDisplayableValue,
  isCheckboxChecked,
} from "../../src/notes/views/propertyFormat";
import type { StoredProperty } from "../../src/notes/queryEngine";
import {
  DEFAULT_DISPLAY,
  setDateTimeDisplay,
  __resetDateTimeDisplayForTest,
} from "../../src/lib/datetimeFormat";

afterEach(cleanup);

// myne#279: these two surfaces read the AMBIENT display settings, so pin one
// explicitly rather than depending on whatever locale the runner happens to
// have. What is under test is that the cell follows the setting.
beforeEach(() => setDateTimeDisplay({ ...DEFAULT_DISPLAY, dateFormat: "iso" }));
afterEach(() => __resetDateTimeDisplayForTest());

describe("formatDateValue", () => {
  // myne#279 — this used to build its own `Intl.DateTimeFormat("en-GB", …)`, so
  // the expectations here were British by construction and stayed British for a
  // user with the app in Turkish, German or US English. The cells now go through
  // the one shared formatter, so what is pinned is the FORMAT FOLLOWING THE
  // SETTING rather than one hardcoded locale's output.
  const display = (over = {}) => ({ ...DEFAULT_DISPLAY, ...over });

  it("humanizes an RFC3339 full-date in the chosen format", () => {
    expect(formatDateValue("2026-06-11", display({ dateFormat: "iso" }))).toBe("2026-06-11");
    expect(formatDateValue("2026-06-11", display({ dateFormat: "dmy" }))).toBe("11/06/2026");
    expect(formatDateValue("2026-06-11", display({ dateFormat: "mdy" }))).toBe("06/11/2026");
  });
  it("humanizes a date-time", () => {
    expect(formatDateValue("2026-01-05T13:00:00Z", display({ dateFormat: "iso" }))).toBe(
      "2026-01-05",
    );
  });
  it("falls back to the raw string on an unparseable value", () => {
    expect(formatDateValue("not-a-date")).toBe("not-a-date");
  });
  it("returns empty for an empty value", () => {
    expect(formatDateValue("")).toBe("");
  });
});

describe("isCheckboxChecked", () => {
  it("true / TRUE / padded → checked; everything else → unchecked", () => {
    expect(isCheckboxChecked("true")).toBe(true);
    expect(isCheckboxChecked(" TRUE ")).toBe(true);
    expect(isCheckboxChecked("false")).toBe(false);
    expect(isCheckboxChecked("")).toBe(false);
    expect(isCheckboxChecked("1")).toBe(false);
  });
});

describe("formatScalarText", () => {
  it("date → humanized, number/string → verbatim, checkbox → glyph", () => {
    expect(formatScalarText({ type: "date", value: "2026-06-11" })).toBe(
      "2026-06-11",
    );
    expect(formatScalarText({ type: "number", value: "42" })).toBe("42");
    expect(formatScalarText({ type: "string", value: "hi" })).toBe("hi");
    expect(formatScalarText({ type: "checkbox", value: "true" })).toBe(
      CHECKBOX_CHECKED,
    );
    expect(formatScalarText({ type: "checkbox", value: "false" })).toBe(
      CHECKBOX_UNCHECKED,
    );
  });
});

describe("hasDisplayableValue", () => {
  it("undefined / empty scalar / empty list → false", () => {
    expect(hasDisplayableValue(undefined)).toBe(false);
    expect(hasDisplayableValue({ key: "k", type: "string", value: "" })).toBe(
      false,
    );
    expect(
      hasDisplayableValue({ key: "k", type: "list", elements: [] }),
    ).toBe(false);
  });
  it("non-empty scalar / non-empty list / checkbox → true", () => {
    expect(hasDisplayableValue({ key: "k", type: "string", value: "x" })).toBe(
      true,
    );
    expect(
      hasDisplayableValue({
        key: "k",
        type: "list",
        elements: [{ type: "string", value: "a" }],
      }),
    ).toBe(true);
    expect(
      hasDisplayableValue({ key: "k", type: "checkbox", value: "false" }),
    ).toBe(true);
  });
});

describe("PropertyValue render", () => {
  const p = (over: Partial<StoredProperty> & Pick<StoredProperty, "type">) =>
    ({ key: "k", ...over }) as StoredProperty;

  it("list → one pill per non-empty element", () => {
    render(
      <PropertyValue
        prop={p({
          type: "list",
          elements: [
            { type: "string", value: "epic" },
            { type: "string", value: "desert" },
            { type: "string", value: "" }, // empty filtered out
          ],
        })}
      />,
    );
    const list = screen.getByTestId("view.prop-list");
    expect(list.textContent).toBe("epicdesert");
    expect(list.children).toHaveLength(2);
  });

  it("checkbox → glyph with data-checked", () => {
    render(<PropertyValue prop={p({ type: "checkbox", value: "true" })} />);
    const box = screen.getByTestId("view.prop-checkbox");
    expect(box.getAttribute("data-checked")).toBe("true");
    expect(box.textContent).toBe(CHECKBOX_CHECKED);
  });

  it("date → humanized text", () => {
    render(<PropertyValue prop={p({ type: "date", value: "2026-06-11" })} />);
    expect(screen.getByTestId("view.prop-text").textContent).toBe(
      "2026-06-11",
    );
  });

  it("number/string → plain text", () => {
    render(<PropertyValue prop={p({ type: "number", value: "7" })} />);
    expect(screen.getByTestId("view.prop-text").textContent).toBe("7");
  });

  it("empty/undefined → renders nothing", () => {
    const { container } = render(<PropertyValue prop={undefined} />);
    expect(container.firstChild).toBeNull();
  });
});
