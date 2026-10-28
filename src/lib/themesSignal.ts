// A change signal for the custom-theme STORE (`vault.themes`), the sibling of
// `src/notes/prefsNonce.ts`, which does the same job for `vault.prefs`.
//
// # Why the store needs one (myne#934)
//
// `vault.themes` has more than one writer and they do not share a surface. The
// Settings picker imports, and so does the confirmation dialog a
// `myne://theme/install` link opens. A picker that reads the store ONCE on
// mount is therefore correct only while nothing else writes: the theme applies,
// the app repaints in it, and the panel behind the still-open Settings modal
// keeps advertising "No custom themes yet" until it is remounted. That is
// exactly what shipped, so the read needs a signal to hang off rather than a
// longer mount.
//
// # What this signal does NOT cover
//
// A sync round landing a peer's `vault.themes` does not advance it, because
// nothing tells the WebView that happened: `core` reports the merge as
// `SyncCycleSummary::themes_applied_remote` and its own doc comment says no
// listener is wired yet, where `vault.prefs` gets `myne://prefs-changed` off the
// same flag (`PREFS_CHANGED_EVENT`, MYND-478). So a peer's theme reaches an open
// picker on the next mount, which is the same refresh boundary the PAINT path
// has (`App.tsx` re-applies a custom palette on a stage transition, not on a
// sync). Covering it means a `myne://themes-changed` emit beside the prefs one
// plus a bridge in `Editor.tsx`, and it belongs with that pair rather than
// invented here for one of the two blobs.
//
// # Why a nonce and not a window event
//
// Same reasoning as the prefs nonce: this is read by React components through
// `useSyncExternalStore`, which wants a monotonic snapshot and a subscription
// rather than an event name every surface has to remember to listen for and
// unlisten correctly. The prefs module carries both mechanisms because its
// window event (`VAULT_PREFS_CHANGED_EVENT`) exists for a non-React consumer.
// Nothing outside React reads the theme store, so there is one mechanism here.
//
// # Why no batching or microtask coalescing
//
// `prefsNonce` has both because one user action writes several prefs fields,
// so an unbatched flush means one full `vault.prefs` decrypt per field per
// mounted `usePrefs`. A theme store mutation is a single read-modify-write of
// ONE blob per action (`themes_import` / `themes_delete`), so there is no burst
// to collapse. If a future path writes the store twice in one action, this
// module is where the batching goes, not the caller.
//
// Bumping belongs to the writer, never to a surface: `src/lib/themes.ts` does
// it after the write RESOLVES, so a rejected import (nothing written) advances
// nothing and a picker does not re-read to find the store unchanged.

import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let nonce = 0;

/**
 * Advance the signal. Called only at the post-mutation chokepoint in
 * `src/lib/themes.ts`, after the write has resolved.
 */
export function bumpThemesNonce(): void {
  nonce += 1;
  for (const listener of listeners) listener();
}

/** Subscribe to store changes; returns an unsubscribe fn. Module-private: the
 *  one consumer is {@link useThemesNonce}, and `check-export-callers.mjs` holds
 *  a new file to zero unreferenced exports, which is the reason this is not
 *  offered to a second surface that does not exist. */
function subscribeThemesNonce(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Current nonce value (monotonic). Module-private, same reason as above. */
function getThemesNonce(): number {
  return nonce;
}

/** Re-renders the caller when the theme store changes. */
export function useThemesNonce(): number {
  return useSyncExternalStore(subscribeThemesNonce, getThemesNonce, getThemesNonce);
}

/** Test-only: reset module state between tests. */
export function __resetThemesNonceForTest(): void {
  nonce = 0;
  listeners.clear();
}
