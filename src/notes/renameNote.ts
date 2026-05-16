// `renameNote` — mirror-existing source-of-truth (β) rename action.
//
// Per `decisions.md` 2026-05-15 "Note title write target: mirror-
// existing source-of-truth (β)": the rename action writes to whichever
// slot the title was already read from (Q2 read precedence chain
// `frontmatter.title` ↳ first body `# H1` ↳ None). The decision tree:
//
//   1. If FM `title:` exists → `patchTitleField(bytes, newTitle)`.
//   2. Else if body `# H1` exists → `patchFirstH1Line(bytes, newTitle)`.
//   3. Else (neither present)  → `patchTitleField(bytes, newTitle)`
//      (state-A FM inject — new-note default).
//   4. Both-exist edge → FM update (preserves Q2 precedence; body H1
//      stays static).
//
// After title surgery, `patchUpdatedField` always refreshes `updated:`
// because rename is a modification.
//
// Caller responsibilities (Q14 / Q21 in the implementation tasks):
// - Trim whitespace from the new title before invocation.
// - Reject empty / whitespace-only titles before invocation (no-op rename).
// - Strip embedded newlines before invocation (surgery defensively
//   strips them too, but the UI is the canonical sanitizer).

import {
  parse,
  patchFirstH1Line,
  patchTitleField,
  patchUpdatedField,
} from "../dialect";
import { noteUpdate } from "./updateNote";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Detect whether a body line beginning with `^# ` exists outside the
 * frontmatter block. Mirrors the Rust extractor's CommonMark-strict
 * shape (the FM-byte-range exclusion comes from `parse()`'s
 * `filterOutsideFrontmatter` post-processing).
 */
function hasFirstH1(bytes: Uint8Array): boolean {
  const result = parse(bytes);
  return result.headings.some((h) => h.level === 1);
}

/**
 * Rename a note by writing the new title to whichever source-of-truth
 * slot was originally serving the sidebar's title display. Composes
 * `patchUpdatedField` after the title surgery (rename is a modification
 * → `updated:` must advance).
 *
 * Rejects with whatever `noteUpdate` propagates (typically a
 * `NoteUpdateError` shape on IPC failure).
 */
export async function renameNote(
  noteId: string,
  currentBytes: string,
  newTitle: string,
): Promise<void> {
  const input = encoder.encode(currentBytes);
  const parsed = parse(input);
  const fmHasTitle =
    parsed.frontmatter.parsed !== null &&
    typeof parsed.frontmatter.parsed["title"] === "string";

  let renamed: Uint8Array;
  if (fmHasTitle) {
    // Path 1 + both-exist edge: write to FM `title:` (state-C replace).
    renamed = patchTitleField(input, newTitle);
  } else if (hasFirstH1(input)) {
    // Path 2: write to body's first `# H1` line in place.
    renamed = patchFirstH1Line(input, newTitle);
  } else {
    // Path 3: neither slot exists; inject FM `title:` (state-A).
    renamed = patchTitleField(input, newTitle);
  }

  const stamped = patchUpdatedField(renamed, new Date().toISOString());
  await noteUpdate(noteId, decoder.decode(stamped));
}
