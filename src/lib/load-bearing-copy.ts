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
