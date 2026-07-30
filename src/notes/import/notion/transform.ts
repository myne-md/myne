// Notion markdown transforms (importer-breadth epic, MYND-583).
//
// Two source-specific rewrites the shared converter cannot do, because both depend
// on knowing the export's shape rather than the markup's:
//
//   1. PROPERTIES → FRONTMATTER. A database row's properties are exported as a
//      PLAIN-TEXT block at the top of its `.md` (`Status: Done`), not YAML. Lifting
//      them makes them structured data, forward-compatible with the saved-view
//      `property` filter leaf (the AST supports it; the builder UI defers it per
//      `decisions.md` 2026-06-15). The duplicated plain-text block is LEFT IN PLACE:
//      removing it would be a content rewrite beyond the sanctioned-transform
//      allowlist, and a mis-parse would then silently lose data the user cannot see
//      was there. (Grill 2026-07-25 N2.)
//   2. RELATIVE LINKS → WIKILINKS. Notion emits `[Child](Page%20Title%20<hex>.md)`.
//      After import those files do not exist — notes are encrypted blobs — so every
//      such link would be permanently dead and the user's page graph would arrive
//      fully disconnected. (Grill N3.)

import { isManagedFrontmatterField } from "../../../dialect/managedFields";
import { resolveTarget, type NotionResolution } from "./names";

/** A property line: `Key: value`, where the key has no markdown syntax in it. */
const PROPERTY_LINE = /^([A-Za-z0-9][^:\n]{0,80}):[ \t]+(.*)$/;

export interface PropertyLift {
  /** `key → value` pairs found in the leading block. */
  properties: Record<string, string>;
  /** The body, unchanged (the block is deliberately not removed). */
  body: string;
}

/**
 * Lift the leading plain-text property block out of a Notion page body.
 *
 * The block is the CONTIGUOUS run of `Key: value` lines immediately after the page's
 * `# Title` heading, and it ends at the first blank line — which is how Notion always
 * separates the block from the body. The scan also stops at the first non-matching
 * line.
 *
 * DOCUMENTED HEURISTIC, not an exact parse. Distinguishing a property from a prose
 * sentence that happens to contain a colon is not decidable from the text alone:
 * property keys may contain spaces ("Due date"), so no shape rule separates
 * `Due date: tomorrow` from `One caveat: it is a heuristic`. The mitigations are
 * (a) stopping at the blank line Notion always emits, and (b) requiring a key with no
 * sentence punctuation and at most {@link MAX_KEY_WORDS} words. A body line abutting
 * the block with no blank line between MAY still be read as a property; that is the
 * same class of accepted ambiguity as the importer's basename media resolution, and
 * it is non-destructive — the line stays in the body either way, because the block is
 * deliberately never removed.
 */
export function liftProperties(body: string): PropertyLift {
  const lines = body.split("\n");
  const properties: Record<string, string> = {};

  let i = 0;
  // Skip a leading H1 (Notion always emits the page title as one) and blank lines.
  while (i < lines.length && (lines[i]!.trim().length === 0 || /^#\s/.test(lines[i]!))) i++;

  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) break; // the block ends at the blank line
    const m = PROPERTY_LINE.exec(line);
    if (m === null) break;
    const key = m[1]!.trim();
    if (!isPlausiblePropertyKey(key)) break;
    const value = m[2]!.trim();
    if (value.length > 0) properties[key] = value;
  }

  return { properties, body };
}

/** Property keys are short labels, not sentences. */
const MAX_KEY_WORDS = 4;

function isPlausiblePropertyKey(key: string): boolean {
  if (key.length > 40) return false;
  // Sentence punctuation marks prose, never a Notion property name.
  if (/[.,;!?]/.test(key)) return false;
  return key.split(/\s+/).length <= MAX_KEY_WORDS;
}

/** A YAML scalar that survives the round trip: quoted unless plainly safe. */
function yamlScalar(value: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/.test(value) && !/^\d+$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Emit lifted properties as frontmatter lines to be merged into the note.
 *
 * Keys illegal under Myne's grammar are NOT sanitized here — they are returned in
 * `rejected` so the caller can surface them through the existing needs-attention /
 * lossy reporting rather than silently mangling a user's property name.
 */
export function propertiesToFrontmatter(properties: Record<string, string>): {
  lines: string[];
  rejected: string[];
} {
  const lines: string[] = [];
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(properties)) {
    // Reserved Myne-managed fields must never be forged by imported content.
    // The list is the single §3.6.1 constant, not an inline array: it used to
    // name five of the eleven managed fields, which left `updated`,
    // `folder_index`, `kind`, `deleted`, `conflict` and `conflict_of` forgeable.
    if (isManagedFrontmatterField(key)) {
      rejected.push(key);
      continue;
    }
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) {
      rejected.push(key);
      continue;
    }
    lines.push(`${key}: ${yamlScalar(value)}`);
  }
  return { lines, rejected };
}

/**
 * Rewrite relative markdown links to wikilinks on the de-suffixed title.
 *
 * An unresolvable target is left exactly as it was — better a preserved link the user
 * can inspect than a wikilink pointing at nothing — and reported by the caller.
 * Absolute URLs and pure anchors are skipped by `resolveTarget`.
 */
export function rewriteLinks(
  body: string,
  resolution: NotionResolution,
  linkingDir: string,
): { body: string; unresolved: number } {
  let unresolved = 0;
  const out = body.replace(
    /(!?)\[([^\]]*)\]\(([^)\s]+)\)/g,
    (whole, bang: string, text: string, target: string) => {
      // An image ref keeps markdown form: attachments resolve through the shared
      // media pipeline, not the wikilink resolver.
      if (bang === "!") return whole;
      const title = resolveTarget(resolution, linkingDir, target);
      if (title === null) {
        if (!/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("#")) unresolved++;
        return whole;
      }
      return text.trim().length > 0 && text.trim() !== title
        ? `[[${title}|${text}]]`
        : `[[${title}]]`;
    },
  );
  return { body: out, unresolved };
}
