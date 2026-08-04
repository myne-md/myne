// @vitest-environment jsdom
//
// Regression (review Ö-3): a `date`-typed property value must render the SAME
// calendar day in every host timezone. `formatDateValue` anchors a date-only
// value to `T00:00:00Z`, so the formatter must ALSO read UTC — otherwise users
// west of UTC (all of the Americas) see the day shifted back by one.
//
// We set a western TZ *before* importing the module so its module-level
// `Intl.DateTimeFormat` (`DATE_FORMAT`) is constructed under that zone; with the
// `timeZone: "UTC"` fix the output stays "11 Jun 2026" regardless of host TZ.
// (In a UTC-only CI env this can only pass, never false-fail; where the runtime
// honours the TZ change it becomes a real guard against dropping `timeZone`.)

import { describe, expect, it } from "vitest";

describe("formatDateValue timezone-independence", () => {
  it("renders the same calendar day west of UTC (America/New_York)", async () => {
    // Typed access to the Node global without pulling @types/node into the
    // test tsconfig. Node (>=13) honours a runtime `process.env.TZ` change for
    // subsequently-constructed Intl formatters, so setting it before the dynamic
    // import puts the module-level `DATE_FORMAT` under the western zone.
    const g = globalThis as unknown as {
      process: { env: Record<string, string | undefined> };
    };
    g.process.env.TZ = "America/New_York";
    const { formatDateValue } = await import(
      "../../src/notes/views/propertyFormat"
    );
    const { DEFAULT_DISPLAY } = await import("../../src/lib/datetimeFormat");
    // The property under test is unchanged by myne#279 and is the reason the
    // shared formatter keeps the UTC anchor: a civil date names a calendar day,
    // not an instant, so it must not shift west of UTC.
    expect(
      formatDateValue("2026-06-11", { ...DEFAULT_DISPLAY, dateFormat: "iso" }),
    ).toBe("2026-06-11");
    expect(
      formatDateValue("2026-06-11", { ...DEFAULT_DISPLAY, dateFormat: "dmy" }),
    ).toBe("11/06/2026");
  });
});
