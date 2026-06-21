// `capture_kind` discriminator + the two-shape clip-input contract
// (capture-extraction sub-feature 2, task 8; browser-extension epic).
//
// Spec / ledger: SYNC-10 (the handoff envelope wire contract) + SYNC-11
// (canonicalization runs DESKTOP-side via `serializeClipMarkdown`). PRD
// stories 8, 9, 17.
//
// WHAT THIS SLICE PINS
// --------------------
// The extension hands the desktop ONE versioned envelope (SYNC-10), owned by
// sub-feature 1. Two capture shapes ride that envelope, discriminated by
// `capture_kind`:
//   - a FULL clip (`full-article`)  → the whole readable-article markdown;
//   - a HIGHLIGHT clip (`selection`) → only the selected range's markdown.
// Plus a content-light `bookmark` (SYNC-16). The downstream canonicalizer —
// `serializeClipMarkdown` — is IDENTICAL for every kind: this module routes
// ALL shapes through that ONE code path. `capture_kind` is a discriminator the
// CALLER (ingest, sub-feature 3) reads to compose frontmatter / pick copy; the
// serializer itself never branches on it. The point of this slice is exactly
// that single-path guarantee plus pinning HOW a highlight body reaches the
// serializer (as its own complete best-effort document, never a fragment).
//
// CONSUME, DON'T REDEFINE (sub-feature 1's envelope)
// --------------------------------------------------
// The envelope shape is owned by sub-feature 1
// (`src-tauri/src/clipper/envelope.rs` — the Rust `HandoffEnvelope` /
// `CaptureKind`; mirrored extension-side in `myne-clipper/src/content/capture.ts`
// + `myne-clipper/src/background/clip.ts`). This module MIRRORS, never
// re-invents, the serialization-relevant subset of those fields:
//
//   envelope (snake_case, wire)   →  ClipInput (camelCase, this contract)
//   ───────────────────────────────────────────────────────────────────
//   capture_kind                  →  captureKind   (the discriminator)
//   markdown_body                 →  markdownBody  (the body the serializer sees)
//   source_url                    →  sourceUrl     (provenance — carried, NOT emitted)
//   clip_date                     →  clipDate      (provenance — carried, NOT emitted)
//
// `destination_folder`, `tags[]`, and `image_bytes[]` are envelope fields
// owned by other slices (destination is SYNC-15 root/null; images are task 9 /
// sub-feature 3) and are NOT part of THIS serialization contract.
//
// PROVENANCE IS CARRIED, NOT EMITTED
// ----------------------------------
// `sourceUrl` + `clipDate` ride the input so a highlight clip carries the same
// provenance a full clip does (story 9), but this slice emits NEITHER as body
// nor frontmatter — sub-feature 3 composes the provenance frontmatter
// (`source:` / `clipped:`, SYNC-14) on ingest. `serializeClip` returns the
// canonical-D1 body in its `ok` outcome (or a `no-content` outcome, task 10);
// the provenance fields are along for the ride, never emitted.

import { serializeClipMarkdown } from "../clip";

/**
 * How a clip was captured — the `capture_kind` discriminator (SYNC-10).
 *
 * The exact kebab-case literal set sub-feature 1 defines: the Rust
 * `CaptureKind` (`envelope.rs`, `#[serde(rename_all = "kebab-case")]` →
 * `FullArticle` / `Selection` / `Bookmark`) and the extension's `CaptureKind`
 * (`capture.ts` / `clip.ts`) mirror these verbatim. This type CONSUMES that
 * set; it does not redefine it.
 *
 *   - `"full-article"` — a full clip (the whole readable article; stories 1/8).
 *   - `"selection"`    — a highlight clip (only the selected range; story 8).
 *   - `"bookmark"`     — a content-light URL bookmark (SYNC-16).
 */
export type CaptureKind = "full-article" | "selection" | "bookmark";

/**
 * The runtime view of the {@link CaptureKind} closed set, in the SAME order the
 * Rust enum + the extension mirror declare it. A coverage / contract test
 * asserts this equals the wire literal set, so a drift from sub-feature 1's
 * `capture_kind` values fails loudly rather than silently forking the contract.
 */
export const CAPTURE_KINDS = [
  "full-article",
  "selection",
  "bookmark",
] as const satisfies readonly CaptureKind[];

/**
 * The structured outcome of serializing a clip — a discriminated union the
 * caller (sub-feature 4's popup, sub-feature 3's ingest) switches on, NOT a bare
 * string (task 10).
 *
 *   - `{ kind: "ok"; markdown }`  — there IS extractable content; `markdown` is
 *     the canonical-D1 body to ingest. By construction the body is non-empty and
 *     not whitespace-only (a valid short clip — even one word — is `ok`).
 *   - `{ kind: "no-content" }`    — empty / whitespace-only input, OR a body the
 *     serializer re-emits to nothing (e.g. a body that is only a `%%comment%%`,
 *     §6-dropped). There is NO `markdown` field: the serializer fabricates no
 *     note from nothing. The popup renders its "nothing to clip here" message.
 *
 * WHY A SEPARATE NO-CONTENT ARM (not an empty `ok`, not a throw). An empty-string
 * `ok` would let ingest fabricate a blank/garbage note (the exact failure this
 * slice prevents); a throw would force every caller into a try/catch and is not
 * the shape the popup can `switch` on. The discriminant makes "nothing to clip"
 * a first-class, detectable outcome — DISTINCT from a valid-but-short clip, which
 * is `ok` with its (short) body.
 *
 * BOUNDARY ALIGNMENT (the extension's `nothing_to_clip`). This is the desktop
 * SERIALIZER-side analogue of the extension's capture-side
 * `{ status: "error"; reason: "nothing_to_clip" }`
 * (`myne-clipper/src/background/clip.ts` — returned when `captureActiveTab()`
 * finds nothing). Both feed the popup's "nothing was saved" body
 * (`myne-clipper/src/popup/copy.ts`, sub-feature 4): the extension signals it
 * when the in-page capture yields nothing; THIS signals it when a body did reach
 * the desktop but carries no extractable content. The exact wording + lock/
 * unlocked gating are sub-feature 4's UX — this slice only makes the outcome
 * detectable + propagated.
 */
export type ClipSerializeResult =
  | { readonly kind: "ok"; readonly markdown: string }
  | { readonly kind: "no-content" };

/**
 * The typed clip-input contract the desktop serializer consumes — the
 * serialization-relevant projection of sub-feature 1's handoff envelope.
 *
 * It mirrors the envelope's field NAMES + VALUES (camelCase here, matching the
 * extension's `CapturedClip`); it is NOT a second definition of the envelope.
 * The provenance fields (`sourceUrl` / `clipDate`) are typed so a highlight
 * clip provably carries the same provenance a full clip does — but they are
 * carried, never emitted (sub-feature 3 owns frontmatter).
 */
export interface ClipInput {
  /** The capture-shape discriminator (`full-article` vs `selection` vs `bookmark`). */
  readonly captureKind: CaptureKind;
  /**
   * The best-effort markdown the extension handed off. For a `full-article`
   * clip this is the WHOLE article; for a `selection` clip it is ONLY the
   * selected range's markdown — already a complete best-effort document (the
   * in-page content script lifts the selection into its own markdown, story
   * 17), so the serializer canonicalizes it exactly as it would a full clip.
   */
  readonly markdownBody: string;
  /** Provenance: the source page URL. Carried through; NEVER emitted here. */
  readonly sourceUrl: string;
  /** Provenance: the ISO-8601 capture timestamp. Carried through; NEVER emitted here. */
  readonly clipDate: string;
}

/**
 * Serialize a clip's body to a STRUCTURED canonical-D1 outcome — the SINGLE code
 * path for BOTH capture shapes.
 *
 * A `full-article` clip and a `selection` (highlight) clip differ ONLY in which
 * markdown reached `markdownBody`: the whole article vs the selected range. The
 * canonicalization is identical — this function discriminates nothing on
 * `captureKind`, it just routes `input.markdownBody` through the one
 * `serializeClipMarkdown`. `captureKind` is a tag the caller (sub-feature 3
 * ingest) reads to compose provenance frontmatter / pick confirm copy; the
 * serializer never branches on it. A highlight body is therefore guaranteed to
 * be serialized as its OWN complete document (the selected-range markdown), not a
 * fragment that mis-parses, because it passes through the exact round-trip-stable
 * canonical emit a full clip does.
 *
 * NO-CONTENT (task 10). The return is a {@link ClipSerializeResult} discriminated
 * union, NOT a bare string. An empty / whitespace-only body — or a body that
 * re-emits to nothing (e.g. only a §6-dropped `%%comment%%`) — yields the
 * structured `{ kind: "no-content" }`, never a fabricated empty/garbage note and
 * never a propagated throw. The lower-level `serializeClipMarkdown` keeps its
 * throw-on-empty internal contract; THIS entry catches/pre-checks it and surfaces
 * the structured outcome the popup (sub-feature 4) can switch on. Any real
 * emitted content — even one short paragraph — is `{ kind: "ok"; markdown }`,
 * distinguishable from no-content by the discriminant.
 *
 * Provenance (`sourceUrl` / `clipDate`) rides `input` but is NOT emitted — this
 * slice returns the canonical body only; frontmatter is sub-feature 3's job.
 *
 * Pure + total: never throws (the no-content path replaces the throw).
 *
 * @param input the clip-input contract (the envelope's serialization subset)
 * @returns `{ kind: "ok"; markdown }` with the canonical body, or
 *   `{ kind: "no-content" }` when there is nothing extractable
 */
export function serializeClip(input: ClipInput): ClipSerializeResult {
  // ONE path for every kind. `captureKind` is intentionally NOT read here — the
  // body already IS whatever the kind selected (whole article / selected range
  // / bookmark line). Provenance is carried on `input`, not emitted.
  //
  // Pre-check the cheap empty/whitespace cases (the same condition the byte
  // emitter throws on) so the common no-content path never relies on a throw.
  if (input.markdownBody.trim().length === 0) {
    return { kind: "no-content" };
  }

  // The body has non-whitespace bytes, but the canonical emit can still be empty
  // when every construct in it is a §6-DROP (e.g. a body that is only a
  // `%%comment%%`). Guard both: a defensive catch for the byte emitter's throw
  // contract, then a post-emit emptiness check — so the serializer NEVER
  // surfaces an `ok` with an empty/whitespace body (it fabricates no note).
  let markdown: string;
  try {
    markdown = serializeClipMarkdown(input.markdownBody);
  } catch {
    return { kind: "no-content" };
  }
  if (markdown.trim().length === 0) {
    return { kind: "no-content" };
  }
  return { kind: "ok", markdown };
}
