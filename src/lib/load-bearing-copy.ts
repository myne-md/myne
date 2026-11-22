// Load-bearing copy — user-facing strings whose exact wording is a privacy or
// security property, not a style choice. Rendered verbatim in every locale and
// never passed through `t()`; E2E pins them by full-string equality (SYNC-8).
//
// Non-distinguishing banners pinned by `docs/decisions.md` (2026-05-02
// "LITERAL compound") and `docs/spec/recovery-flow.md` §3.4/§7.3: collapsing
// "wrong password" vs "corrupted file" would leak whether the file is intact.
// Changing either string is a decisions.md event, not a copy edit.
//
// Classification rule (phase3-web-client task 98): a string belongs here (or in
// `@myne/copy`) when rewording it would leak something or claim something
// untrue. Three shapes qualify: (1) non-distinguishing collapses sharing one
// message so it cannot tell causes apart; (2) egress/irreversibility statements
// that are the only place a consequence is stated; (3) guarantee boundaries
// stating what a client can and cannot promise (threat-model.md). Importance
// alone is not enough; everything else gets an i18n key.
//
// `scripts/check-i18n.mjs` fails if one of these appears as a value in any
// locale file: a good translation would silently destroy byte identity while
// every test stays green. `scripts/check-copy-membership.mjs` forbids a local
// constant shadowing a name `@myne/copy` exports.

/** Task reminders (MYND-618): the one plain sentence stating what leaves the
 *  encrypted vault when a reminder is scheduled with the OS.
 *
 *  Load-bearing copy, not a translated string: exact wording is a privacy
 *  statement, rendered verbatim in every locale and pinned by full-literal
 *  assertion, same discipline as the export sentences.
 *
 *  Three things it deliberately does NOT say: it does not claim Myne controls
 *  what a lock screen previews (the platform's own preview settings are the
 *  user's); it does not soften "leaves the vault"; it does not alarm — it
 *  states the fact and stops.
 *
 *  NOT RENDERED YET: it describes a cost the `pre-registered` tier imposes, and
 *  no platform ships that tier. The OS adapter exists as of myne-md/myne#1076 but
 *  the tier is still `in-app-only`, because the delivery measurement is blocked on
 *  a notarized bundle rather than answered (`decisions/ai/0805`). Nothing is stored
 *  outside the vault today, so showing this would disclose a leak that does not
 *  exist. `ReminderSettings` gates it on the tier, so it appears with the change
 *  that makes it true. */
export const REMINDER_OS_DISCLOSURE_SENTENCE =
  "To remind you while Myne is closed, your device stores the reminder times — not your task text — outside the encrypted vault.";

/** Opt-in for putting real task text in the notification body. Default OFF
 *  (MYND-618). Its own sentence because turning it on changes what leaves the
 *  vault, and the user reads it at the moment they decide.
 *
 *  NOT RENDERED YET: no `reminder_show_text` field in `vault.prefs`, so a
 *  toggle whose state cannot persist is worse than an absent one. Held (not
 *  deleted) because the wording is reviewed and belongs to the OS tier's
 *  surface. */
export const REMINDER_SHOW_TEXT_SENTENCE =
  "Turning this on puts your task's text in the notification, where your device — and anyone who can see its screen — can read it.";

/** What the user is told while reminders are in-app only — every platform in
 *  this build. The adapter now exists, and this sentence is unchanged on purpose:
 *  an adapter that can register is not a promise that what it registers arrives,
 *  and the delivery measurement is still blocked (`reminderPlatform.ts`,
 *  `decisions/ai/0805`).
 *
 *  Deliberately platform-neutral: the Linux-specific sentence below says "On
 *  Linux", right when Linux was the exception; saying it on a Mac would be
 *  false in a way the user notices, and stating the limitation without naming
 *  a platform is true everywhere. */
export const REMINDER_IN_APP_ONLY_SENTENCE =
  "Reminders appear only while Myne is open.";

/** Linux: the in-app layer is the whole feature there, said plainly rather than
 *  left to be discovered (MYND-618 task 7). Classified as a usability
 *  limitation matching the threat-model entry: a platform that holds no
 *  registration leaks nothing, so this gap is the safer side of the trade.
 *
 *  Superseded in the UI by the platform-neutral sentence above while every
 *  platform is in-app only. Returns when the OS adapter lands and Linux becomes
 *  the exception again. */
export const REMINDER_LINUX_LIMITATION_SENTENCE =
  "On Linux, reminders appear only while Myne is open.";

// Sync, enroll, device, export, clip and connected-extension load-bearing copy
// is single-sourced in the shared `@myne/copy` package (SYNC-42) so the
// literals are byte-identical across desktop + mobile by construction —
// cross-client paraphrase is impossible. Re-exported here verbatim; every
// desktop consumer and FULL-literal E2E target (SYNC-8) is unchanged. Changing
// any is a decisions.md event. Rationale lives in `@myne/copy`.
export {
  REMOVE_DEVICE_CONFIRM,
  REMOVE_DEVICE_DISCLOSURE,
  SYNC_INTEGRITY_ALERT,
  // ENROLL_NON_DISTINGUISHING_BANNER: no web renderer since the account-number
  // door was removed (decisions/sync/0767); its `_NO_PHRASE` sibling went with
  // it. The literal stays in `@myne/copy` because deleting it reverses
  // decisions/clients/0364 rather than tidying up.
  ENROLL_NON_DISTINGUISHING_BANNER,
  ENROLL_PENDING_NOTICE,
  ENROLL_APPROVED_NOTICE,
  LOCAL_ERASE_DISCLOSURE,
  MEMBER_VAULT_REMOVAL_DISCLOSURE,
  DEVICE_REVOKED_DISCLOSURE,
  BETA_TERMS_VERSION,
  BETA_TERMS_WHAT_THIS_IS,
  BETA_TERMS_DATA_LOSS,
  BETA_TERMS_WHAT_HAPPENS_NEXT,
  BETA_TERMS_WHAT_WE_CAN_SEE,
  AI_TRANSCRIPT_HONESTY_NOTE,
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
  CONNECTED_EXTENSIONS_EMPTY,
  CONNECTED_EXTENSIONS_REVOKE_LABEL,
} from "@myne/copy";

// AI trust affordance (local-ai MYND-408 / ai-remote-providers myne#415,
// SYNC-16). Threat-model-bounded privacy claim: must NOT exceed the guarantee
// set — A7 (local malware), A13 and, since 2026-08-09, A17 (provider operator)
// are acknowledged; no absolute "fully private / never leaves anywhere" claim
// (PRODUCT.md:41,80). E2E asserts by full-literal equality; rendered verbatim
// in every locale. Changing any is a decisions.md event.
//
// Shape changed 2026-08-09: two flat constants ("runs entirely on your device …
// never sends your notes") became false once a user-named provider IS a server,
// so copy became ONE INVARIANT SENTENCE plus ONE STATE SENTENCE selected by
// backend. One stable literal for the part that never changes; the varying part
// explicit rather than hedged. Wording quoted from decisions.md 2026-08-09,
// fixed deliberately so three sibling slices would not race the pinned literal
// (SYNC-7).

/** Which backend is answering — the one input the trust copy varies on.
 *
 *  Three states not two: "on this machine but not in this process" is its own
 *  trust boundary (TB12); collapsing it into either neighbour misstates it. */
export type AiTrustState =
  | { kind: "in-process" }
  | { kind: "local-runtime"; name: string }
  | { kind: "remote"; provider: string };

/** Shown in every state, unchanged by provider. The stable half of the shape
 *  #414 specifies. A provider-neutral sentence covering all three states would
 *  have to say "your notes stay where you put them" — true and useless.
 *
 *  The literal moved to `@myne/copy`: it was a verbatim copy here and on
 *  mobile, and mobile's comment claimed the pair was "byte-identical by
 *  construction" because this file re-exported it — which it never did; it
 *  declared a second identical string. Both clients now import one literal, and
 *  `tests/lib/aiTrustCopy.test.ts` pins the shared bytes. */
export { AI_TRUST_INVARIANT } from "@myne/copy";

/** The A7 residual, shown in every state, unchanged from the pre-provider
 *  wording — malware on the device can read app memory, and no provider setting
 *  changes that. Re-exported from `@myne/copy`, where it moved in
 *  myne-md/myne#456; kept here while every other consent clause was already
 *  shared, which is why the mobile consent screen rendered seven clauses
 *  against desktop's eight (mobile compiles `@myne/copy`, not this file).
 *  Re-exported rather than deleted so existing desktop call sites and
 *  `aiTrustFull` keep their import path. */
import { AI_TRUST_A7_RESIDUAL as A7_RESIDUAL } from "@myne/copy";
export { AI_TRUST_A7_RESIDUAL } from "@myne/copy";

/** The state headline. Every clause bounded by threat-model.md §5/§7 as
 *  amended 2026-08-09 and TB12/TB13; a later slice may say less, never more.
 *  Wording quoted from decisions.md 2026-08-09. Total over the union, so a
 *  fourth state fails to compile rather than rendering an empty string. */
export function aiTrustHeadline(state: AiTrustState): string {
  switch (state.kind) {
    case "in-process":
      return "This model runs entirely on your device.";
    case "local-runtime":
      return "This runs on a program on your computer. Your notes stay on this device.";
    case "remote":
      return `Your notes are sent to ${state.provider}, which Myne does not run.`;
  }
}

/** The state detail — the "How does this work?" body, minus the invariant and
 *  the A7 residual. Remote wording claims nothing on the provider's behalf
 *  (A17): Myne may say what it sends and to whom, never what the far side
 *  retains; the onward-routing clause exists because a broker forwards to
 *  model vendors. */
export function aiTrustDetail(state: AiTrustState): string {
  switch (state.kind) {
    case "in-process":
      return "The model is a file on this computer and no network connection is involved.";
    case "local-runtime":
      return `Your notes go to ${state.name}, a program running on this computer. They do not leave the device — but ${state.name} is not part of Myne, and Myne cannot see what it does with them.`;
    case "remote":
      return `They leave this device. Myne cannot see or control what ${state.provider} keeps, and if ${state.provider} routes your request onward, Myne cannot see that either.`;
  }
}

/** Full disclosure body for a state: detail followed by the A7 residual. The
 *  panel renders the invariant separately, above the headline. */
export function aiTrustDisclosure(state: AiTrustState): string {
  return `${aiTrustDetail(state)} ${A7_RESIDUAL}`;
}

// AI-provider consent screen (ai-remote-providers myne#415 task 13, SYNC-13).
// Load-bearing: the screen the whole feature's honesty rests on, shown BEFORE
// anything leaves. Every sentence bounded by threat-model.md §5/§7 and
// TB13/A17 as amended 2026-08-09; pinned by full-literal equality, rendered
// verbatim in every locale.
//
// Four questions, each answered explicitly: WHAT leaves, WHEN it leaves, TO
// WHOM, and WHAT MYNE CANNOT VERIFY. The fourth is the one a consent screen
// usually omits, and the one that makes the other three honest.

// The AI-provider consent clauses moved to `@myne/copy` (myne-md/myne#456).
// Mobile ships a consent screen in that issue and must show these; a second
// copy would be a second wording, and a threat-model-bounded claim that reads
// differently on two clients is a claim one of them gets wrong. `@myne/copy`
// exists for strings that must be byte-identical across clients by construction.
// They stay outside i18n (`src/AGENTS.md`): the exact wording is what
// threat-model.md bounds, and a translation is an unreviewed re-derivation.
// Only the chrome around them is translated.
export {
  CONSENT_WHAT_LEAVES,
  CONSENT_WHEN_IT_LEAVES,
  CONSENT_HOW_TO_REVOKE,
  CONSENT_DEVICE_SCOPE,
  CONSENT_DIRECT_CONNECTION,
  CONSENT_EXCLUDED_FOLDERS,
  consentToWhom,
  consentCannotVerify,
} from "@myne/copy";

/** Conversational-AI-chat honesty note (conversational-ai-chat task 13). A
 *  load-bearing, threat-model-bounded framing shown in the chat surface: answers
 *  come from a SMALL on-device model and MAY BE WRONG, grounded in the user's
 *  own notes (which is why citations exist). Must NOT imply cloud-grade
 *  capability or accuracy, and per threat-model.md §7 must NOT claim
 *  model-runtime isolation ("sandbox") until the sidecar lands. The fallibility
 *  admission is the honest counterweight to a weak local model; visible
 *  citations (task 8) are how the user verifies. Pinned by full-literal
 *  equality (SYNC-8). */
export const AI_CHAT_HONESTY_NOTE =
  "Answers come from a small model running on your device and may be wrong — check the notes it cites.";

/** The same note for a run served by a NAMED REMOTE PROVIDER.
 *
 *  The one above says "running on your device", false since the remote arm
 *  shipped (#414/#415); the chat surface printed it beside a status chip
 *  carrying the provider's own name, so it said "OpenRouter" and "on your
 *  device" in the same breath. threat-model.md TB13 says decrypted note
 *  plaintext leaves the device on that arm, and §6: downgrade the claim to match
 *  the threat model, never ship the copy and amend the model afterwards.
 *
 *  Two sentences rather than one edit to the constant above, on the precedent
 *  decisions.md 2026-07-13 set for REMINDER_OS_DISCLOSURE_SENTENCE: render the
 *  sentence true for the arm running. The local one keeps its exact wording, so
 *  what is pinned stays pinned.
 *
 *  It says less than aiTrustDetail's remote body, which decisions.md 2026-08-09
 *  permits: where the model runs, that Myne does not run it, and that the
 *  answer may be wrong. The full egress disclosure lives in the AI settings
 *  panel; this surface points at the notes rather than restating it. */
export function aiChatHonestyNote(provider: string | null): string {
  if (provider === null) return AI_CHAT_HONESTY_NOTE;
  return `Answers come from a model at ${provider}, which Myne does not run, and may be wrong. Check the notes it cites.`;
}

// AI_TRANSCRIPT_HONESTY_NOTE moved to `@myne/copy` in myne-md/myne#886 (see the
// re-export block above); rendered verbatim in every locale, never i18n'd.
// Changing the wording is a decisions.md event, not a copy edit.
