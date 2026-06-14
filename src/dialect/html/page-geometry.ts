// Page geometry for the PDF export capture document (MYND-255 task 3).
//
// Pure, dependency-free locale → paper-size resolution. The capture template
// (task 4) calls `composePrintStylesheet(navigator.language)` and inlines the
// result into the hidden export window's `<head>` — the print stylesheet
// itself (`./print-stylesheet.ts`) carries everything EXCEPT the `@page size`
// rule, which is appended here from the resolved size.
//
// Policy (PRD story 8): Letter for the US-letter regions (US, CA, MX, PH —
// the countries where Letter, not A4, is the office default), A4 for
// everything else. Resolution keys on the BCP-47 REGION subtag only, so
// `fr-CA` → Letter and `es-ES` → A4 fall out naturally. Anything malformed
// or region-less resolves to A4 (the ISO 216 world default).

import { PRINT_CSS } from "./print-stylesheet";

export type PageSize = "A4" | "Letter";

/** Regions whose office paper default is US Letter, as BCP-47 alpha-2 region
 *  subtags plus their UN M.49 numeric equivalents (US 840, CA 124, MX 484,
 *  PH 608 — numeric regions are valid BCP-47 and cost nothing to honor). */
const LETTER_REGIONS: ReadonlySet<string> = new Set([
  "US", "CA", "MX", "PH",
  "840", "124", "484", "608",
]);

/**
 * Extract the BCP-47 region subtag from a locale tag, or `null` when absent
 * or malformed. Robust to the forms a runtime actually hands out:
 * case-insensitive, POSIX underscores (`en_US`) and charset/modifier suffixes
 * (`en_US.UTF-8`, `tr_TR@euro`) tolerated, script subtags skipped
 * (`zh-Hant-TW` → `TW`). Scanning stops at the first singleton subtag, since
 * extensions/private-use can only follow the region in a well-formed tag.
 */
function bcp47Region(locale: string): string | null {
  const subtags = locale
    .trim()
    .replace(/[.@].*$/, "") // POSIX charset / modifier suffix
    .replace(/_/g, "-")
    .split("-");
  // Primary language subtag: 2–8 alpha (covers grandfathered long forms).
  if (!/^[a-zA-Z]{2,8}$/.test(subtags[0] ?? "")) return null;
  for (let i = 1; i < subtags.length; i++) {
    const s = subtags[i]!;
    if (s.length === 1) break; // extension/private-use singleton
    if (/^[a-zA-Z]{2}$/.test(s)) return s.toUpperCase(); // ISO 3166 alpha-2
    if (/^[0-9]{3}$/.test(s)) return s; // UN M.49 numeric
    // 3-alpha extlang / 4-alpha script / variants: skip and keep scanning.
  }
  return null;
}

/** OS locale → paper size. Letter for the US/CA/MX/PH regions, A4 otherwise
 *  (incl. region-less and malformed input). Pure — same in test and capture. */
export function resolvePageSize(locale: string): PageSize {
  const region = bcp47Region(locale);
  return region !== null && LETTER_REGIONS.has(region) ? "Letter" : "A4";
}

/**
 * The complete print stylesheet for one capture: the static print CSS plus
 * the locale-resolved `@page size` rule (`PageSize` doubles as the CSS
 * `size` descriptor value). The capture template inlines this string into a
 * `<style>` tag (KaTeX CSS + @font-face rules are the template's separate
 * responsibility — see print-stylesheet.ts header). Sync + statically
 * imported: the stylesheet is a small constant string, and this module only
 * ever loads via the capture path's lazy emitter import — no cold-bundle
 * impact, no async ceremony.
 */
export function composePrintStylesheet(locale: string): string {
  return `${PRINT_CSS}\n@page {\n  size: ${resolvePageSize(locale)};\n}\n`;
}
