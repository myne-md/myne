// Load-bearing copy — the non-distinguishing error banners whose exact
// wording is a privacy property, not a style choice.
//
// These two literals are pinned by `design-notes.md` (2026-05-02
// "LITERAL compound" entry) and `docs/spec/recovery-flow.md` §3.4 /
// §7.3: the UI must never collapse them into a single distinguishing
// leg ("wrong password" alone would leak whether the file is intact;
// a per-word phrase error would leak which words were wrong). E2E
// asserts them by FULL-literal equality (SYNC-8 of the e2e-testing
// epic) — a substring match would silently pass a future collapse.
//
// Changing either string is a decisions.md event, not a copy edit.

/** Unlock A8b `InvalidCredentialOrVault` banner — §7.3 compound form. */
export const UNLOCK_NON_DISTINGUISHING_BANNER =
  "Wrong password or vault file is corrupted.";

/** Recovery A8d `InvalidCredentialOrVault` banner — §3.4 single
 *  non-distinguishing outcome (cells wiped, one message, no per-word
 *  or per-cause detail). */
export const RECOVERY_NON_DISTINGUISHING_BANNER =
  "Phrase or vault file is invalid. Please try again.";
