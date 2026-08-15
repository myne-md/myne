// Import-&-convert command (epic MYND-164, sub-feature attachment-insert;
// decision 5 / story 6).
//
// Turns imported filename-only image refs (`![[image.png]]`, `![alt](path)`)
// into real encrypted attachments + form-C embeds. For each ref:
//   1. RESOLVE + IMPORT the source — auto-resolve the literal/relative path
//      (hand it to `attachment_import` as a `{kind:"path"}` source; the host
//      reads it); on a read miss, fall back to the file picker. The resolution
//      step is injected as a `RefImporter` so this module needs no dialog/fs
//      import (and stays node-testable, and adds no new Tauri capability).
//   2. PLAN the rewrite (`![[att:<id>|filename]]`), but do NOT apply yet.
// Then a MANDATORY diff-preview is shown (wikilink R2 parity, §7.1). Only on
// confirm are ALL rewrites applied in a single CM transaction (one undo step),
// back-to-front so earlier offsets stay valid. Byte-preserving everywhere
// outside the matched ref spans (C1 honored — post-import, user-initiated,
// transparent). NO silent name-match: a ref whose source can't be resolved is
// surfaced as "skipped" in the preview, never rewritten on a guess.

import { EditorView } from "@codemirror/view";
import i18n from "@myne/editor/i18n";
import {
  type ImportedAttachment,
  type ImportedImageRef,
  type PlannedRewrite,
  compressionNoticeMessage,
  findImportedImageRefs,
  planRewrite,
  summarizeCompressedAttachments,
} from "./insert";
import { type DiffPreviewRow, showDiffPreview } from "./diff-preview";
import { showAttachmentToast } from "./toast";
import { isEmptyEmbedLayout } from "@myne/dialect/embedLayout";
import { addCatalogRows } from "./catalog";

/** Resolve + import a ref's source, returning the stored attachment or a
 *  human reason it was skipped (unresolved source, oversize, etc.). Injected
 *  so the dialog/fs-fallback wiring lives in `convert-command.ts` and this
 *  module stays unit-testable. */
export type RefImporter = (
  ref: ImportedImageRef,
) => Promise<{ ok: true; attachment: ImportedAttachment } | { ok: false; note: string }>;

/** A ref that resolved + imported, paired with its planned rewrite. */
interface ResolvedRewrite {
  readonly ref: ImportedImageRef;
  readonly rewrite: PlannedRewrite;
}

/** A ref that could not be converted, with a human reason for the preview. */
interface SkippedRef {
  readonly ref: ImportedImageRef;
  readonly note: string;
}

export interface ConvertResult {
  readonly converted: number;
  readonly skipped: number;
  readonly cancelled: boolean;
}

/**
 * Run import-&-convert over the current note body. The `importRef` step does
 * resolve + import (injected); this orchestrates ref discovery, the mandatory
 * diff-preview, and the single-transaction rewrite on confirm. Returns a
 * summary.
 */
export async function convertImportedRefs(
  view: EditorView,
  importRef: RefImporter,
): Promise<ConvertResult> {
  const body = view.state.doc.toString();
  const refs = findImportedImageRefs(body);

  if (refs.length === 0) {
    showAttachmentToast(i18n.t("editor.attachment.convertCore.noneToConvert"));
    return { converted: 0, skipped: 0, cancelled: false };
  }

  const rewrites: ResolvedRewrite[] = [];
  const skipped: SkippedRef[] = [];
  // Every attachment this run actually stored, kept for the ingest-time
  // compression disclosure below. Compression is gated in shared core, so it
  // fires here exactly as it does on paste and drop — and a route that
  // compresses without saying so is the half of the obligation that gets
  // forgotten (`decisions.md` 2026-07-30).
  const stored: ImportedAttachment[] = [];
  // Imported rows, seeded into the editor catalog cache before the rewrite so
  // the new form-C embeds resolve to their image immediately (not a stale
  // "deleted" tombstone until a note-reopen).
  const importedRows: Array<{
    id: string;
    contentType: string;
    filename: string;
    size: number;
  }> = [];

  // Resolve + import each ref. A miss (unresolved source) or an import
  // rejection (oversize/unsupported/io) lands the ref in `skipped` — surfaced
  // in the preview, NEVER silently rewritten (no name-match guess).
  for (const ref of refs) {
    const outcome = await importRef(ref);
    if (!outcome.ok) {
      skipped.push({ ref, note: outcome.note });
      continue;
    }
    rewrites.push({ ref, rewrite: planRewrite(ref, outcome.attachment) });
    stored.push(outcome.attachment);
    importedRows.push({
      id: outcome.attachment.id,
      contentType: outcome.attachment.content_type,
      filename: outcome.attachment.filename,
      size: outcome.attachment.size,
    });
  }

  // Build the preview rows (rewrites first in doc order, then skips).
  const rows: DiffPreviewRow[] = [
    ...rewrites.map(
      (r): DiffPreviewRow => ({
        kind: "rewrite",
        before: r.ref.raw,
        after: r.rewrite.replacement,
      }),
    ),
    ...skipped.map(
      (s): DiffPreviewRow => ({
        kind: "skipped",
        before: s.ref.raw,
        note: s.note,
      }),
    ),
  ];

  const { confirmed } = await showDiffPreview(rows, rewrites.length);
  if (!confirmed) {
    return { converted: 0, skipped: skipped.length, cancelled: true };
  }

  addCatalogRows(view, importedRows);
  applyRewrites(view, rewrites.map((r) => r.rewrite));

  if (rewrites.length > 0) {
    const msg =
      i18n.t("editor.attachment.convertCore.converted", { count: rewrites.length }) +
      (skipped.length > 0
        ? i18n.t("editor.attachment.convertCore.skippedSuffix", { count: skipped.length })
        : "");
    // The compression disclosure rides on the existing toast rather than
    // replacing it: the converted/skipped counts are what the user asked this
    // command for, and the notice is the fact they did not ask for and cannot
    // undo. Same `" · "` join the batch summary uses between its own parts.
    const compression = summarizeCompressedAttachments(stored);
    // Preserved layout (myne#409): an Obsidian `|300` dimension, or a
    // markdown-image alt, that survived the rewrite instead of being dropped.
    // Stated rather than assumed: the whole complaint behind #409 was that this
    // happened silently, and a transform nobody can see is a transform nobody
    // trusts.
    const preserved = rewrites.filter(
      (r) => !isEmptyEmbedLayout(r.rewrite.ref.layout),
    ).length;
    const parts = [msg];
    if (preserved > 0) {
      parts.push(i18n.t("editor.attachment.convertCore.layoutPreserved", { count: preserved }));
    }
    if (compression !== null) parts.push(compressionNoticeMessage(compression));
    showAttachmentToast(parts.join(" · "));
  }
  return { converted: rewrites.length, skipped: skipped.length, cancelled: false };
}

/**
 * Apply every planned rewrite in ONE CodeMirror transaction (one undo step).
 * Applied back-to-front (descending `from`) so each replacement doesn't shift
 * the offsets of the ones not yet applied. Exported for direct testing.
 */
export function applyRewrites(view: EditorView, rewrites: readonly PlannedRewrite[]): void {
  if (rewrites.length === 0) return;
  const ordered = [...rewrites].sort((a, b) => b.ref.from - a.ref.from);
  const changes = ordered.map((r) => ({
    from: r.ref.from,
    to: r.ref.to,
    insert: r.replacement,
  }));
  view.dispatch({ changes, userEvent: "input.attachment-convert" });
}

/** Map a coarse import skip reason to a preview note line. Shared by the
 *  command wiring's importer. */
export function importSkipNote(reason: string): string {
  switch (reason) {
    case "too-large":
      return i18n.t("editor.attachment.convertCore.skipNote.tooLarge");
    case "unsupported":
      return i18n.t("editor.attachment.convertCore.skipNote.unsupported");
    case "locked":
      return i18n.t("editor.attachment.convertCore.skipNote.locked");
    case "not-found":
      return i18n.t("editor.attachment.convertCore.skipNote.notFound");
    default:
      return i18n.t("editor.attachment.convertCore.skipNote.failed");
  }
}
