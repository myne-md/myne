// Property value typing / coercion — the Saved Views single type authority
// (MYND-271). Implements `markdown-dialect.md` §3.6.4 verbatim: a YAML 1.2
// frontmatter value coerces to exactly one Myne property type — string /
// number / date / list / checkbox.
//
// Build-B: this is the TS-side typing layer. Rust stores the resulting
// pre-typed values opaquely and never parses YAML (TB9). property-index is the
// single type authority; sibling features (query-engine, view-model, render,
// .base import) consume this typing and never redefine it.
//
// Resolution uses js-yaml under CORE_SCHEMA (YAML 1.2 core, §10.2.1) — NOT the
// project default schema (which resolves ISO dates to Date objects and is the
// reader for `title:`/`folder:`). Re-parsing under CORE keeps dates as strings
// so the Myne RFC-3339 recognizer types them uniformly (quoted or not) and the
// normalized form stays the verbatim source string. Pinned by the
// `property-coercion` golden vectors in `myne-test-vectors`.

import { CORE_SCHEMA, load as loadYaml } from "js-yaml";

/** A scalar Myne property type (a `list`'s elements are each one of these). */
export type ScalarPropertyType = "string" | "number" | "date" | "checkbox";

/** Every Myne property type. */
export type PropertyType = ScalarPropertyType | "list";

/** A coerced scalar: the type tag + its canonical normalized string form. */
export type ScalarProperty = { type: ScalarPropertyType; value: string };

/** A coerced value — a scalar, or a list of independently-coerced scalars. */
export type TypedProperty =
  | ScalarProperty
  | { type: "list"; elements: ScalarProperty[] };

/** One arbitrary frontmatter key, typed. The opaque payload Rust stores. */
export type PropertyEntry = { key: string } & TypedProperty;

// RFC 3339 full-date (`YYYY-MM-DD`) and date-time, whole-string-anchored. YAML
// 1.2 core has no native timestamp, so dates arrive as strings; Myne recognizes
// them here (§3.6.4 step 3). `.test` on a trimmed string.
const RFC3339_FULL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RFC3339_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isRfc3339(s: string): boolean {
  return RFC3339_FULL_DATE.test(s) || RFC3339_DATE_TIME.test(s);
}

/**
 * Coerce one YAML-resolved scalar (the runtime value from a CORE_SCHEMA parse)
 * to a Myne scalar property. §3.6.4 step 3, in rule order:
 *   1. boolean         → checkbox  (`true`/`false`)
 *   2. finite number   → number    (canonical decimal of the parsed double)
 *      non-finite      → string    (`.inf`/`.nan` edge)
 *   3. string matching RFC 3339 (whole-string) → date  (verbatim, trimmed)
 *   4. else            → string    (verbatim; NO unicode normalization)
 * A nested sequence/mapping element coerces to `string` (no list-of-lists in
 * v0.1) — its flow-style JSON serialization (a documented edge).
 */
export function coerceScalar(value: unknown): ScalarProperty {
  if (typeof value === "boolean") {
    return { type: "checkbox", value: value ? "true" : "false" };
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? { type: "number", value: String(value) }
      : { type: "string", value: String(value) };
  }
  if (value === null || value === undefined) {
    return { type: "string", value: "" };
  }
  if (typeof value === "object") {
    // Nested sequence / mapping — not a scalar; coerce to its serialization.
    return { type: "string", value: JSON.stringify(value) };
  }
  const s = String(value);
  const trimmed = s.trim();
  if (isRfc3339(trimmed)) {
    // date → the trimmed RFC 3339 string; string → the resolved value verbatim.
    return { type: "date", value: trimmed };
  }
  return { type: "string", value: s };
}

/**
 * Coerce one YAML-resolved value: a sequence → `list` (each element coerced as
 * a scalar, heterogeneous allowed; empty sequence → empty list), anything else
 * → a scalar via [`coerceScalar`].
 */
export function coerceValue(value: unknown): TypedProperty {
  if (Array.isArray(value)) {
    return { type: "list", elements: value.map((e) => coerceScalar(e)) };
  }
  return coerceScalar(value);
}

/**
 * Extract the typed property index contribution from a note's raw frontmatter
 * text. Re-parses under CORE_SCHEMA (see module note) and coerces every
 * arbitrary key. Returns `[]` for absent / non-mapping / malformed frontmatter
 * — best-effort, never throws (the index self-heals on the next reconcile).
 *
 * Every key is included (managed fields are *observed*, not excluded, §3.6.4);
 * the query layer decides presentation. The five Myne-managed fields keep their
 * value-strict semantics by virtue of the coercion (`trashed:` → date when a
 * valid RFC 3339, `template:` → checkbox only on a core boolean).
 */
export function extractProperties(rawFrontmatter: string | null): PropertyEntry[] {
  if (rawFrontmatter === null || rawFrontmatter.length === 0) return [];
  let obj: unknown;
  try {
    obj = loadYaml(rawFrontmatter, { schema: CORE_SCHEMA });
  } catch {
    return [];
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return [];
  const out: PropertyEntry[] = [];
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    out.push({ key, ...coerceValue(value) });
  }
  return out;
}
