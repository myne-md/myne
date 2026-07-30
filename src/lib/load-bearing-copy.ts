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

/** Unlock A8b `InvalidCredentialOrVault` banner — §7.3 compound form. */
export const UNLOCK_NON_DISTINGUISHING_BANNER =
  "Wrong password or vault file is corrupted.";

/** Recovery A8d `InvalidCredentialOrVault` banner — §3.4 single
 *  non-distinguishing outcome (cells wiped, one message, no per-word
 *  or per-cause detail). */
export const RECOVERY_NON_DISTINGUISHING_BANNER =
  "Phrase or vault file is invalid. Please try again.";

// The normative "honest about cost" sentence (PRODUCT.md principle 3 /
// docs/design/README.md "Lost both secrets") — the irreversible
// consequence of losing both credentials, stated plainly. Rendered
// verbatim by PasswordStep's helper copy AND embedded in the first-run
// safety briefing's recovery-phrase "Why?" (MYND-114); the briefing
// component test asserts it as a substring of that "Why?" text. Single
// source so a revision (a product-voice decision, not a copy edit) lands
// in one place.

/** "If you lose both …" — the canonical irreversibility sentence. */
export const LOST_BOTH_SECRETS_SENTENCE =
  "If you lose both your password and recovery phrase, your notes are unrecoverable. We cannot help.";

// Per-note export pre-flight (MYND-116). The honest-egress sentence is
// load-bearing UI honesty (TB3 plaintext egress is stated plainly, once,
// never as a banner); the sub-label pins the attachments-placement
// contract of `note_export_attachments` (files land beside the note).
// E2E asserts both by FULL-literal equality — production renders the
// constants verbatim (`NoteExportModal`).

/** The one plain egress sentence of the per-note markdown export —
 *  shown in the pre-flight modal when the note references attachments,
 *  and carried as the OS save dialog's title on the common no-modal
 *  path (`runNoteExportFlow`), so it is said exactly once at the
 *  decision point either way. */
export const EXPORT_PLAIN_MARKDOWN_SENTENCE =
  "The exported file is plain Markdown — it is not encrypted.";

/** Whole-vault export (MYND-211): the one plain egress sentence shown in
 *  the vault-export modal's setup phase (`VaultExportModal`) — the
 *  whole-tree sibling of `EXPORT_PLAIN_MARKDOWN_SENTENCE`. Same honesty
 *  discipline: stated plainly, once, never as a banner; E2E asserts it by
 *  FULL-literal equality. */
export const VAULT_EXPORT_PLAIN_TREE_SENTENCE =
  "The exported files are plain Markdown — they are not encrypted.";

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

/** Muted sub-label under the "Include N attachments" toggle. */
export const EXPORT_ATTACHMENTS_PLACEMENT_SUBLABEL =
  "Files are placed in the same folder as the note.";

// Per-note PDF export pre-flight (MYND-255). Same honesty discipline as
// the markdown sentences above: the egress is stated plainly, once,
// never as a banner; the exclusion sentence pins the product decision
// that non-image attachment embeds (PDFs, archives, anything else the
// projection cannot inline) are NOT carried into the generated PDF
// (a muted in-document placeholder marks each position instead). The
// notice (`NotePdfExportNotice`) renders both verbatim; E2E asserts
// them by FULL-literal equality.

/** The one plain egress sentence of the per-note PDF export — shown in
 *  the pre-export notice when the projection excludes attachments, and
 *  carried as the OS save dialog's title on the common no-notice path
 *  (`runNotePdfExportFlow`), so it is said exactly once at the decision
 *  point either way. */
export const EXPORT_PDF_PLAIN_SENTENCE =
  "The exported file is a plain PDF — it is not encrypted.";

/** The attachment exclusion sentence (shown only when the note embeds
 *  attachments the projection cannot include — every non-image type,
 *  not just PDFs). */
export const EXPORT_PDF_EXCLUSION_SENTENCE =
  "Attached files (PDFs and other non-image attachments) are not included in the generated PDF.";

// Per-note HTML + plain-text export (note-export MYND-340). Same honesty
// discipline as the markdown / PDF sentences above: the egress is stated
// plainly, once (carried on the OS save dialog title, or shown in the
// pre-flight attachments modal for HTML), never as a banner; E2E asserts
// them by FULL-literal equality.

/** The one plain egress sentence of the per-note HTML export — shown in
 *  the pre-flight modal when the note references image attachments, and
 *  carried as the OS save dialog's title on the common no-modal path
 *  (`runNoteHtmlExportFlow`), so it is said exactly once at the decision
 *  point either way. */
export const EXPORT_PLAIN_HTML_SENTENCE =
  "The exported file is plain HTML — it is not encrypted.";

/** The one plain egress sentence of the per-note plain-text export —
 *  carried as the OS save dialog's title (`runNoteTxtExportFlow`); the
 *  TXT projection never includes attachments, so there is no pre-flight
 *  modal and the sentence is said only here. */
export const EXPORT_PLAIN_TEXT_SENTENCE =
  "The exported file is plain text — it is not encrypted.";

// Automatic local-backup failure toast (MYND-351). A backup feature must never
// fail silently — when a scheduled backup cannot write (target gone / disk full
// / permission denied) the user sees this once (debounced); the schedule stays
// enabled and retries next cycle. E2E (task 8 failure-path) asserts it by
// FULL-literal equality, so it lives here as the single source.

/** Scheduled-backup failure toast — the quiet, non-silent failure alert. */
export const BACKUP_SCHEDULE_FAILED_TOAST =
  "Automatic backup failed. Check your backup folder in Settings → Storage.";

// Sync / enroll / device load-bearing copy (MYND-425/427) is SINGLE-SOURCED in
// the shared `@myne/copy` package (SYNC-42) so the literals are byte-identical
// across the desktop + mobile clients by construction — cross-client paraphrase
// is impossible. Re-exported here verbatim: every desktop consumer + its
// FULL-literal E2E target (SYNC-8) is unchanged. Changing any is a decisions.md
// event, never a copy edit; the load-bearing rationale lives in `@myne/copy`.
export {
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
} from "@myne/copy";
// Browser-extension clip success notice (desktop-ingest task 7, MYND-442). A
// clip lands at the vault ROOT (SYNC-15) and the user keeps working — the
// notice is a non-blocking toast with a "view" affordance that opens the new
// note. The copy is load-bearing: E2E asserts the message + action label + each
// omitted-tally line by FULL-literal equality, so the strings live here as the
// single source. The tally renders PROMINENTLY (one labelled line per omitted
// media class) because a single clip losing its hero image is surprising — far
// more so than a per-type loss inside a bulk import.

/** The clip success notice's primary line — the clip landed at the vault root. */
export const CLIP_NOTICE_ROOT_MESSAGE = "Clipped to your vault root.";

/** The label of the clip notice's "view" affordance (opens the new note). */
export const CLIP_NOTICE_VIEW_ACTION = "View";

/** The display label for each omitted media class in the clip tally. Keyed on
 *  the user-meaningful media class (`src/notes/import/media.ts`); the value is
 *  the singular noun the tally line uses (pluralised by `clipOmittedTallyLine`
 *  when the count is >1). */
const CLIP_OMITTED_CLASS_NOUN: Record<string, string> = {
  image: "image",
  pdf: "PDF",
  audio: "audio file",
  video: "video",
  other: "attachment",
};

/** Render one prominent omitted-by-type tally line (e.g. "1 image omitted",
 *  "3 PDFs omitted"). Load-bearing: E2E asserts the rendered line by literal
 *  equality, so the wording lives here. The count is always ≥1 (the builder
 *  emits a line only for a non-zero class). */
export function clipOmittedTallyLine(mediaClass: string, count: number): string {
  const noun = CLIP_OMITTED_CLASS_NOUN[mediaClass] ?? "attachment";
  const plural = count === 1 ? noun : pluraliseOmittedNoun(noun);
  return `${count} ${plural} omitted`;
}

/** Pluralise an omitted-class noun. "PDF" → "PDFs", "audio file" → "audio
 *  files" (the head noun pluralises), everything else gets a trailing "s". */
function pluraliseOmittedNoun(noun: string): string {
  if (noun === "audio file") return "audio files";
  return `${noun}s`;
}

// Connected-extensions Settings section (ext-foundation-handoff task 7,
// MYND-443). Settings → Account lists the live (non-revoked) paired browser
// extensions with a per-row Revoke. Revoke is desktop-authoritative, immediate
// + durable — the re-pair hint states the consequence plainly (the extension
// must pair again to reconnect). E2E asserts these literals by full equality,
// so they live here as the single source.

/** Section title for the connected-extensions list (Settings → Account). */
export const CONNECTED_EXTENSIONS_TITLE = "Connected extensions";

/** Helper line under the section title — what a paired extension is. */
export const CONNECTED_EXTENSIONS_HELPER =
  "Browser extensions you have paired with this vault. Revoking one disconnects it immediately.";

/** Empty state — no extension has been paired yet (the start-empty case). */
export const CONNECTED_EXTENSIONS_EMPTY = "No connected extensions.";

/** The per-row Revoke action label. */
export const CONNECTED_EXTENSIONS_REVOKE_LABEL = "Revoke";

/** The one-line consequence hint shown after the list — revoke is durable and
 *  the extension must pair again to reconnect (the re-pair itself is the
 *  extension's side, out of scope for this UI). */
export const CONNECTED_EXTENSIONS_REPAIR_HINT =
  "A revoked extension must pair again to reconnect.";

// Local-AI trust affordance (local-ai epic, ai-ux-surface MYND-408, SYNC-16).
// The AI settings panel's honesty copy: a headline + a "How does this work?"
// disclosure. Load-bearing because the wording is a threat-model-bounded
// privacy claim — it must NOT exceed the guarantee set: A7 (local malware) and
// A13 are acknowledged, and no absolute "fully private / never leaves anywhere"
// claim is made (PRODUCT.md:41,80). E2E asserts both by FULL-literal equality;
// changing either is a decisions.md event, not a copy edit. Rendered verbatim
// in every locale (never i18n'd, per src/CLAUDE.md).

/** AI panel trust headline — the CSP-backed "runs on your device" claim. */
export const AI_TRUST_HEADLINE =
  "This model runs entirely on your device. Myne never sends your notes to any server.";

/** AI panel "How does this work?" disclosure — the honest, bounded detail:
 *  local, network-free inference, a user-picked model file, and the A7 residual
 *  (malware already on the device can read app memory) stated plainly.
 *
 *  NOTE (2026-07-01): the earlier wording claimed inference runs "in a sandboxed
 *  process" — an OVERCLAIM. Per `threat-model.md` §7 "Local AI runs in-process,
 *  not yet sandboxed", the model runtime is IN-PROCESS in v0.1 (the sandboxed
 *  sidecar is a deferred pre-default-on hardening), and the threat model
 *  explicitly forbids claiming model-runtime isolation until it lands — the true
 *  claim is "runs locally, sends nothing". The sandbox phrase was removed; the
 *  no-network / never-transmitted / A7-residual claims are all still accurate
 *  (the no-egress gate guarantees no network path structurally). Re-add the
 *  isolation wording only when the sidecar ships (a `decisions.md` event). */
export const AI_TRUST_DISCLOSURE =
  "Inference runs locally with no network access, so your notes are never transmitted. You pick the model file from your own disk. Like the rest of Myne, this does not protect against malware already running on your device — such software can read app memory.";

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

/** Transcript-fallibility honesty note (voice-to-text MYND-552, SYNC-V8). A
 *  load-bearing, threat-model-bounded framing shown beneath the read-only
 *  transcript expander: the transcript comes from a SMALL on-device speech model
 *  and MAY BE WRONG. It must NOT imply cloud-grade accuracy, and — per
 *  `threat-model.md` §7 — must NOT claim model-runtime isolation ("sandbox"), the
 *  same discipline as `AI_CHAT_HONESTY_NOTE`. The trust affordance itself reuses
 *  `AI_TRUST_HEADLINE` / `AI_TRUST_DISCLOSURE` verbatim — this note is only the
 *  accuracy counterweight. E2E/Vitest pin the exact wording by full-literal
 *  equality (SYNC-8); changing it is a `decisions.md` event, not a copy edit.
 *  Rendered verbatim in every locale (never i18n'd). */
export const AI_TRANSCRIPT_HONESTY_NOTE =
  "This transcript was made by a small model running on your device and may be wrong — check it against the audio.";
