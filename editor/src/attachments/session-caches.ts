// Attachment session caches that hold DECRYPTED note content, and the resets
// the vault-leaving paths call on them.
//
// # Why they live here rather than beside their logic
//
// Two reasons, and the second one is the load-bearing half.
//
// The vault-leaving paths (`src/lib/vault-unlock.ts` `lockVault`,
// `src/lib/vault-switch.ts` `leaveActiveVault`) have to clear these, and
// `src/App.tsx` imports the first of those EAGERLY. So a teardown call reaching
// into `widgets.ts` or `transcript.ts` puts the whole attachment-widget subtree
// (pdf.js, the lightbox, the waveform, CodeMirror) into the app's eager bundle
// graph, where none of it belongs. That is not a hypothetical: it was measured
// at 42.7 KiB gzip on the web client's first load. This file imports nothing,
// so importing it costs nothing.
//
// And a `Map` declaration is not the logic. `widgets.ts` keeps its cache key,
// its LRU eviction and its in-flight de-dup; `transcript.ts` keeps its
// expander. Only the containers moved.
//
// # Why they are cleared at all
//
// `scripts/check-frontend-lock-teardown.mjs` states the guarantee these break:
// locking or switching a vault does not reload the WebView on desktop, so a
// module-scope store is still resident in the next session, INCLUDING the next
// vault's session. A JS module never unloads. `transcriptStore`'s own comment
// used to claim the opposite ("dropped when the module unloads (lock/quit tears
// down the editor)"), and that claim is why it stayed off the roster.
//
// What each holds is the user's own decrypted content: one is up to 24 file
// previews, each capped at the host's 2 MiB read cap, and the other is the text
// of completed voice-note transcriptions. `docs/threat-model.md` AS7 classes the
// transcript surface as AS1-class in-RAM plaintext whose exposure is "not
// widened" beyond A6/A7/A10. Carrying it into a DIFFERENT vault's session is
// wider than that, which is what makes this a correction rather than a polish.

// Type-only, so it is erased at build time and adds no runtime edge back to
// the heavy module this file exists to stay out of.
import type { PreviewCacheEntry, PreviewOutcome } from "./widgets";

/** Bounded preview cache, keyed by attachment id plus preview tier. Owned by
 *  `widgets.ts`, which holds the key derivation and the eviction. */
export const previewCache = new Map<string, PreviewCacheEntry>();

/** In-flight de-dup for the reads that fill {@link previewCache}. Holds
 *  promises rather than plaintext, and is cleared with it so a read in flight
 *  across a lock cannot resolve into the next session's cache. */
export const previewInFlight = new Map<string, Promise<PreviewOutcome>>();

/** Session cache of the last completed transcript per attachment id. Owned by
 *  `transcript.ts`. */
export const transcriptStore = new Map<string, string>();

/** Forget every cached attachment preview.
 *
 *  Called on both vault-leaving paths and asserted there by
 *  `scripts/check-frontend-lock-teardown.mjs`. The cost of clearing is one
 *  re-read per still-visible embed after a re-unlock. */
export function resetPreviewCache(): void {
  previewCache.clear();
  previewInFlight.clear();
}

/** Forget every cached voice-note transcript. Same two paths, same guard. */
export function resetTranscripts(): void {
  transcriptStore.clear();
}
