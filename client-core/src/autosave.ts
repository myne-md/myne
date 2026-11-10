// The autosave cadence, which is ONE product decision and not a per-client taste.
//
// Pinned at 1000/10000 by `decisions.md` 2026-05-15 (the γ2 debounce pair). Both
// clients answer this question the same way, and the question touches no host,
// so it belongs in the decision layer rather than in two files quoting each
// other: `src/notes/saveNote.ts` (desktop) and the phone's `useAutosave` import
// this, and a change here moves both.

/** Idle-debounce N: write after N ms with no keystroke. */
export const AUTOSAVE_IDLE_MS = 1000;

/** Max-debounce M: write at most every M ms even during sustained typing. */
export const AUTOSAVE_MAX_MS = 10_000;
