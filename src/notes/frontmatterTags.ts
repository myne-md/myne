// The §3.7.6 frontmatter-tag coercion, in one place.
//
// Both the tag INDEX (`vaultIndices.ts::extractTags`, which unions these with
// the parser's inline `#tag`s) and the tag WRITER (`ai/acceptTag.ts`, which asks
// what the note already claims before it appends) need the same answer to "what
// does `tags:` / `tag:` say". A reader that disagrees with the writer would let
// the writer append a near-duplicate the index then folds away.
//
// Kept in its own module rather than exported from `vaultIndices.ts` because
// that module imports the platform seam at module scope: the writer is pure and
// IPC-free, and importing it must not drag `invoke` into its graph.

/**
 * Pull frontmatter `tags:` / `tag:` values out of parsed YAML, coercing to
 * strings. Accepts a single scalar, a YAML list, or numbers — a numeric
 * frontmatter tag is valid (§3.7.6), unlike inline `#1984` which the parser
 * already rejects. Pure.
 */
export function collectFrontmatterTags(
  parsed: Record<string, unknown> | null,
): string[] {
  if (parsed === null) return [];
  const out: string[] = [];
  const consume = (raw: unknown): void => {
    if (typeof raw === "string") out.push(raw);
    else if (typeof raw === "number") out.push(String(raw));
    else if (Array.isArray(raw)) for (const item of raw) consume(item);
  };
  consume(parsed["tags"]);
  consume(parsed["tag"]);
  return out;
}
