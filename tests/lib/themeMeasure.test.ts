// Measure-token clamp (deep-customization, myne#394 task 3).
//
// The clamp is the protective envelope that lets a theme reshape density and
// rhythm without being able to produce an unusable window — the same posture as
// the auto-lock bounds, where a tampered pref can only make the app stricter.
// Its rule is deliberately ONE rule for every family (0.5×–2× of the built-in
// default), so a token added later inherits a bound with no second decision.

import { describe, expect, it } from "vitest";
import {
  CLAMP_MAX_RATIO,
  CLAMP_MIN_RATIO,
  clampMeasure,
  clampPalette,
  isMeasureKey,
  MEASURE_KEYS,
} from "../../src/lib/themeMeasure";

describe("isMeasureKey", () => {
  it("recognizes every family", () => {
    for (const key of ["--space-4", "--radius-2", "--text-base", "--weight-medium", "--tracking-wide"]) {
      expect(isMeasureKey(key)).toBe(true);
    }
  });

  it("does not claim color or ornament keys", () => {
    for (const key of ["--paper", "--ink-1", "--accent", "--box-frame", "--surface-texture"]) {
      expect(isMeasureKey(key)).toBe(false);
    }
  });
});

describe("clampMeasure", () => {
  it("passes a value inside the band through verbatim", () => {
    expect(clampMeasure("20px", "16px")).toBe("20px");
    expect(clampMeasure("8px", "16px")).toBe("8px");
    expect(clampMeasure("32px", "16px")).toBe("32px");
  });

  it("clamps an oversized value down to the ceiling", () => {
    // The failure this exists for: `--space-4: 400px` on a 16px default.
    expect(clampMeasure("400px", "16px")).toBe(`${16 * CLAMP_MAX_RATIO}px`);
  });

  it("clamps an undersized value up to the floor", () => {
    expect(clampMeasure("1px", "16px")).toBe(`${16 * CLAMP_MIN_RATIO}px`);
  });

  it("clamps rather than rejects, so the theme still applies", () => {
    // A rejected value would silently leave the built-in in place and read as
    // "my theme did nothing"; a clamped one reads as "not quite that far".
    expect(clampMeasure("999rem", "1rem")).not.toBeNull();
  });

  it("handles unitless values (font weight)", () => {
    expect(clampMeasure("600", "400")).toBe("600");
    expect(clampMeasure("900", "400")).toBe("800");
    expect(clampMeasure("50", "400")).toBe("200");
  });

  it("preserves fractional values and their unit", () => {
    expect(clampMeasure("0.75rem", "1rem")).toBe("0.75rem");
    expect(clampMeasure("1.5em", "1em")).toBe("1.5em");
  });

  it("refuses a value whose unit differs from the default's", () => {
    // Cross-unit comparison has no honest answer (1rem is 16px only by
    // convention, and the root size is itself themable), so the clamp cannot be
    // guaranteed and the token is skipped rather than applied unbounded.
    expect(clampMeasure("2rem", "16px")).toBeNull();
    expect(clampMeasure("16px", "1rem")).toBeNull();
  });

  it("refuses a non-numeric value", () => {
    expect(clampMeasure("thick", "16px")).toBeNull();
    expect(clampMeasure("", "16px")).toBeNull();
  });

  it("refuses when the default is unreadable", () => {
    // Fail-safe: with no default there is no band, and applying unbounded is
    // exactly what the clamp exists to prevent.
    expect(clampMeasure("20px", "")).toBeNull();
    expect(clampMeasure("20px", "auto")).toBeNull();
  });

  it("pins a zero default to zero", () => {
    // `--space-0` is 0; 0.5×0 and 2×0 are both 0, so the band is a point. This
    // is intentional rather than a degenerate case — a zero gap stays a zero gap.
    expect(clampMeasure("4", "0")).toBe("0");
  });
});

describe("clampPalette", () => {
  const defaults = { "--space-4": "16px", "--text-base": "15px", "--weight-medium": "500" };

  it("leaves non-measure keys untouched", () => {
    const { applied, skipped } = clampPalette(
      { "--paper": "#fff", "--box-frame": "thick" },
      defaults,
    );
    expect(applied).toEqual({ "--paper": "#fff", "--box-frame": "thick" });
    expect(skipped).toEqual([]);
  });

  it("clamps measure keys and reports nothing as skipped", () => {
    const { applied, skipped } = clampPalette({ "--space-4": "160px" }, defaults);
    expect(applied["--space-4"]).toBe("32px");
    expect(skipped).toEqual([]);
  });

  it("skips a measure key it cannot bound, and says which", () => {
    const { applied, skipped } = clampPalette({ "--space-4": "2rem" }, defaults);
    expect(applied["--space-4"]).toBeUndefined();
    expect(skipped).toEqual(["--space-4"]);
  });

  it("skips a measure key with no known default", () => {
    const { applied, skipped } = clampPalette({ "--radius-2": "40px" }, defaults);
    expect(applied["--radius-2"]).toBeUndefined();
    expect(skipped).toEqual(["--radius-2"]);
  });

  it("is exhaustive over the vocabulary it claims", () => {
    // Every key this module says it governs must be clampable given a default;
    // a key on the list with no handling would apply unbounded.
    for (const key of MEASURE_KEYS) {
      const { applied } = clampPalette({ [key]: "10px" }, { [key]: "10px" });
      expect(applied[key], `${key} was dropped despite a matching default`).toBe("10px");
    }
  });
});
