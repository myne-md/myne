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

// Device removal honesty (MYND-425). "Remove device" revokes a per-device sync
// token — it stops the server from serving that device — but it does NOT
// cryptographically lock out a device that already holds root_key (an attacker
// with the vault file + the password/phrase is unaffected, threat-model no-FS
// note). The copy MUST say what removal does and does not do, and MUST NEVER
// imply a cryptographic lockout. E2E asserts these by FULL-literal equality
// (SYNC-8); changing either is a decisions.md event, not a copy edit.

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
// notes are safe. E2E asserts it by FULL-literal equality (SYNC-8); changing it is
// a decisions.md event, not a copy edit.

/** The hard integrity-alert banner shown on a rollback / non-extending head. */
export const SYNC_INTEGRITY_ALERT =
  "Possible sync integrity problem: the server may have sent out-of-date or altered sync data, which Myne did not accept. Your local notes are safe. If this keeps happening, verify your devices.";

// Device-enrollment copy (MYND-425 task 5). The add-device flow proves account
// ownership with {account# + password OR 24-word phrase}; a wrong credential and
// a wrong account number both fail at the same AEAD-open step, so the failure copy
// MUST be a single non-distinguishing message — exactly the unlock/recovery
// discipline above (collapsing to "wrong password" alone would leak that the
// account number was valid). The pending message must be honest about the
// approval gate (the server holds the device until an already-trusted device
// approves it — Myne cannot sync until then). E2E asserts these by FULL-literal
// equality (SYNC-8); changing any is a decisions.md event, not a copy edit.

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
