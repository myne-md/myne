// desktop-ingest task 2 — provenance frontmatter composition (MYND-445,
// browser-extension epic, sub-feature `desktop-ingest`).
//
// WHAT THIS IS
// ------------
// The PURE composer that turns a validated clip envelope (task 1's
// `ValidatedClipEnvelope`) plus a (possibly empty) markdown body into the
// PLAINTEXT of a new ROOT note ready to hand to `note_create`. It prepends
// provenance frontmatter — `source:` / `url:` / `clipped:` (SYNC-14) — onto the
// body, escaping the values as YAML scalars and preserving any frontmatter the
// clipped body already carries.
//
// SYNC-14 — PROVENANCE IS UNMANAGED, ORDINARY FRONTMATTER
// ------------------------------------------------------
// `source:` / `url:` / `clipped:` are ORDINARY user-authored frontmatter, NOT
// new Myne-managed canonical fields. The closed 7-field managed set
// (`updated:` / `title:` / `folder:` / `trashed:` / `template:` /
// `folder_index:` / `archived:`; markdown-dialect §3.6.1) is NOT extended. So
// these keys go through the GENERIC arbitrary-frontmatter surgery path
// (`patchFrontmatterField`) — the exact same injector `setNoteCover` uses for
// the (also unmanaged) cover-image property — never a managed-field setter and
// never any managed-field enum/registry. That path's §3.6
// unknown-field-preservation guarantee is why a pre-existing user-authored key
// in the clipped body is preserved untouched: editing/re-saving a clip never
// strips its provenance.
//
// SYNC-15 — ROOT-ONLY
// -------------------
// A clip lands at the vault ROOT. The composer builds onto
// `buildInitialPlaintext(null)` (=== `""`, no `folder:` line) — the host never
// sources vault structure. The validated envelope carries no
// `destinationFolder`, so there is nothing to fold into anyway.
//
// THE THREE KEYS (SYNC-14, literal)
// ---------------------------------
// The envelope carries ONE `sourceUrl` and ONE normalized RFC-3339 `clipDate`.
//   - `source:`  = sourceUrl
//   - `url:`     = sourceUrl   (deliberately the SAME value as `source:`)
//   - `clipped:` = clipDate
// Emitting `source:` AND `url:` both from `sourceUrl` is the literal SYNC-14
// three-key decision (a ratified redundancy) — the composer follows the ledger
// and never drops a key.
//
// content_type: the composed plaintext is plain markdown — no HTML snapshot —
// so the note's effective content_type stays `text/markdown`. The `clipped:`
// timestamp rides inside this (later AEAD-encrypted) plaintext; the note's
// `created_at` derives from the UUIDv7 filename `note_create` mints, NOT from
// this frontmatter.
//
// PURE: no React, no IPC, no I/O. `(envelope, body) -> string`. Fully
// unit-testable.

import { buildInitialPlaintext, patchFrontmatterField } from "../dialect";
import type { ValidatedClipEnvelope } from "./validateClipEnvelope";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/**
 * Compose the plaintext of a new ROOT clip note: the given `body` with the
 * envelope's provenance (`source:` / `url:` / `clipped:`) prepended as ordinary,
 * unmanaged frontmatter.
 *
 * `body` is taken as a SEPARATE parameter (rather than read from
 * `envelope.markdownBody`) because a later ingest step (image-embed splicing)
 * rewrites the body before composition — pass the body you want in the note.
 * When no rewrite has happened, pass `envelope.markdownBody`.
 *
 * Each provenance key is written via {@link patchFrontmatterField}, the generic
 * arbitrary-frontmatter injector — which YAML-scalar-escapes the value
 * (via `formatYamlScalar`), merges into any frontmatter the body already has
 * (preserving every existing key, §3.6), and never touches the closed
 * Myne-managed canonical field set.
 *
 * @param envelope the validated clip envelope (task 1) carrying `sourceUrl` +
 *   normalized RFC-3339 `clipDate`
 * @param body the markdown body to compose onto (root note; may be empty)
 * @returns the composed note plaintext, ready for `note_create`
 */
export function composeClipPlaintext(
  envelope: ValidatedClipEnvelope,
  body: string,
): string {
  // Start from the ROOT base (SYNC-15): an empty string for `body === ""`, or
  // the supplied body. `buildInitialPlaintext(null) === ""`, so prepending it
  // is a no-op that documents the root-only intent at the call site.
  const base = buildInitialPlaintext(null) + body;

  // Inject the three provenance keys through the GENERIC arbitrary-frontmatter
  // path — the same `patchFrontmatterField` injector `setNoteCover` uses for an
  // unmanaged property. Each call merges into the existing frontmatter (or
  // creates the block on the first call), preserving any user-authored keys the
  // clipped body already carried. `source:` and `url:` both carry `sourceUrl`
  // by the literal SYNC-14 decision. Chained into `const`s (rather than a
  // reassigned `let`) so the narrowed `Uint8Array` buffer type round-trips
  // cleanly through each surgery call.
  const withSource = patchFrontmatterField(
    utf8Encoder.encode(base),
    "source",
    envelope.sourceUrl,
  );
  const withUrl = patchFrontmatterField(withSource, "url", envelope.sourceUrl);
  const withClipped = patchFrontmatterField(
    withUrl,
    "clipped",
    envelope.clipDate,
  );

  return utf8Decoder.decode(withClipped);
}
