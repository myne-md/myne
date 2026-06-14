// Page geometry for the PDF export capture document (MYND-255 task 3).
//
// Pins the locale → paper-size mapping explicitly (PRD story 8 + task 3
// acceptance: "tests pin geometry explicitly") and the composed-stylesheet
// contract the capture template (task 4) relies on.

import { describe, expect, it } from "vitest";
import {
  composePrintStylesheet,
  resolvePageSize,
  type PageSize,
} from "../../../src/dialect/html/page-geometry";
import { PRINT_CSS } from "../../../src/dialect/html/print-stylesheet";

describe("resolvePageSize", () => {
  const MATRIX: ReadonlyArray<[locale: string, expected: PageSize]> = [
    // US-letter regions (US / CA / MX / PH) → Letter, language-independent.
    ["en-US", "Letter"],
    ["en-CA", "Letter"],
    ["fr-CA", "Letter"],
    ["es-MX", "Letter"],
    ["fil-PH", "Letter"],
    ["en-PH", "Letter"],
    // Everything else → A4.
    ["en-GB", "A4"],
    ["tr-TR", "A4"],
    ["de-DE", "A4"],
    ["ja-JP", "A4"],
    ["es-ES", "A4"],
    ["pt-BR", "A4"],
  ];

  it.each(MATRIX)("%s → %s", (locale, expected) => {
    expect(resolvePageSize(locale)).toBe(expected);
  });

  it("is case-insensitive on both subtags", () => {
    expect(resolvePageSize("EN-us")).toBe("Letter");
    expect(resolvePageSize("tr-tr")).toBe("A4");
  });

  it("tolerates POSIX underscore + charset/modifier forms", () => {
    expect(resolvePageSize("en_US")).toBe("Letter");
    expect(resolvePageSize("en_US.UTF-8")).toBe("Letter");
    expect(resolvePageSize("tr_TR@euro")).toBe("A4");
  });

  it("skips script subtags to reach the region", () => {
    expect(resolvePageSize("zh-Hant-TW")).toBe("A4");
    expect(resolvePageSize("en-Latn-US")).toBe("Letter");
  });

  it("honors UN M.49 numeric regions", () => {
    expect(resolvePageSize("en-840")).toBe("Letter"); // 840 = US
    expect(resolvePageSize("es-419")).toBe("A4"); // 419 = Latin America macro
  });

  it("region after an extension singleton is NOT a region — defaults A4", () => {
    // In well-formed BCP-47 the region precedes extensions; a 2-alpha subtag
    // after a singleton is extension payload, never a region.
    expect(resolvePageSize("en-u-ca-us")).toBe("A4");
  });

  it("region-less tags default to A4", () => {
    expect(resolvePageSize("en")).toBe("A4");
    expect(resolvePageSize("tr")).toBe("A4");
  });

  it("malformed input defaults to A4", () => {
    expect(resolvePageSize("")).toBe("A4");
    expect(resolvePageSize("   ")).toBe("A4");
    expect(resolvePageSize("-US")).toBe("A4");
    expect(resolvePageSize("123-US")).toBe("A4");
    expect(resolvePageSize("not a locale")).toBe("A4");
  });
});

describe("composePrintStylesheet", () => {
  it("is the full print CSS plus the locale-resolved @page size rule", () => {
    const sheet = composePrintStylesheet("en-US");
    expect(sheet).toContain(PRINT_CSS);
    expect(sheet).toMatch(/@page\s*\{\s*size:\s*Letter;\s*\}/);
  });

  it("resolves A4 for non-letter locales", () => {
    expect(composePrintStylesheet("tr-TR")).toMatch(
      /@page\s*\{\s*size:\s*A4;\s*\}/,
    );
  });

  it("carries the fixed 20mm page margin from the print CSS", () => {
    expect(composePrintStylesheet("en-US")).toMatch(
      /@page\s*\{\s*margin:\s*20mm;\s*\}/,
    );
  });

  it("emits exactly one size rule (the static CSS carries none)", () => {
    expect(PRINT_CSS).not.toMatch(/size:\s*(A4|Letter)/);
    const sheet = composePrintStylesheet("fr-CA");
    expect(sheet.match(/size:\s*(A4|Letter)/g)).toHaveLength(1);
  });
});
