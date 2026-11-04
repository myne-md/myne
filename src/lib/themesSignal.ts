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
// # Two sources advance it, and the second is the one a reader will not guess
//
// The writers in `src/lib/themes.ts` advance it after a local write RESOLVES.
// A sync cycle that merged a peer's `vault.themes` onto disk advances it too
// (myne#943): `core` reports that merge as `SyncSummary::themes_applied_remote`
// and emits `THEMES_CHANGED_EVENT`, the sibling of the prefs event off the same
// cycle (MYND-478), and `src/screens/Editor.tsx` bridges it into this nonce.
// That is the only advance with no local write behind it. It is also what keeps
// an open Appearance panel honest: the panel's override line reads
// `vault.prefs.custom_theme`, which is a DeviceLocal field and so never arrives
// from a peer, while the list below it reads this store, which does.
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
// Bumping belongs to whoever learned that the store changed, and never to a
// re-rendering surface: `src/lib/themes.ts` does it after the write RESOLVES, so
// a rejected import (nothing written) advances nothing and a picker does not
// re-read to find the store unchanged. The sync bridge is the one other
// legitimate caller, and it has a merge on disk behind it rather than a render.

import { useSyncExternalStore } from "react";

/**
 * Tauri event the sync loop emits after merging a REMOTE `vault.themes` change
 * onto disk (myne#943; `THEMES_CHANGED_EVENT` in `core`). Never fired for the
 * user's own IPC writes: their own resolve bumps the nonce. Contentless, so the
 * listener re-reads the store.
 *
 * Keep the string identical to the Rust constant. `tests/lib/eventNameMirrors.test.ts`
 * is what holds the pair, because a mismatch here is SILENT: the bridge would
 * subscribe to a name the backend never emits, and the panel would go stale with
 * no error anywhere.
 */
export const THEMES_SYNC_APPLIED_EVENT = "myne://themes-changed";

const listeners = new Set<() => void>();
let nonce = 0;

/**
 * Advance the signal. Called at the post-mutation chokepoint in
 * `src/lib/themes.ts` after a write resolves, and by the sync bridge in
 * `src/screens/Editor.tsx` when a peer's merge lands on disk.
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
