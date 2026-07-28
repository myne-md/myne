// Platform seam — delivering a file to the user without a filesystem path
// (phase3-web-client task 48).
//
// # Why this is not `dialog.save` with a different name
//
// `dialog.save` answers "where should I write this?" and yields a PATH. The
// whole export suite is built on that answer: the host opens the dialog, the
// frontend hands the chosen path to a Rust command, and Rust writes the bytes —
// which is why the plaintext never round-trips through the WebView on desktop.
//
// A browser cannot answer that question. No API grants a page an arbitrary write
// path (`nativeSaveAs` is in the web descriptor's ABSENT set for exactly this),
// and the download flow is not a path with extra steps: it is a differently
// shaped affordance where the USER's browser owns the destination and the page
// only supplies bytes and a suggested name.
//
// So the two are separate seam members rather than one, and the export flows ask
// which they have: `has("nativeSaveAs")` picks the path flow, its absence picks
// this one. That keeps both arms honest — neither pretends to be the other.
//
// # TB3 is preserved, and it is worth saying how
//
// `threat-model.md` TB3 makes export the deliberate plaintext-egress exception,
// and its two properties are USER-INITIATED and ONE-SHOT. Both survive here:
//
//   - user-initiated — this is only ever reached from an export action the user
//     clicked, and the browser's own download UI is the second confirmation. The
//     page cannot call this without a gesture in the chain and cannot write
//     anywhere the user did not accept.
//   - one-shot — one call delivers one file and keeps nothing. The object URL is
//     revoked immediately (see the web arm), so there is no handle left that
//     could deliver a second time or leave plaintext resident.
//
// What would break TB3 is a background or batched egress path. There is none:
// this takes bytes it is given and forgets them.

import { unsupported } from "./unsupported";

/**
 * Deliver `bytes` to the user as a file named `suggestedName`.
 *
 * **Desktop: refuses, and that is correct rather than missing.** This platform
 * has the better affordance — a native Save-As that names a real path, lets the
 * OS own the overwrite prompt, and keeps the plaintext in Rust instead of
 * routing it through the WebView. Offering a second, weaker delivery mechanism
 * beside it would be two ways to do one thing, and the weaker one would leak
 * plaintext into V8 for no gain.
 *
 * Callers pick by capability (`has("nativeSaveAs")`), so this is unreachable on
 * desktop in the normal flow; the typed refusal is the belt for a path that
 * gating did not cover.
 */
export async function deliverFile(
  _suggestedName: string,
  _bytes: Uint8Array,
  _mimeType: string,
): Promise<void> {
  return unsupported("download.deliverFile");
}
