// Tag-accept write cores (auto-tag-link MYND-411 task 5). Pure helpers that
// compute the post-accept frontmatter tag list or the post-accept body for an
// inline `#tag` insert — byte-identical to a hand-typed tag, no new writer, no
// new format. The actual persistence routes through the EXISTING writers
// (`patchFrontmatterField` for frontmatter `tags:`, `saveNote` for an inline
// `#tag`); these cores are what those writers persist.
//
// Both are idempotent under the §3.7.8 fold (`foldSegment`) — accepting a tag
// already present (in any case/NFC variant) is a no-op, so a chip can't produce
// a duplicate. Pure, model-independent.

import { foldSegment } from "../../dialect/folderPath";

/**
 * Clean an accepted tag token: trim + strip a single leading `#` + trim. The
 * suggestion display form the ranker emits is already bare, but a defensive
 * clean keeps the write path robust. (Mirrors `tagRanker.cleanTagToken`.)
 */
function cleanAcceptedTag(raw: string): string {
  const trimmed = raw.trim();
  const bare = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  return bare.trim();
}

/**
 * Compute the frontmatter `tags:` list after accepting `newTag`. Appends the
 * cleaned tag unless an existing tag already folds onto it (idempotent — no
 * near-duplicate). Returns the existing list unchanged when the tag is empty or
 * already present. Existing display casing is preserved; the appended tag keeps
 * its own cleaned casing. Pure.
 */
export function computeTagsAfterAccept(
  existingTags: readonly string[],
  newTag: string,
): string[] {
  const cleaned = cleanAcceptedTag(newTag);
  if (cleaned.length === 0) return [...existingTags];
  const key = foldSegment(cleaned);
  const present = existingTags.some((t) => foldSegment(cleanAcceptedTag(t)) === key);
  return present ? [...existingTags] : [...existingTags, cleaned];
}

/**
 * Append an inline `#tag` to a note body, byte-identical to a hand-typed tag.
 * Idempotent under the fold: if the body already contains the tag as an inline
 * `#tag` token (whitespace/end-delimited, fold-compared) it is returned
 * unchanged. Otherwise a single ` #tag` is appended with one separating space
 * (or none if the body is empty / already ends in whitespace). Pure.
 */
export function appendInlineTag(body: string, newTag: string): string {
  const cleaned = cleanAcceptedTag(newTag);
  if (cleaned.length === 0) return body;
  const key = foldSegment(cleaned);

  // Already present as an inline `#tag` token? (delimited by start/whitespace on
  // the left and whitespace/end on the right — the same shape the lezer tagger
  // recognizes, fold-compared.)
  const tokenRe = /(^|\s)#([\p{L}\p{N}/_-]+)/gu;
  for (const m of body.matchAll(tokenRe)) {
    if (foldSegment(m[2]) === key) return body;
  }

  const sep = body.length === 0 || /\s$/u.test(body) ? "" : " ";
  return `${body}${sep}#${cleaned}`;
}
