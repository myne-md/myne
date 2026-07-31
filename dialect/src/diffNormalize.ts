// Conflict-diff normalization (MYND-334) — the pre-pass that makes a conflict
// compare show the EDIT rather than the bookkeeping around it.
//
// Two devices that touched the same note always disagree on `updated:` (surgery
// rewrites it on every save), and the remote side additionally carries the
// keep-both markers `conflict:` / `conflict_of:` the engine injected
// (markdown-dialect.md §3.6.1; MYND-427). Diffed raw, every conflict opens on
// two-or-three changed frontmatter lines the user did not write and cannot act
// on — the real divergence is buried under managed noise.
//
// So the suppression set is exactly that managed/volatile trio and nothing else:
// a `title:`, `tags:`, `cover:` or prose divergence is the thing the user is here
// to decide about and must survive untouched. `updated:` is suppressed
// **value-strictly** via `readUpdatedFromFmBody` — a user's own `updated: soon`
// is an ordinary property (the §3.6.1 unprefixed-field collision footgun), not
// Myne's stamp, so a divergence on it is a real divergence.
//
// Pure and IO-free: it takes plaintext and returns plaintext. Nothing here
// touches the note on disk — normalization exists only to feed `./diff`.

import { clearConflictMarkers } from "./conflictCopy";
import { patchFrontmatterField, readUpdatedFromFmBody } from "./surgery";
import { locateFrontmatter } from "./lezer/frontmatter";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Prepare one note body for a conflict diff: strip the managed `conflict:` /
 * `conflict_of:` markers and drop a Myne-managed `updated:` stamp. Every other
 * byte — user frontmatter, unknown fields, comments, body — is preserved.
 * Idempotent; a note without frontmatter comes back unchanged.
 */
export function normalizeForDiff(content: string): string {
  const cleared = clearConflictMarkers(content);

  const fm = locateFrontmatter(cleared);
  if (fm === null) return cleared;

  // Value-strict: only Myne's own RFC 3339 stamp is volatile enough to hide.
  const fmBody = cleared.substring(fm.bodyStart, fm.bodyEnd);
  if (readUpdatedFromFmBody(fmBody) === null) return cleared;

  return decoder.decode(patchFrontmatterField(encoder.encode(cleared), "updated", null));
}

/** The two normalized sides of a conflict compare, ready for the diff core. */
export interface NormalizedConflictPair {
  /** The local original, normalized. */
  readonly mine: string;
  /** The remote conflict copy, normalized. */
  readonly theirs: string;
}

/**
 * Normalize both sides of a conflict compare. Applying the identical pass to
 * each side is what makes an `updated:`-only divergence collapse to an empty
 * diff instead of a one-line phantom change.
 */
export function normalizeConflictPair(mine: string, theirs: string): NormalizedConflictPair {
  return { mine: normalizeForDiff(mine), theirs: normalizeForDiff(theirs) };
}
