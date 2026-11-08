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
// of completed voice-note transcriptions. `myne-agents/docs/threat-model.md` AS7 classes the
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
 *  promises rather than plaintext. Clearing it does NOT stop a read already in
 *  flight from resolving; what stops it writing is {@link isCurrentGeneration},
 *  which the completion closure consults. */
export const previewInFlight = new Map<string, Promise<PreviewOutcome>>();

/** Session cache of the last completed transcript per attachment id. Owned by
 *  `transcript.ts`. */
export const transcriptStore = new Map<string, string>();

/** The session generation. Bumped by every reset below.
 *
 *  **Clearing a map does not cancel a promise, and the doc above claimed it
 *  did.** `previewInFlight` holds promises rather than plaintext, and its
 *  comment said it is cleared with the cache "so a read in flight across a lock
 *  cannot resolve into the next session's cache". That is not what clearing
 *  does. The completion closure in `widgets.ts` captures its own key and writes
 *  straight into the module-scope `previewCache`, so a read issued before a lock
 *  repopulates the cache AFTER the clear, and on `leaveActiveVault` it does so
 *  after a DIFFERENT vault has been unlocked. `transcript.ts`'s completion
 *  callback has the same shape.
 *
 *  `check-frontend-lock-teardown.mjs` was green throughout, because it asserts
 *  the CALL is present on both leaving paths. It is. The property the roster
 *  entry certifies is a different statement, and no guard reads it. That is the
 *  false-exhaustiveness shape this module's own header cites against the
 *  previous transcript comment, one file over.
 *
 *  A counter rather than an `AbortController` per read: the host's read is not
 *  abortable, so nothing would be saved by cancelling, and what has to be
 *  prevented is the WRITE. Capture at issue, compare before storing, drop on
 *  mismatch. */
let generation = 0;

/** The current session generation, captured by a caller at read-issue time. */
export function sessionGeneration(): number {
  return generation;
}

/** Whether a value captured at issue still belongs to the live session. A
 *  completion callback that stores plaintext MUST consult this before writing,
 *  and dropping the result is correct: the read belongs to a vault that is no
 *  longer open. */
export function isCurrentGeneration(captured: number): boolean {
  return captured === generation;
}

/** Forget every cached attachment preview.
 *
 *  Called on both vault-leaving paths and asserted there by
 *  `scripts/check-frontend-lock-teardown.mjs`. The cost of clearing is one
 *  re-read per still-visible embed after a re-unlock. Bumps the generation, so
 *  a read already in flight cannot write its result into the next session. */
export function resetPreviewCache(): void {
  previewCache.clear();
  previewInFlight.clear();
  generation += 1;
}

/** Forget every cached voice-note transcript. Same two paths, same guard, and
 *  the same generation bump for the same reason. */
export function resetTranscripts(): void {
  transcriptStore.clear();
  generation += 1;
}

/** Session zoom percentages for rendered mermaid diagrams, keyed by a hash of
 *  the diagram source. Owned by `decorations/mermaid-viewer.ts`, which writes
 *  the percentage on every committed view change (myne-md/myne#708).
 *
 *  A percentage is not plaintext, but the KEY is a fingerprint of note content,
 *  so the map enumerates the diagrams a vault holds. That is the same category
 *  as the note-id list `resetRecentNotes` clears, so it is cleared on the same
 *  paths rather than left to the next mount. `session-caches.ts` is its home for
 *  the reason this file's header gives: it is a leaf with no imports, and the
 *  teardown call must not drag the mermaid renderer into the eager bundle. */
export const mermaidZoomStore = new Map<string, number>();

/** Forget every remembered diagram zoom. Called on both vault-leaving paths and
 *  asserted there by `scripts/check-frontend-lock-teardown.mjs`, exactly as
 *  {@link resetPreviewCache} is. No generation bump: a percentage is restored
 *  synchronously at widget build, so there is no in-flight write to drop. */
export function resetMermaidZoom(): void {
  mermaidZoomStore.clear();
}
