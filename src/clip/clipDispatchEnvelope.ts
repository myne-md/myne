// desktop-ingest task 6 — the inbound-dispatch → `RawClipEnvelope` mapping
// (MYND-442/MYND-445, browser-extension epic, sub-feature `desktop-ingest`).
//
// WHAT THIS IS
// ------------
// The pure adapter from the wire-shaped `clipper://dispatch` event payload (what
// the Rust relay emits AFTER it re-validates the ext→host frame) to the
// `RawClipEnvelope` `assembleClip` consumes. Extracted as a standalone pure
// function so the round-trip's load-bearing logic — the byte→`Uint8Array` lift
// and the per-image filename synthesis — is unit-testable WITHOUT mounting React
// or the Tauri event channel.
//
// THE FILENAME-SYNTHESIS GAP (resolved: WebView-synthesized for v1)
// ----------------------------------------------------------------
// The Rust dispatch envelope carries `imageBytes` as bytes-ONLY (an array of
// byte-arrays) — it does NOT carry a per-image filename. The desktop boundary
// gate (`validateClipEnvelope`) and the form-C embed alias both want a display
// `filename`, so we SYNTHESIZE one here: `clipped-image-${i + 1}`. This is
// display-only — the attachment store content-addresses by hex id and re-sniffs
// the real MIME from the bytes, so the synthesized name never steers an on-disk
// write nor the stored content type. It only ever shows up as the form-C alias
// (`![[att:<id>|clipped-image-1]]`). This is the v1 resolution of the
// long-standing Rust↔TS per-image-filename gap: filenames are WebView-side.
//
// PURE + TOTAL: a `ClipDispatchPayload` in → a `RawClipEnvelope` out. No React,
// no IPC, no I/O. The envelope is still RAW/hostile — `assembleClip` validates
// it at its own boundary gate; this adapter does NO validation.

import type { RawClipEnvelope } from "./validateClipEnvelope";

/**
 * The `clipper://dispatch` event payload — the wire shape the Rust relay emits
 * after re-validating the ext→host frame (CONTRACT verbatim; do not deviate).
 *
 *   - `requestId`    — correlates the eventual `clip_dispatch_complete` reply.
 *   - `markdownBody` — the clip markdown (the caller-supplied body for assembly).
 *   - `captureKind`  — the claimed capture shape (validated downstream).
 *   - `sourceUrl`    — provenance source URL; `""` when absent.
 *   - `clipDate`     — capture timestamp; `""` when absent.
 *   - `imageBytes`   — an array of byte-arrays (bytes only, NO per-image
 *     filename — the gap this module's synthesis resolves).
 */
export interface ClipDispatchPayload {
  readonly requestId: string;
  readonly markdownBody: string;
  readonly captureKind: string;
  readonly sourceUrl: string;
  readonly clipDate: string;
  readonly imageBytes: readonly number[][];
}

/**
 * Synthesize a display-only filename for the i-th dispatched image. The Rust
 * envelope carries no per-image name; this is the WebView-side v1 fill-in. The
 * 1-based index matches how a user counts images ("clipped-image-1").
 *
 * Display-only: the attachment store re-sniffs the real MIME and addresses by
 * hex id, so this name never reaches an on-disk path nor the content type.
 */
export function synthName(index: number): string {
  return `clipped-image-${index + 1}`;
}

/**
 * Build the RAW (un-validated, hostile) {@link RawClipEnvelope} from a
 * {@link ClipDispatchPayload}. Lifts each wire byte-array to a `Uint8Array` and
 * attaches a {@link synthName}'d display filename; carries `captureKind` /
 * `sourceUrl` / `clipDate` verbatim (the boundary gate validates them).
 *
 * Note `markdownBody` rides on the envelope (so the validation/encoding gate
 * sees it), AND is separately passed to `assembleClip` as the caller-supplied
 * body parameter — both are the same `payload.markdownBody`.
 *
 * Pure: no validation, no I/O — `assembleClip` owns the boundary gate.
 *
 * @param payload the inbound `clipper://dispatch` event payload
 * @returns the raw clip envelope ready to hand to `assembleClip`
 */
export function buildRawEnvelopeFromDispatch(
  payload: ClipDispatchPayload,
): RawClipEnvelope {
  return {
    markdownBody: payload.markdownBody,
    captureKind: payload.captureKind,
    sourceUrl: payload.sourceUrl,
    clipDate: payload.clipDate,
    imageBytes: payload.imageBytes.map((bytes, i) => ({
      filename: synthName(i),
      bytes: Uint8Array.from(bytes),
    })),
  };
}
