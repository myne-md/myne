// desktop-ingest task 1 — handoff-envelope type + boundary validation gate
// (MYND-445, browser-extension epic, sub-feature `desktop-ingest`).
//
// WHAT THIS IS
// ------------
// The native-messaging host (sub-feature 1, Rust `src-tauri/src/clipper/`)
// decodes a versioned ext→host envelope and relays a clip handoff into
// desktop ingest. This module owns the desktop-side INGEST TYPE + the SINGLE
// pure validation gate that every later desktop-ingest task assumes ran: a
// validated `ValidatedClipEnvelope` is the only thing the rest of ingest sees.
//
// TRUST BOUNDARY (TB10 / A14) — every field is hostile
// ----------------------------------------------------
// The browser extension is untrusted: a compromised build skips its OWN
// pre-handoff validation, so the extension's checks are NOT the security line.
// THIS desktop gate is the enforcement point. Each field is re-validated here
// as crossing-the-boundary untrusted input — exactly the posture the Rust host
// takes (`src-tauri/src/clipper/validation.rs` + `envelope.rs` decode), and the
// app-side re-validation climax (`clipper/ingest.rs`). This TS layer is the
// in-WebView analogue for the desktop-ingest path.
//
// SCOPE — ROOT-ONLY (SYNC-15)
// ---------------------------
// The ingest envelope is the ROOT-ONLY subset the host hands into ingest:
// `{ markdownBody, captureKind, sourceUrl, clipDate, imageBytes[] }`. It carries
// NO `destinationFolder` / `tags[]` — under SYNC-15 a clip lands at the vault
// root and the host NEVER sources vault structure. The transport-only fields
// (`version` / `kind` / `extensionId` / `token`) are the host/Rust side's
// concern (already gated by `clipper/envelope.rs` + `clipper/token.rs`) and are
// intentionally absent here.
//
// WHAT THIS GATE ENFORCES (the four boundary rules)
// -------------------------------------------------
//   1. PATH TRAVERSAL — each per-image `filename` is a single, harmless path
//      component. Defense-in-depth: the attachment store content-addresses by
//      hex id so the filename is display-only, but a `..` / separator /
//      absolute-root / drive-prefix / NUL / bare-dot name is rejected anyway so
//      a malicious extension can never influence an on-disk name. Mirrors the
//      Rust `validate_no_path_traversal` rule-for-rule.
//   2. UTF-8 WELL-FORMEDNESS — `markdownBody` reaches TS as a `string` (it is a
//      Rust `String` = valid UTF-8 by the time it is a Rust String, but the
//      desktop gate re-validates as the enforcement point). A JS string can
//      still hold a LONE SURROGATE (not well-formed Unicode, no UTF-8 encoding);
//      that is the not-well-formed case and is rejected as an
//      `InvalidPlaintextEncoding`-class boundary error — NEVER silently
//      U+FFFD-substituted into a corrupting pass-through.
//   3. CAPTURE KIND — must be one of the closed `CaptureKind` set sub-feature 1
//      defines (`full-article | selection | bookmark`). An unrecognized value is
//      rejected; this module CONSUMES that set (`dialect/clip/captureKind`), it
//      does not redefine it.
//   4. CLIP DATE — normalized to an RFC 3339 string for the provenance
//      frontmatter (`clipped:`, SYNC-14, composed downstream). A malformed
//      value is rejected.
//
// PURE + TOTAL: no React, no IPC, no I/O. A `RawClipEnvelope` in → a typed
// discriminated-union result out. Never throws on hostile input — every failure
// is a typed `ClipEnvelopeRejection`. Fully unit-testable.

import {
  CAPTURE_KINDS,
  type CaptureKind,
} from "../dialect/clip/captureKind";

/**
 * One in-page-captured image as it reaches the desktop-ingest boundary — the
 * per-image `{ filename, bytes }` shape sub-feature 3 introduces over the
 * foundation's bare-bytes wire field.
 *
 * `filename` is a HOSTILE display-only hint from the browser; `bytes` are the
 * raw captured image bytes (the in-page-captured bytes, SYNC-12 — zero
 * core-side fetch). The boundary validates `filename` for path-traversal; the
 * bytes themselves are sub-feature 3's later re-sniff/import seam.
 */
export interface RawClipImage {
  /** The browser-supplied display name. Hostile; path-traversal-checked. */
  readonly filename: string;
  /** The raw in-page-captured image bytes. */
  readonly bytes: Uint8Array;
}

/**
 * The RAW (un-validated) desktop-ingest envelope — the hostile input shape the
 * host relays into ingest. Mirrors the Rust `HandoffEnvelope`'s ingest subset
 * (root-only, SYNC-15) with camelCase field names matching the rest of the
 * desktop clip layer (`dialect/clip/captureKind.ts`'s `ClipInput`).
 *
 * NOTE the types are deliberately PERMISSIVE where the boundary does the work:
 * `captureKind` is a bare `string` (validated against the closed set) and
 * `clipDate` is a bare `string` (validated + normalized) — the boundary refuses
 * to trust the wire's claim that they are already well-shaped.
 */
export interface RawClipEnvelope {
  /** The clip's markdown body. Re-validated for UTF-8 well-formedness. */
  readonly markdownBody: string;
  /** The claimed capture shape — validated against the closed `CaptureKind` set. */
  readonly captureKind: string;
  /** Provenance: the source page URL (carried verbatim; never dereferenced). */
  readonly sourceUrl: string;
  /** Provenance: the capture timestamp — validated + normalized to RFC 3339. */
  readonly clipDate: string;
  /** In-page-captured images; each `filename` is path-traversal-checked. */
  readonly imageBytes: readonly RawClipImage[];
}

/**
 * The VALIDATED desktop-ingest envelope — the only clip shape the rest of
 * desktop ingest ever sees. Produced solely by {@link validateClipEnvelope}'s
 * `ok` arm: every field has passed the boundary.
 *
 *   - `captureKind` is narrowed to the closed {@link CaptureKind} union;
 *   - `clipDate` is the normalized RFC 3339 string (NOT the raw wire value);
 *   - `markdownBody` is well-formed UTF-8;
 *   - every `imageBytes[].filename` is a harmless single path component.
 *
 * It carries NO `destinationFolder` / `tags` (SYNC-15 root-only) — the absence
 * is the contract.
 */
export interface ValidatedClipEnvelope {
  readonly markdownBody: string;
  readonly captureKind: CaptureKind;
  readonly sourceUrl: string;
  /** RFC 3339 normalized timestamp (canonical UTC `...Z` form). */
  readonly clipDate: string;
  readonly imageBytes: readonly RawClipImage[];
}

/**
 * The closed taxonomy of boundary-rejection reasons — a typed enum (string
 * literal union), the discriminant of {@link ClipEnvelopeResult}'s `err` arm.
 *
 * Each value names a single boundary rule that failed, WITHOUT carrying the
 * offending bytes (the rejected name / body / date is untrusted and
 * potentially secret-bearing — same discipline as the Rust
 * `ValidationError::label` and the `Secret-handling logging discipline`).
 *
 *   - `"PathTraversal"`            — a per-image `filename` could steer an
 *     on-disk write (`..`, separator, absolute root, drive prefix, NUL, empty,
 *     bare dot). Mirrors Rust `ValidationError::PathTraversal`.
 *   - `"InvalidPlaintextEncoding"` — `markdownBody` is not well-formed UTF-8
 *     (a lone surrogate). Mirrors the codebase's
 *     `NoteReadError::InvalidPlaintextEncoding` class (the post-AEAD UTF-8
 *     boundary) — a structural-corruption / foreign-writer rejection, NOT a
 *     corrupting write.
 *   - `"UnrecognizedCaptureKind"`  — `captureKind` is outside the closed
 *     {@link CaptureKind} set.
 *   - `"MalformedClipDate"`        — `clipDate` did not parse to a valid
 *     instant.
 */
export type ClipEnvelopeRejection =
  | "PathTraversal"
  | "InvalidPlaintextEncoding"
  | "UnrecognizedCaptureKind"
  | "MalformedClipDate";

/**
 * The structured result of the boundary gate — a discriminated union matching
 * the codebase's result-type idiom (`{ kind: "ok" } | { kind: "err" }`, e.g.
 * `dialect/clip/captureKind.ts`'s `ClipSerializeResult`). The caller switches
 * on `kind`; there is NO `envelope` field on the `err` arm, so a rejected clip
 * can never be mistaken for a (partially-)validated one.
 */
export type ClipEnvelopeResult =
  | { readonly kind: "ok"; readonly envelope: ValidatedClipEnvelope }
  | { readonly kind: "err"; readonly reason: ClipEnvelopeRejection };

/**
 * Reject a hostile per-image filename that could steer a write outside the
 * vault — the TS mirror of Rust `validate_no_path_traversal`
 * (`src-tauri/src/clipper/validation.rs`), rule-for-rule.
 *
 * Returns `true` when the name is a harmless single path component, `false`
 * when it carries ANY of: an empty / bare-dot component, a `..` token
 * anywhere, a `/` or `\` separator, a NUL byte, or a Windows drive prefix
 * (`C:…`). Defense-in-depth: the attachment store content-addresses by hex id,
 * so the filename is display-only — but the boundary rejects it anyway.
 */
function isSafeFilename(name: string): boolean {
  // Empty or a bare dot component carries no usable name.
  if (name === "" || name === "." || name === "..") {
    return false;
  }
  // The parent-directory token anywhere — `..`, `a/../b`, `..\x`, etc.
  if (name.includes("..")) {
    return false;
  }
  // A name is a single path component: NO separators of either dialect.
  if (name.includes("/") || name.includes("\\")) {
    return false;
  }
  // NUL — a classic path-truncation / string-splitting trick.
  if (name.includes("\0")) {
    return false;
  }
  // A Windows drive prefix (`C:`, `c:relative`, `Z:\abs`) — even without a
  // separator, `C:foo` resolves against the drive's current directory.
  if (
    name.length >= 2 &&
    name[1] === ":" &&
    /^[A-Za-z]$/.test(name[0])
  ) {
    return false;
  }
  return true;
}

/**
 * Test whether a JS string is well-formed Unicode (no LONE surrogate).
 *
 * `markdownBody` arrives as a JS string (a Rust `String` over the relay, so it
 * was valid UTF-8 on the Rust side) — but a JS string is UTF-16 and can still
 * hold an unpaired surrogate (U+D800–U+DFFF not in a valid high+low pair),
 * which has NO UTF-8 encoding and is therefore not well-formed. That is the
 * not-well-formed case this boundary refuses, surfaced as the
 * `InvalidPlaintextEncoding` class — never silently substituted with U+FFFD.
 *
 * Uses `String.prototype.isWellFormed` when present (ES2024); otherwise scans
 * for an unpaired surrogate directly so the gate works regardless of the
 * runtime's lib level.
 */
function isWellFormedUnicode(s: string): boolean {
  const withIsWellFormed = s as string & {
    isWellFormed?: () => boolean;
  };
  if (typeof withIsWellFormed.isWellFormed === "function") {
    return withIsWellFormed.isWellFormed();
  }
  // Manual scan: a high surrogate (D800–DBFF) MUST be immediately followed by
  // a low surrogate (DC00–DFFF), and a low surrogate must never appear alone.
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate — require a trailing low surrogate.
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      i++; // consume the paired low surrogate
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // Lone low surrogate (a high surrogate would have consumed its pair).
      return false;
    }
  }
  return true;
}

/**
 * Normalize a wire `clipDate` to a canonical RFC 3339 string, or `null` if it
 * does not parse to a valid instant.
 *
 * The provenance frontmatter (`clipped:`, SYNC-14) wants one canonical RFC 3339
 * form regardless of how the extension formatted the wire value (with or
 * without an offset, with or without sub-second digits). We parse to an instant
 * and re-emit the canonical UTC `YYYY-MM-DDTHH:mm:ss.sssZ` form (`toISOString`,
 * an RFC 3339 profile of ISO 8601). A value that does not parse (`NaN` instant)
 * yields `null` so the caller can reject it.
 */
function normalizeClipDate(raw: string): string | null {
  // Reject early-empty before the more permissive `Date.parse` (which would
  // otherwise be implementation-defined for `""`).
  if (raw.trim() === "") {
    return null;
  }
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    return null;
  }
  return new Date(ms).toISOString();
}

/** Runtime narrowing of a bare string to the closed {@link CaptureKind} set. */
function isCaptureKind(value: string): value is CaptureKind {
  return (CAPTURE_KINDS as readonly string[]).includes(value);
}

/**
 * THE boundary gate — validate a raw, hostile {@link RawClipEnvelope} into a
 * {@link ValidatedClipEnvelope}, or a typed {@link ClipEnvelopeRejection}.
 *
 * This is the single ingress-validation chokepoint for desktop clip ingest:
 * every later desktop-ingest task assumes the envelope it receives passed here.
 * The order of checks is deliberate (each is independent; the first failure
 * short-circuits) — capture-kind, UTF-8, clip-date, then every image filename.
 *
 * Pure + total: never throws on hostile input. Returns
 * `{ kind: "ok", envelope }` only when ALL boundary rules pass; otherwise
 * `{ kind: "err", reason }` with NO partially-validated envelope leaking out.
 *
 * @param raw the hostile, un-validated envelope the host relayed into ingest
 * @returns the typed discriminated-union result
 */
export function validateClipEnvelope(raw: RawClipEnvelope): ClipEnvelopeResult {
  // 1. Capture kind must be one of the closed `CaptureKind` set.
  if (!isCaptureKind(raw.captureKind)) {
    return { kind: "err", reason: "UnrecognizedCaptureKind" };
  }
  const captureKind = raw.captureKind;

  // 2. markdownBody must be well-formed UTF-8 (no lone surrogate). Surfaced as
  //    the `InvalidPlaintextEncoding` class — NOT a corrupting U+FFFD write.
  if (!isWellFormedUnicode(raw.markdownBody)) {
    return { kind: "err", reason: "InvalidPlaintextEncoding" };
  }

  // 3. clipDate must parse to a valid instant; normalize to canonical RFC 3339.
  const clipDate = normalizeClipDate(raw.clipDate);
  if (clipDate === null) {
    return { kind: "err", reason: "MalformedClipDate" };
  }

  // 4. Every per-image filename must be a harmless single path component.
  for (const image of raw.imageBytes) {
    if (!isSafeFilename(image.filename)) {
      return { kind: "err", reason: "PathTraversal" };
    }
  }

  return {
    kind: "ok",
    envelope: {
      markdownBody: raw.markdownBody,
      captureKind,
      sourceUrl: raw.sourceUrl,
      clipDate,
      // Copy each image into a plain object so the validated envelope does not
      // alias the raw input's element identities.
      imageBytes: raw.imageBytes.map((image) => ({
        filename: image.filename,
        bytes: image.bytes,
      })),
    },
  };
}
