// @vitest-environment jsdom
//
// Unit tests for the shared property-by-type formatting module (Saved Views #5,
// MYND-275, task 6). The cards renderer uses it now; the future table/list
// renderers reuse it. Golden, behavior-level: each §3.6.4 type renders in its
// typed form (date humanized, list → pills, checkbox → glyph, number/string
// plain), and the pure helpers format/skip correctly.

import { afterEach, describe, expect, it } from "vitest";
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

afterEach(cleanup);

describe("formatDateValue", () => {
  it("humanizes an RFC3339 full-date", () => {
    expect(formatDateValue("2026-06-11")).toBe("11 Jun 2026");
  });
  it("humanizes a date-time", () => {
    expect(formatDateValue("2026-01-05T13:00:00Z")).toBe("5 Jan 2026");
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
      "11 Jun 2026",
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
      "11 Jun 2026",
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
