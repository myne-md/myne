// Property-by-type formatting for the saved-view renderers (MYND-275, Saved
// Views #5, task 6). A SHARED module: the cards renderer uses it now, the future
// table (MYND-277) and list (MYND-278) renderers reuse it verbatim.
//
// The render is a pure CONSUMER of the type the property-index (#1) assigns —
// it never re-types (SYNC-2). Each §3.6.4 type renders in its typed form:
//   - date     → human-readable absolute date ("11 Jun 2026")
//   - list     → one tag PILL per element (reusing the canonical `tagPillStyle`,
//                no new pill component)
//   - checkbox → a calm glyph (☑ / ☐)
//   - number   → plain text
//   - string   → plain text

import type { CSSProperties, ReactNode } from "react";
import type { StoredProperty, StoredScalar } from "./queryEngine";
import { RFC3339_FULL_DATE } from "./propertyTyping";
import { tagPillStyle } from "./tagPillToken";
import {
  dateTimeDisplay,
  formatCivilDate,
  formatInstant,
  formatStoredValue,
  splitStoredValue,
} from "../lib/datetimeFormat";

/** Checked / unchecked glyphs for a checkbox property (calm, glyph-only). */
export const CHECKBOX_CHECKED = "☑";
export const CHECKBOX_UNCHECKED = "☐";

/**
 * Format a `date`-typed property value to a human-readable absolute date.
 * Accepts the §3.6.4 normalized forms (RFC 3339 full-date or date-time); an
 * unparseable value falls back to the raw string (never throws, never blank).
 *
 * myne#279: this used to build its own `Intl.DateTimeFormat("en-GB", …)`, so a
 * user with the app in Turkish, German or US English still got British date
 * formatting here — and it was a literal, not a fallback. It now goes through
 * the one shared formatter, which keeps the no-zone-shift behaviour the old
 * `UTC` anchor was there to provide (a civil date names a calendar day, not an
 * instant) while honouring the user's chosen format.
 */
export function formatDateValue(value: string, display = dateTimeDisplay()): string {
  const t = value.trim();
  if (t === "") return "";
  if (RFC3339_FULL_DATE.test(t)) return formatCivilDate(t, display);
  const { date } = splitStoredValue(t);
  if (date !== null) return formatStoredValue(t, display);
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? value : formatInstant(ms, display);
}

/** True iff a checkbox value reads as checked (the §3.6.4 canonical is
 *  `"true"`/`"false"`; tolerant of case + whitespace). */
export function isCheckboxChecked(value: string): boolean {
  return value.trim().toLowerCase() === "true";
}

/** Plain display text for a single scalar by its type (date humanized; checkbox
 *  → glyph; number/string verbatim). The text twin of {@link PropertyValue} for
 *  callers that need a string (titles, tooltips). */
export function formatScalarText(scalar: StoredScalar): string {
  switch (scalar.type) {
    case "date":
      return formatDateValue(scalar.value);
    case "checkbox":
      return isCheckboxChecked(scalar.value)
        ? CHECKBOX_CHECKED
        : CHECKBOX_UNCHECKED;
    case "number":
    case "string":
      return scalar.value;
  }
}

/** True iff the property has something to render (so the caller can skip an
 *  empty row). A list with zero non-empty elements / an empty scalar → false. */
export function hasDisplayableValue(prop: StoredProperty | undefined): boolean {
  if (prop === undefined) return false;
  if (prop.type === "list") {
    return (prop.elements ?? []).some((el) => el.value.trim().length > 0);
  }
  // A checkbox always renders a glyph (even "false"); other scalars need text.
  if (prop.type === "checkbox") return (prop.value ?? "").trim().length > 0;
  return (prop.value ?? "").trim().length > 0;
}

const PILL_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
};

const CHECKBOX_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  color: "var(--fg-2)",
};

/**
 * Render a stored property in its typed form. Pure, read-only — returns
 * `null` when there is nothing to show. List elements become tag pills via the
 * shared `tagPillStyle` (no new pill component); checkbox → glyph; date →
 * humanized; number/string → plain text.
 */
export function PropertyValue({
  prop,
}: {
  prop: StoredProperty | undefined;
}): ReactNode {
  if (!hasDisplayableValue(prop) || prop === undefined) return null;

  if (prop.type === "list") {
    const els = (prop.elements ?? []).filter((el) => el.value.trim().length > 0);
    return (
      <span data-testid="view.prop-list" style={PILL_ROW_STYLE}>
        {els.map((el, i) => (
          <span key={`${el.value}-${i}`} style={tagPillStyle()}>
            {el.value}
          </span>
        ))}
      </span>
    );
  }

  if (prop.type === "checkbox") {
    const checked = isCheckboxChecked(prop.value ?? "");
    return (
      <span
        data-testid="view.prop-checkbox"
        data-checked={checked ? "true" : "false"}
        style={CHECKBOX_STYLE}
      >
        {checked ? CHECKBOX_CHECKED : CHECKBOX_UNCHECKED}
      </span>
    );
  }

  // date / number / string → plain text (date humanized).
  return (
    <span data-testid="view.prop-text">
      {formatScalarText({ type: prop.type, value: prop.value ?? "" })}
    </span>
  );
}
