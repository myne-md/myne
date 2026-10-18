// Load-bearing copy — the non-distinguishing error banners whose exact
// wording is a privacy property, not a style choice.
//
// These two literals are pinned by `docs/decisions.md` (2026-05-02
// "LITERAL compound" entry) and `docs/spec/recovery-flow.md` §3.4 /
// §7.3: the UI must never collapse them into a single distinguishing
// leg ("wrong password" alone would leak whether the file is intact;
// a per-word phrase error would leak which words were wrong). E2E
// asserts them by FULL-literal equality (SYNC-8 of the e2e-testing
// epic) — a substring match would silently pass a future collapse.
//
// Changing either string is a decisions.md event, not a copy edit.

// The two non-distinguishing banners (§3.4 / §7.3), the irreversibility sentence,
// the per-note/vault export egress sentences, the clip notice and the
// connected-extensions section moved to `@myne/copy` in audit R0.1
// (2026-10-19). Every one of them was declared HERE and in
// `src/lib/load-bearing-copy.ts` at the same time, so the "byte-identical by
// construction" claim two blocks down was true of the sync/enroll family and
// false of these. They are re-exported from the block below, so every mobile
// consumer and every FULL-literal test target is unchanged; the load-bearing
// rationale moved with them. `scripts/check-copy-membership.mjs` keeps the
// boundary honest: a client tree may not declare a name `@myne/copy` exports.

// Sync / enroll / device / export / clip / connected-extension load-bearing copy
// is SINGLE-SOURCED in the shared `@myne/copy` package (SYNC-42) so the literals
// are byte-identical across the desktop + mobile clients by construction,
// cross-client paraphrase is impossible. Re-exported here verbatim, exactly as
// `src/lib/load-bearing-copy.ts` does, so every mobile consumer and its
// FULL-literal test target (SYNC-8) is unchanged. Changing any is a
// decisions.md event, never a copy edit; the load-bearing rationale lives in
// `@myne/copy`.
//
// This block used to be six hand-written copies of these literals
// (myne-md/myne#474). They were byte-identical to the originals, BY HAND, which
// is precisely the distinction SYNC-42 exists to make: `pnpm-workspace.yaml`
// described the package as keeping them identical "by construction" and
// `mobile/vite.config.ts` named it among the packages this client consumes,
// while mobile imported it zero times and nothing failed if one side was edited
// alone. Audit R0.1 found eighteen more of exactly that shape in the same two
// files.
export {
  // The recovery drill's failure sentence (myne-md/myne#468). In `@myne/copy`
  // rather than hand-copied into each client's file, which is the lesson of
  // myne-md/myne#474: both clients render it, so byte identity has to be a
  // property of construction and not of somebody remembering.
  RECOVERY_DRILL_FAILED_SENTENCE,
  REMOVE_DEVICE_CONFIRM,
  REMOVE_DEVICE_DISCLOSURE,
  SYNC_INTEGRITY_ALERT,
  ENROLL_NON_DISTINGUISHING_BANNER,
  ENROLL_PENDING_NOTICE,
  ENROLL_APPROVED_NOTICE,
  // Not previously reachable from this client at all, and STAGED rather than
  // consumed: mobile has no beta-terms surface today (desktop's is
  // `src/components/sync/BetaTermsConsent.tsx`), so these five have no caller
  // here yet. They are re-exported now so that the surface, when it lands,
  // reaches for the literal rather than retyping it: this is text a user AGREED
  // to, and an acceptance recorded against a differently-worded copy on one
  // client is not an acceptance of what another client asked (myne-ops#15,
  // decisions.md 0483). An earlier version of this comment said mobile already
  // shows them, which was not true.
  BETA_TERMS_VERSION,
  BETA_TERMS_WHAT_THIS_IS,
  BETA_TERMS_DATA_LOSS,
  BETA_TERMS_WHAT_HAPPENS_NEXT,
  BETA_TERMS_WHAT_WE_CAN_SEE,
  // Transcript fallibility (voice-to-text MYND-552). The mobile transcript sheet
  // renders it beside the text, exactly as desktop's `TranscriptionModal` does;
  // in `@myne/copy` since myne-md/myne#886 so both clients show the same
  // sentence byte-for-byte rather than by promise.
  AI_TRANSCRIPT_HONESTY_NOTE,
  // ── The eighteen literals audit R0.1 moved out of THIS file and its desktop
  // twin (2026-10-19). Each was declared in both clients byte-identical by hand
  // while `copy/src/index.ts`'s header claimed that class was identical by
  // construction; the rationale for each now lives beside it there.
  UNLOCK_NON_DISTINGUISHING_BANNER,
  RECOVERY_NON_DISTINGUISHING_BANNER,
  LOST_BOTH_SECRETS_SENTENCE,
  EXPORT_PLAIN_MARKDOWN_SENTENCE,
  VAULT_EXPORT_PLAIN_TREE_SENTENCE,
  EXPORT_ATTACHMENTS_PLACEMENT_SUBLABEL,
  EXPORT_PDF_PLAIN_SENTENCE,
  EXPORT_PDF_EXCLUSION_SENTENCE,
  EXPORT_PLAIN_HTML_SENTENCE,
  EXPORT_PLAIN_TEXT_SENTENCE,
  BACKUP_SCHEDULE_FAILED_TOAST,
  CLIP_NOTICE_ROOT_MESSAGE,
  CLIP_NOTICE_VIEW_ACTION,
  clipOmittedTallyLine,
  CONNECTED_EXTENSIONS_TITLE,
  CONNECTED_EXTENSIONS_HELPER,
  CONNECTED_EXTENSIONS_EMPTY,
  CONNECTED_EXTENSIONS_REVOKE_LABEL,
  CONNECTED_EXTENSIONS_REPAIR_HINT,
} from "@myne/copy";

// Android precise delivery (MYND-619 task 6). Same discipline as the desktop
// reminder sentences (`REMINDER_LINUX_LIMITATION_SENTENCE` and its two
// siblings): a platform limitation stated in the settings copy rather than
// discovered by a user whose reminder arrived late, pinned by full-literal
// assertion, and **not translated** — its wording is a promise about behaviour,
// which is what separates it from a label.
//
// Classified as a **usability** limitation, not a security one: a device that
// batches a wake-up leaks nothing extra. The bar it has to clear is honesty,
// not alarm — it states the drift and what removes it, and it does not imply
// the app is broken or that the user must act.

/** Shown when the precise-alarm permission is not held — the default state. */
export const REMINDER_APPROXIMATE_DELIVERY_SENTENCE =
  "Android batches wake-ups to save battery, so reminders arrive around the time you set rather than exactly on it. Allowing exact timing removes the delay.";

// The pinned AI trust invariant (myne-md/myne#805). It is a privacy property
// (an E2E-pinned claim about what leaves the device), so it is rendered verbatim
// and never translated.
//
// **Byte-identical to the desktop constant by construction, which this comment
// used to claim and the code did not do.** It said the desktop file "re-exports
// this same literal"; that file declared its own copy of the string, so nothing
// stopped the two from drifting. Both now import it from `@myne/copy`, which is
// the construction, and `tests/lib/aiTrustCopy.test.ts` pins the shared bytes.
export { AI_TRUST_INVARIANT } from "@myne/copy";
