// The Myne-managed canonical frontmatter field set (MYND-613, task 1).
//
// Spec: `docs/spec/markdown-dialect.md` §3.6.1 — the fields the application owns
// and writes. Everything else in a note's frontmatter is the user's.
//
// This constant exists because the importer's reject list had drifted: it named
// five of the managed fields inline, so an imported file could forge the other
// six. The failure mode is silent and specific — an imported note carrying a
// property named like a managed state field, with a value that happens to be
// valid, is indistinguishable from Myne's own state. Value-strictness protects
// the flag-shaped fields (`template: true` and friends) but NOT the
// timestamp-shaped ones, because an imported ISO date *is* a valid value.
//
// Every importer adapter consumes this list rather than restating it.

/**
 * Every frontmatter key Myne owns (§3.6.1). Ordered as the spec table is.
 *
 * NOTE for MYND-613 tasks 2–3: the task class marker rides the existing `kind`
 * key, but the **completion field is new** and must be added here in the same
 * change that introduces it — otherwise an imported note carrying a
 * completion-shaped property appears completed, which is exactly the hole this
 * constant was created to close.
 */
export const MANAGED_FRONTMATTER_FIELDS = [
  "updated",
  "title",
  "folder",
  "trashed",
  "template",
  "folder_index",
  "kind",
  "archived",
  "deleted",
  "conflict",
  "conflict_of",
  // MYND-613 task 3: the twelfth managed field. Added HERE in the same change
  // that introduced it, per the note above — an imported note carrying a
  // `done:` property with a valid ISO date would otherwise appear completed.
  "done",
] as const;

export type ManagedFrontmatterField = (typeof MANAGED_FRONTMATTER_FIELDS)[number];

const MANAGED_SET: ReadonlySet<string> = new Set(MANAGED_FRONTMATTER_FIELDS);

/**
 * Whether `key` is a Myne-managed frontmatter field and must therefore not be
 * carried over from imported content.
 *
 * Case-insensitive: frontmatter keys arrive from foreign tools in whatever
 * casing the source used, and `Trashed:` would forge state just as effectively
 * as `trashed:`.
 */
export function isManagedFrontmatterField(key: string): boolean {
  return MANAGED_SET.has(key.toLowerCase());
}
