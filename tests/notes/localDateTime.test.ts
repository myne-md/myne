// Shared local-time date/time formatters (MYND-338) — the single source of truth
// for `{{date}}` template tokens and the `/date /day /time /now` slash inserts.

import { describe, expect, it } from "vitest";
import {
  formatLocalDate,
  formatLocalDateTime,
  formatLocalTime,
  formatLocalWeekday,
} from "../../src/notes/localDateTime";

describe("localDateTime formatters", () => {
  const d = new Date(2026, 0, 5, 9, 3, 0); // local 2026-01-05 09:03

  it("formatLocalDate → YYYY-MM-DD", () => {
    expect(formatLocalDate(d)).toBe("2026-01-05");
  });

  it("formatLocalTime → HH:mm 24-hour", () => {
    expect(formatLocalTime(d)).toBe("09:03");
  });

  it("formatLocalDateTime → 'YYYY-MM-DD HH:mm'", () => {
    expect(formatLocalDateTime(d)).toBe("2026-01-05 09:03");
  });

  it("formatLocalWeekday → localized long weekday (non-empty)", () => {
    expect(formatLocalWeekday(d)).toBe(
      d.toLocaleDateString(undefined, { weekday: "long" }),
    );
    expect(formatLocalWeekday(d).length).toBeGreaterThan(0);
  });

  it("zero-pads single-digit month/day/hour/minute", () => {
    const e = new Date(2026, 8, 7, 4, 6, 0); // local 2026-09-07 04:06
    expect(formatLocalDate(e)).toBe("2026-09-07");
    expect(formatLocalTime(e)).toBe("04:06");
    expect(formatLocalDateTime(e)).toBe("2026-09-07 04:06");
  });
});
