// @myne/copy — shared LOAD-BEARING user-facing copy (SYNC-42).
//
// The exact English wording of these strings is a security/privacy property, not
// a stylistic choice. They are consumed as SOURCE by BOTH the desktop client
// (`src/lib/load-bearing-copy.ts` re-exports them) and the mobile client
// (`myne-mobile/src/…`), so the literals are byte-identical across clients by
// construction — cross-client paraphrase is impossible. E2E asserts them by
// FULL-literal equality; changing any is a `docs/decisions.md` event, never a
// copy edit. Never i18n these (see `src/CLAUDE.md` "Do NOT i18n load-bearing copy").

// Device removal honesty (MYND-425). "Remove device" revokes a per-device sync
// token — it stops the server from serving that device — but it does NOT
// cryptographically lock out a device that already holds root_key (an attacker
// with the vault file + the password/phrase is unaffected, threat-model no-FS
// note). The copy MUST say what removal does and does not do, and MUST NEVER
// imply a cryptographic lockout.

/** Short confirm line for the Remove-device action. */
export const REMOVE_DEVICE_CONFIRM =
  "Remove this device from sync?";

/** The honest "what it does / what it doesn't do" disclosure (expandable). It
 *  is deliberately two plain sentences: the effect (sync stops) and the limit
 *  (no cryptographic lockout) — never collapsed, never overstated. */
export const REMOVE_DEVICE_DISCLOSURE =
  "Removing this device revokes its sync access, so the server stops syncing to it. It does not lock a device that already has your vault and password — removal is not a remote wipe.";

// Sync integrity alert (MYND-427 task 2). When the engine's head-verify fails to
// extend the last-seen head (a rollback or a withheld/omitted update), the client
// raises a hard, honest integrity alert (SuspicionBanner-class) — NEVER silently
// accepted. The copy is load-bearing honesty: it says the problem is *possible*
// (head-verify catches rollback/non-extension, but a perfectly-consistent
// withholding is not generally detectable — the threat-model no-general-detection
// note), it never claims Myne detects all tampering, and it reassures that local
// notes are safe.

/** The hard integrity-alert banner shown on a rollback / non-extending head. */
export const SYNC_INTEGRITY_ALERT =
  "Possible sync integrity problem: the server may have sent out-of-date or altered sync data, which Myne did not accept. Your local notes are safe. If this keeps happening, verify your devices.";

// Device-enrollment copy (MYND-425 task 5). The add-device flow proves account
// ownership with {account# + password OR 24-word phrase}; a wrong credential and
// a wrong account number both fail at the same AEAD-open step, so the failure copy
// MUST be a single non-distinguishing message (collapsing to "wrong password"
// alone would leak that the account number was valid). The pending message must be
// honest about the approval gate (the server holds the device until an
// already-trusted device approves it — Myne cannot sync until then).

/** Non-distinguishing enroll failure — covers wrong account#, wrong credential,
 *  or a missing/corrupt vault.meta on the server, with one message. */
export const ENROLL_NON_DISTINGUISHING_BANNER =
  "Account number, password, or recovery phrase is incorrect. Please try again.";

/** Honest enroll-pending notice — the device is held by the approval gate. */
export const ENROLL_PENDING_NOTICE =
  "This device is waiting for approval. Approve it from a device that already has access to start syncing.";

/** Enroll success — the device was approved and a sync token issued. */
export const ENROLL_APPROVED_NOTICE =
  "This device is now connected and syncing.";
