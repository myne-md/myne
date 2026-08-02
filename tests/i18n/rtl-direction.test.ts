// RTL direction helpers (epic rtl-support / SYNC-1). The single machine-readable
// source of "is this locale right-to-left", consumed by the desktop chrome dir
// hook, the editor's neutral-note fallback, and the mobile client.

import { describe, expect, it } from "vitest";
import {
  directionFor,
  isRtl,
  RTL_LANGUAGES,
} from "../../src/i18n/config";

describe("isRtl", () => {
  it("marks the Perso-Arabic + Hebrew scripts RTL", () => {
    for (const code of ["ar", "ur", "fa", "he"]) {
      expect(isRtl(code), code).toBe(true);
    }
  });

  it("matches on the primary subtag (ar-EG resolves like ar)", () => {
    expect(isRtl("ar-EG")).toBe(true);
    expect(isRtl("FA_IR")).toBe(true); // case- + separator-insensitive on the first 2 chars
  });

  it("treats Punjabi (pa) as LTR — Gurmukhi, not Shahmukhi", () => {
    // The classic misclassification the set is written to avoid.
    expect(isRtl("pa")).toBe(false);
  });

  it("treats the shipped LTR locales and unknowns as LTR", () => {
    for (const code of ["en", "tr", "hi", "bn", "sw", "th", "zh", "xx"]) {
      expect(isRtl(code), code).toBe(false);
    }
  });

  it("is false for null / undefined / empty", () => {
    expect(isRtl(null)).toBe(false);
    expect(isRtl(undefined)).toBe(false);
    expect(isRtl("")).toBe(false);
  });
});

describe("directionFor", () => {
  it("maps to the dir attribute value", () => {
    expect(directionFor("ar")).toBe("rtl");
    expect(directionFor("en")).toBe("ltr");
    expect(directionFor(null)).toBe("ltr");
  });
});

describe("RTL_LANGUAGES membership", () => {
  it("contains ar/ur/fa/he and NOT pa", () => {
    for (const code of ["ar", "ur", "fa", "he"]) {
      expect(RTL_LANGUAGES.has(code), code).toBe(true);
    }
    expect(RTL_LANGUAGES.has("pa")).toBe(false);
  });
});
