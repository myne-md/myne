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
//
// ── Which file does a new user-facing string belong in? ─────────────────────
//
// The rule, written here because this is the file an implementer opens when
// they suspect the answer is "this one" (phase3-web-client task 98):
//
//   A string belongs in THIS file (or `@myne/copy`, for the cross-client set)
//   when its EXACT WORDING is a privacy or security property — that is, when a
//   reasonable paraphrase would change what an observer can infer. Everything
//   else gets an i18n key.
//
// The test is not "is this string important" or "does it mention security". It
// is: **would rewording it leak something, or claim something untrue?** Three
// shapes qualify:
//
//   1. **Non-distinguishing collapses.** Two failure causes deliberately share
//      one message so the message cannot tell them apart. Splitting the legs is
//      the leak; the shared wording is the control.
//   2. **Egress and irreversibility statements.** A sentence that is the ONLY
//      place a consequence is stated — plaintext leaving the vault, a loss with
//      no remedy. Softening it is the failure.
//   3. **Guarantee boundaries.** Copy that says what a client can and cannot
//      promise (`threat-model.md` qualifications). Overstating is the failure.
//
// A load-bearing literal is **rendered verbatim in every locale**, never through
// `t()`, and E2E-pins it by full-string equality. `scripts/check-i18n.mjs` fails
// if one appears as a value in ANY locale file — because the failure mode is not
// a bad translation, it is a GOOD one: the key ships, 24 locales fill it
// faithfully, the English still matches, every test passes, and the byte
// identity is gone.
//
// ── The web client's new strings, classified ────────────────────────────────
//
// Load-bearing (here or in `@myne/copy`):
//   * `ENROLL_NON_DISTINGUISHING_BANNER_NO_PHRASE` — shape 1. The web entry
//     flow checks account number and password against a server-fetched
//     `vault.meta`; both wrong inputs fail at the same AEAD-open step and must
//     collapse to one message. The `_NO_PHRASE` sibling exists because the
//     original names the recovery phrase as a possible cause and web has no
//     phrase — naming a credential the client cannot accept sends the user
//     looking for a field that does not exist. Selected by the `phraseRecovery`
//     CAPABILITY, never by a platform name.
//   * The four export egress sentences — shape 2, and on web they are the only
//     disclosure, since a download has no dialog title to carry one.
//
// i18n keys (`web.unsupported.*`, `storageLost.*`, `deviceRevoked.*`,
// `accountBootstrap.*` except the banner):
//   * The unsupported-browser refusal — it NAMES which capability is missing,
//     so it is deliberately distinguishing; there is nothing to collapse. Its
//     English rides `defaultValue` from `environment-gate.ts` so an untranslated
//     locale renders a sentence rather than a raw key.
//   * The KDF-ceiling and quota refusals — facts about this device's own limits.
//   * The storage-eviction and device-revocation copy — facts about this
//     browser's own state, which leak nothing to anyone who does not already
//     have the browser. Their honesty matters and is reviewed, but a translator
//     rewording them cannot leak anything.
//   * `accountBootstrap.accountMismatch` — the one deliberate departure, and it
//     is recorded next to the rule it departs from: it is a fact about this
//     browser's own storage, so distinguishing it from a credential failure
//     tells an attacker nothing they could not learn by opening the browser.

// The two non-distinguishing banners (§3.4 / §7.3), the irreversibility sentence,
// the per-note/vault export egress sentences, the clip notice and the
// connected-extensions section all moved to `@myne/copy` in audit R0.1
// (2026-10-19). Every one of them was declared HERE and in
// `mobile/src/lib/load-bearing-copy.ts` at the same time, so the
// "byte-identical by construction" claim a few lines down was true of the
// sync/enroll family and false of these. They are re-exported from the block at
// the bottom of this file, so every consumer and every FULL-literal E2E pin is
// unchanged; the load-bearing rationale moved with them.
//
// The rule for a NEW string is unchanged and still lives in the header above:
// exact wording is a privacy property → `@myne/copy` (cross-client) or a local
// constant (this client only). What is new is that a local constant may not
// shadow a name `@myne/copy` exports — `scripts/check-copy-membership.mjs`.

/** Task reminders (MYND-618): the one plain sentence stating what leaves the
 *  encrypted vault when a reminder is scheduled with the operating system.
 *
 *  **Load-bearing copy, not a translated string.** Its exact wording is a
 *  privacy statement, so it renders verbatim in every locale and is pinned by
 *  full-literal assertion — the same discipline as the export sentences above.
 *
 *  Three things it deliberately does NOT say. It does not claim Myne controls
 *  what a lock screen previews — the platform's own preview settings are the
 *  user's, not ours, and implying otherwise would be a promise we cannot keep.
 *  It does not soften "leaves the vault" into something vaguer. And it does not
 *  alarm: it states the fact and stops.
 *
 *  NOT RENDERED YET, and the reason is the point: it describes a cost the
 *  `pre-registered` tier imposes, and no platform ships that tier — there is no
 *  OS-registration adapter, so nothing is stored outside the vault. Showing this
 *  today would disclose a leak that does not exist and imply a capability that
 *  does not either. `ReminderSettings` gates it on the tier, so it appears on the
 *  same change that makes it true. */
export const REMINDER_OS_DISCLOSURE_SENTENCE =
  "To remind you while Myne is closed, your device stores the reminder times — not your task text — outside the encrypted vault.";

/** The opt-in for putting real task text in the notification body. Default OFF
 *  (MYND-618). Its own sentence, because turning it on changes what leaves the
 *  vault, and the user should read that at the moment they decide.
 *
 *  NOT RENDERED YET: the opt-in has no preference behind it (`vault.prefs` never
 *  gained a `reminder_show_text` field), and a toggle whose state cannot persist
 *  is worse than an absent one. Held here rather than deleted because the wording
 *  is reviewed, and the surface it belongs to is the OS tier's. */
export const REMINDER_SHOW_TEXT_SENTENCE =
  "Turning this on puts your task's text in the notification, where your device — and anyone who can see its screen — can read it.";

/** What the user is told while reminders are in-app only — which is **every
 *  platform** in this build, because the OS-registration adapter is gated behind
 *  a delivery measurement that has never been run (`reminderPlatform.ts`).
 *
 *  Deliberately platform-neutral. The Linux-specific sentence below says "On
 *  Linux", which was right when Linux was the exception; saying it on a Mac would
 *  be false in a way the user would notice, and stating the limitation without
 *  naming a platform is true everywhere. */
export const REMINDER_IN_APP_ONLY_SENTENCE =
  "Reminders appear only while Myne is open.";

/** Linux: the in-app layer is the whole feature there, said plainly rather than
 *  left to be discovered (MYND-618 task 7). Classified as a usability
 *  limitation, matching the threat-model entry: a platform that holds no
 *  registration leaks nothing, so this gap is the safer side of the trade.
 *
 *  Superseded in the UI by the platform-neutral sentence above for as long as
 *  every platform is in-app only. It returns when the OS adapter lands and Linux
 *  becomes the exception again. */
export const REMINDER_LINUX_LIMITATION_SENTENCE =
  "On Linux, reminders appear only while Myne is open.";

// Sync, enroll, device, export, clip and connected-extension load-bearing copy
// is SINGLE-SOURCED in the shared `@myne/copy` package (SYNC-42) so the literals
// are byte-identical across the desktop + mobile clients by construction —
// cross-client paraphrase is impossible. Re-exported here verbatim: every desktop
// consumer + its FULL-literal E2E target (SYNC-8) is unchanged. Changing any is a
// decisions.md event, never a copy edit; the load-bearing rationale lives in
// `@myne/copy`.
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
  // Its sibling for a client with no phrase credential (task 98). Same
  // non-distinguishing collapse, one fewer cause named — because naming a
  // credential the client cannot accept is a lie of capability, and this
  // constant's whole value is exactness.
  ENROLL_NON_DISTINGUISHING_BANNER_NO_PHRASE,
  ENROLL_PENDING_NOTICE,
  ENROLL_APPROVED_NOTICE,
  // Rendered only where `localOnlyVault` is absent (the web client), but it
  // lives in the shared package for the same reason the rest do: it is a claim
  // about what a command does, and a second client that ever ships a cached
  // vault must reach for this literal rather than write its own.
  LOCAL_ERASE_DISCLOSURE,
  // The other end of `REMOVE_DEVICE_DISCLOSURE`: what a revocation means to the
  // browser it happened TO (task 94). Kept beside it so the two claims stay
  // consistent — a user who reads both must not conclude one is lying.
  DEVICE_REVOKED_DISCLOSURE,
  // The four beta-terms clauses shown before sync is first switched on
  // (operations#15), and the version stamp that decides when they are shown
  // again. Shared for the strongest form of the usual reason: this is the text
  // a user AGREED to, and an acceptance recorded against a paraphrase on one
  // client would not be an acceptance of what another client asked.
  BETA_TERMS_VERSION,
  BETA_TERMS_WHAT_THIS_IS,
  BETA_TERMS_DATA_LOSS,
  BETA_TERMS_WHAT_HAPPENS_NEXT,
  BETA_TERMS_WHAT_WE_CAN_SEE,
  // Transcript fallibility (voice-to-text MYND-552). Moved here from a
  // desktop-local constant in myne-md/myne#886, when the mobile client grew the
  // same transcript surface and needed the same sentence: one literal, two
  // clients, renderer-identical by construction. The wording did not change, so
  // the SYNC-8 literal pins hold.
  AI_TRANSCRIPT_HONESTY_NOTE,
  // ── The eighteen literals audit R0.1 moved out of THIS file and its mobile
  // twin (2026-10-19). Each was declared in both clients byte-identical by hand
  // while `copy/src/index.ts`'s header claimed that class was identical by
  // construction; the rationale for each now lives beside it there. The rule
  // they were the counterexample to is enforced now, not promised:
  // `scripts/check-copy-membership.mjs` fails when a client tree declares a name
  // this package exports.
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

// AI trust affordance (local-ai epic MYND-408 / ai-remote-providers myne#415,
// SYNC-16). The AI settings panel's honesty copy. Load-bearing because the
// wording is a threat-model-bounded privacy claim — it must NOT exceed the
// guarantee set: A7 (local malware), A13 and, since 2026-08-09, A17 (a provider
// operator) are acknowledged, and no absolute "fully private / never leaves
// anywhere" claim is made (PRODUCT.md:41,80). E2E asserts by FULL-literal
// equality; changing any of it is a decisions.md event, not a copy edit.
// Rendered verbatim in every locale (never i18n'd, per src/AGENTS.md).
//
// **The shape changed on 2026-08-09 and the reason is worth reading before
// editing.** It used to be two flat constants asserting "runs entirely on your
// device … never sends your notes to any server". A user-named provider makes
// both false — a provider IS a server — so the copy became ONE INVARIANT
// SENTENCE plus ONE STATE SENTENCE, selected by which backend is answering.
// That keeps a single stable literal for the part that never changes and makes
// the varying part explicit rather than hedged into vagueness. The wording is
// quoted from `decisions.md` 2026-08-09, which fixed it deliberately so three
// sibling slices would not race the same pinned literal (SYNC-7).

/**
 * Which backend is answering — the one input the trust copy varies on.
 *
 * Three states rather than two, because "on this machine but not in this
 * process" is genuinely its own trust boundary (TB12) and collapsing it into
 * either neighbour would misstate it: it is not "entirely on your device, no
 * network involved", and it is not "sent to a company".
 */
export type AiTrustState =
  | { kind: "in-process" }
  | { kind: "local-runtime"; name: string }
  | { kind: "remote"; provider: string };

/**
 * Shown in **every** state, unchanged by the provider.
 *
 * The stable half of the shape #414 specifies: one invariant sentence plus one
 * state sentence. Keeping the invariant a single fixed literal is deliberate —
 * a provider-neutral sentence that tried to cover all three states would have
 * to say something like "your notes stay where you put them", which is true
 * and tells the user nothing.
 *
 * **The literal moved to `@myne/copy`.** It was a verbatim copy here and on
 * mobile, and the mobile copy's comment claimed the pair was "byte-identical by
 * construction" because this file re-exported it — which it never did; it
 * declared a second identical string. Both clients now import the one literal,
 * which is the construction, and `tests/lib/aiTrustCopy.test.ts` pins the shared
 * bytes rather than one client's opinion of them.
 */
export { AI_TRUST_INVARIANT } from "@myne/copy";

/**
 * The A7 residual, shown in every state and **unchanged** from the pre-provider
 * wording — malware already on the device can read app memory, and no provider
 * setting changes that.
 */
/** Re-exported from `@myne/copy`, where it moved in myne-md/myne#456.
 *
 *  It stayed here while every other consent clause was already shared, which is
 *  precisely why the mobile consent screen rendered seven clauses against the
 *  desktop's eight: mobile compiles `@myne/copy` and does not compile this file.
 *  Re-exported rather than deleted so the existing desktop call sites and
 *  `aiTrustFull` keep their import path. */
import { AI_TRUST_A7_RESIDUAL as A7_RESIDUAL } from "@myne/copy";
export { AI_TRUST_A7_RESIDUAL } from "@myne/copy";

/**
 * The state headline.
 *
 * Every clause is bounded by `threat-model.md` §5/§7 as amended 2026-08-09 and
 * by TB12/TB13; a later slice may say **less** than this, never more. The
 * wording is quoted from `decisions.md` 2026-08-09 rather than drafted here.
 *
 * Total over the union, so a fourth state fails to compile rather than
 * rendering an empty string.
 */
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

/**
 * The state detail — the "How does this work?" body, minus the invariant and
 * the A7 residual, which the panel shows alongside it.
 *
 * The remote wording deliberately claims **nothing on the provider's behalf**
 * (A17): Myne may say what it sends and to whom, never what the far side
 * retains, and the onward-routing clause exists because a broker forwards to
 * model vendors.
 */
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

/**
 * The full disclosure body for a state: the detail followed by the A7 residual.
 * The panel renders the invariant separately, above the headline.
 */
export function aiTrustDisclosure(state: AiTrustState): string {
  return `${aiTrustDetail(state)} ${A7_RESIDUAL}`;
}

// The one-time per-provider consent screen (ai-remote-providers myne#415
// task 13, SYNC-13). Load-bearing: this is the screen the whole feature's
// honesty rests on, and it is shown BEFORE anything leaves. Every sentence is
// bounded by `threat-model.md` §5/§7 and TB13/A17 as amended 2026-08-09;
// pinned by full-literal equality and rendered verbatim in every locale.
//
// Four questions, each answered explicitly rather than implied: WHAT leaves,
// WHEN it leaves, TO WHOM, and WHAT MYNE CANNOT VERIFY. The fourth is the one
// a consent screen usually omits, and it is the one that makes the other three
// honest.

// The AI-provider consent clauses moved to `@myne/copy` (myne-md/myne#456).
//
// **Why they moved.** Mobile ships a consent screen in that issue, and these are
// the sentences it has to show. A second copy would have been a second wording,
// and a threat-model-bounded claim that reads differently on two clients is a
// claim one of them is getting wrong. `@myne/copy` exists for exactly the class
// of string that must be byte-identical across clients by construction.
//
// They stay outside i18n for the same reason they always did (`src/AGENTS.md`):
// the exact wording is what `docs/threat-model.md` bounds, and a translation is
// a re-derivation nobody reviewed. Only the chrome around them is translated.
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
 *  load-bearing, threat-model-bounded framing shown in the chat surface: the
 *  answers come from a SMALL on-device model and MAY BE WRONG, and are grounded
 *  in the user's own notes (which is why citations exist). It must NOT imply
 *  cloud-grade capability or accuracy, and — per `threat-model.md` §7 — must NOT
 *  claim model-runtime isolation ("sandbox") until the sidecar lands. The
 *  fallibility admission is the honest counterweight to a weak local model; the
 *  visible citations (task 8) are how the user verifies. E2E/Vitest pin the
 *  exact wording by full-literal equality (SYNC-8 discipline). */
export const AI_CHAT_HONESTY_NOTE =
  "Answers come from a small model running on your device and may be wrong — check the notes it cites.";

/** The same note for a run served by a NAMED REMOTE PROVIDER.
 *
 *  **The one above says "running on your device", and since the remote arm
 *  shipped (#414/#415) that is false whenever a provider is named.** The chat
 *  surface printed it next to a status chip carrying the provider's own name,
 *  so it said "OpenRouter" and "on your device" in the same breath.
 *  `threat-model.md` TB13 is explicit that decrypted note plaintext leaves the
 *  device on that arm, and §6 states the order: downgrade the claim to match
 *  the threat model, never ship the copy and amend the model afterwards.
 *
 *  Two sentences rather than one edit to the constant above, on the precedent
 *  `decisions.md` 2026-07-13 set for `REMINDER_OS_DISCLOSURE_SENTENCE`: render
 *  the sentence that is true for the arm that is running. The local one keeps
 *  its exact wording, so what is pinned stays pinned.
 *
 *  It says **less** than `aiTrustDetail`'s remote body, which is what
 *  `decisions.md` 2026-08-09 permits: where the model runs, that Myne does not
 *  run it, and that the answer may be wrong. The full egress disclosure lives
 *  in the AI settings panel, and this surface points at the notes rather than
 *  restating it. */
export function aiChatHonestyNote(provider: string | null): string {
  if (provider === null) return AI_CHAT_HONESTY_NOTE;
  return `Answers come from a model at ${provider}, which Myne does not run, and may be wrong. Check the notes it cites.`;
}

// `AI_TRANSCRIPT_HONESTY_NOTE` moved to `@myne/copy` in myne-md/myne#886 (see the
// re-export block above) when the mobile client grew the same transcript surface.
// Rendered verbatim in every locale (never i18n'd); changing the wording is a
// `decisions.md` event, not a copy edit.
