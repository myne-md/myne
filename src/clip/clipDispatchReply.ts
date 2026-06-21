// desktop-ingest task 6 — the pure host-reply mapping
// (MYND-442/MYND-445, browser-extension epic, sub-feature `desktop-ingest`).
//
// WHAT THIS IS
// ------------
// The single, pure projection from the rich {@link ClipIngestResult} (what
// `assembleClip` returns) down to the TINY outcome string the WebView replies
// to the Rust relay with: `"accepted" | "locked" | "error"`. The relay forwarded
// a re-validated dispatch envelope; the WebView assembled + sealed the clip;
// this maps the result to the no-leak reply the relay closes the round-trip on.
//
// THE TINY-REPLY / NO-LEAK RULE
// -----------------------------
// ONLY the outcome string crosses back over the `clip_dispatch_complete`
// command. The note id and the media counts are deliberately DROPPED here — they
// stay WebView-local (for the in-app toast). The browser extension never learns
// the sealed note's id or how many images landed; the reply is a one-word ack of
// shape, nothing more. That is why this mapper returns a bare string union and
// never an object: there is no field for a leak to ride out on.
//
// PURE + TOTAL: a `ClipIngestResult` in → one of three string literals out. No
// React, no IPC, no I/O. Fully unit-tested (all three arms).

import type { ClipIngestResult } from "./assembleClip";

/**
 * The closed set of host-reply outcomes the Rust relay's `clip_dispatch_complete`
 * command accepts (the CONTRACT verbatim — `accepted | locked | error`). The
 * WebView sends ONLY this string; never the note id, never the media counts.
 */
export type ClipDispatchOutcome = "accepted" | "locked" | "error";

/**
 * Map a rich {@link ClipIngestResult} to its tiny host-reply outcome string.
 *
 *   - `{ kind: "accepted" }` → `"accepted"` (note id + counts are dropped here,
 *     kept WebView-local for the toast — the no-leak rule).
 *   - `{ kind: "locked" }`   → `"locked"`.
 *   - `{ kind: "error" }`    → `"error"` (the `reason` is dropped — the relay
 *     gets shape only, not the rejection detail).
 *
 * Pure + total: every arm of the closed union is covered, so the result is
 * always one of the three literals.
 *
 * @param result the assembly outcome from `assembleClip`
 * @returns the host-reply outcome string
 */
export function mapResultToOutcome(result: ClipIngestResult): ClipDispatchOutcome {
  switch (result.kind) {
    case "accepted":
      return "accepted";
    case "locked":
      return "locked";
    case "error":
      return "error";
  }
}
