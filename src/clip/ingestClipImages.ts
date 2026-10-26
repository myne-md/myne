// desktop-ingest task 3 — in-memory image ingest → form-C embeds + importer-
// parity degrade (MYND-445, browser-extension epic, sub-feature `desktop-ingest`).
//
// WHAT THIS IS
// ------------
// The in-memory twin of the Obsidian importer's `processImportedMedia`
// (`src/notes/import/media.ts`). It walks a canonicalized clip body for the
// serializer's positional `clip-image:N` image refs (`src/dialect/clip.ts` —
// `![alt](clip-image:N)`), imports each correlated image's IN-MEMORY bytes via
// an injected port (the real port = `attachment_import { kind: "bytes" }`), and
// rewrites each successful ref IN PLACE to a form-C embed `![[att:<id>|filename]]`
// (`emitAttachmentEmbed`, the single form-C emitter, SYNC-4). A residual
// (oversize / non-image) degrades to a placeholder comment + the omitted-by-type
// tally — EXACT importer parity (SYNC-14).
//
// MATCHES THE SHIPPED SEAM. Same shape as `processImportedMedia`: a body + an
// INJECTED importer port in, a rewritten body + `MediaCounts` out. The port is
// injected so this module is unit-testable with a fake (no Tauri capability, no
// IPC here). It differs from the importer in exactly two ways:
//   - SOURCE = the clip's in-memory bytes (`envelope.imageBytes[N]`), NOT a
//     vault-relative path. The core NEVER reads a file or fetches a URL — the
//     clip bytes already live in RAM (SYNC-12).
//   - REF SHAPE = the serializer's `clip-image:N` markdown-image refs, NOT the
//     importer's `![[file.png]]` / `![alt](path)` media links. `clip-image:N`
//     correlates 1:1 to `imageBytes[N]` by positional index (the seam contract
//     in `src/dialect/clip.ts`).
//
// CAPS (story 24, enforced independently). The 64 MiB per-image cap is enforced
// RUST-SIDE inside `attachment_import` (`MAX_ATTACHMENT_LEN`) — an oversize image
// surfaces here as a TYPED port reject (`{ ok: false }`), the SAME degrade
// trigger the importer's `processImportedMedia` already uses for a failed import.
// This module does NOT re-implement the byte limit; it degrades on the reject.
// The 16 MiB composed-BODY cap is a SEPARATE, downstream concern (`note_create`,
// task 5) — independent of the per-image cap, never conflated here.
//
// RE-SNIFF + CONTENT-ADDRESS (stories 27, 31). `attachment_import` re-sniffs the
// MIME from the bytes (never trusts a caller-claimed type) so a non-image
// masquerading as an image rejects → placeholder, never an embed; and it
// content-addresses by hash, so identical bytes across a clip collapse to one
// stored `MYA1` blob (the `deduplicated` flag on the returned attachment is the
// observable signal). Both behaviors are the host's — this module wires the
// in-memory source through that shipped pipeline rather than re-deriving them.
//
// NEVER-ABORT (stories 21, 32). A single image that fails — a typed reject OR an
// outright thrown rejection from the port — NEVER aborts the whole ingest. Its
// `clip-image:N` ref degrades to a placeholder and the rest of the clip
// proceeds, so a flaky import can never lose the note. The throw is folded into
// the degrade the same way `importOne` folds a rejection into `{ ok: false }`.
//
// PURE (no React, no IPC, no I/O of its own — the only side effect is through
// the injected port). `(body, images, port) -> { body, counts, dedupHits }`.

import {
  applyTextRewrites,
  emptyMediaByType,
  type MediaCounts,
} from "../notes/import/media";
import { emitAttachmentEmbed } from "../notes/attachmentRef";
import { parseClipImageRef } from "../dialect/clip";
import {
  tallyCompression,
  type CompressionTally,
  type ImportedAttachment,
} from "../editor/attachments/insert";
import type { RawClipImage } from "./validateClipEnvelope";

/**
 * Import one clip image's IN-MEMORY bytes. Injected (the real impl =
 * `attachment_import { kind: "bytes", bytes, filename }` over IPC; tests inject
 * a fake). Mirrors `processImportedMedia`'s `RefImporter` port — the success
 * arm carries the stored {@link ImportedAttachment} (with its content-addressed
 * id + re-sniffed MIME + `deduplicated` flag); the failure arm is a bare
 * `{ ok: false }` so an oversize / non-image / IO residual is a single,
 * type-agnostic degrade trigger.
 *
 * A rejection (thrown) is folded into the degrade by {@link ingestClipImages},
 * so the port MAY throw — it does not have to pre-catch.
 */
export type ClipImageImporter = (
  image: RawClipImage,
) => Promise<{ ok: true; attachment: ImportedAttachment } | { ok: false }>;

/** The result of an image-ingest pass over a clip body. */
export interface ClipImageResult {
  /** The body with each in-cap clip-image ref rewritten to form-C + each
   *  residual ref replaced by a placeholder comment. Byte-preserving outside
   *  the rewritten ref spans. */
  readonly body: string;
  /** Ingested / omitted counts, by media class. Clip images are all `image`. */
  readonly counts: MediaCounts;
  /** How many imports were a content-address dedup hit (the second-and-later
   *  occurrence of identical bytes — `attachment.deduplicated === true`). */
  readonly dedupHits: number;
  /** How much ingest-time image compression this pass performed. A clipped
   *  image goes through the same shared-core transform a pasted one does, so
   *  the clip notice owes the same disclosure the paste toast gives
   *  (`decisions.md` 2026-07-30). Zero when nothing compressed. */
  readonly compression: CompressionTally;
}

/** The placeholder comment that replaces a non-ingestable clip image ref —
 *  same `<!-- omitted attachment: <name> -->` shape the importer emits
 *  (`processImportedMedia`'s `placeholderComment`), keyed on the image's
 *  display filename (the only name a clip image carries). A ref with no
 *  matching `imageBytes[N]` entry has no filename, so it reads `<unknown>`. */
function clipPlaceholderComment(filename: string | null): string {
  return `<!-- omitted attachment: ${filename ?? "<unknown>"} -->`;
}

/** A located `clip-image:N` markdown-image ref in the body. */
interface ClipImageRef {
  /** Byte offset of the ref's first char. */
  readonly from: number;
  /** Byte offset one past the ref's last char. */
  readonly to: number;
  /** The recovered positional index `N` (into `imageBytes`). */
  readonly index: number;
}

// `![alt](url)` markdown image. We then narrow `url` to a `clip-image:N` ref via
// `parseClipImageRef` (the seam recogniser) — a non-clip image (http/data URL)
// is left verbatim, only clip refs are touched. `alt` may be empty; `url` is the
// captured group. Mirrors the importer's `MARKDOWN_IMAGE_RE` shape.
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;

/**
 * Find every `clip-image:N` markdown-image ref in `body`, in document order.
 * A non-clip markdown image (an `http(s):` / `data:` URL — never produced by the
 * canonical serializer, but matched defensively) is skipped, so only the
 * positional clip refs are rewritten. The index is recovered through the seam's
 * own `parseClipImageRef`, so the recogniser stays the single authority on the
 * ref shape.
 */
function findClipImageRefs(body: string): ClipImageRef[] {
  const out: ClipImageRef[] = [];
  MARKDOWN_IMAGE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKDOWN_IMAGE_RE.exec(body)) !== null) {
    const index = parseClipImageRef(m[2].trim());
    if (index === null) continue; // not a clip-image ref — leave verbatim
    out.push({ from: m.index, to: m.index + m[0].length, index });
  }
  return out;
}

interface TextEdit {
  readonly from: number;
  readonly to: number;
  readonly replacement: string;
}

/**
 * Ingest a clip body's in-memory images: for each `clip-image:N` ref, look up
 * the correlated `imageBytes[N]`, import its bytes via `importImage`, and either
 * rewrite the ref to form-C `![[att:<id>|filename]]` (success) or replace it with
 * a placeholder comment + tally the omission (residual). Returns the transformed
 * body + the ingested/omitted-by-type counts + the dedup-hit count.
 *
 * Mirrors `processImportedMedia` — same body + injected-port → body + counts
 * seam — over the in-memory clip source. Never throws: a per-image port
 * rejection (typed `{ ok: false }` OR a thrown error) degrades that one ref and
 * the rest of the clip proceeds (NEVER an aborted ingest, stories 21/32).
 *
 * @param body the canonicalized clip markdown carrying `clip-image:N` refs
 * @param images the envelope's positional `imageBytes[]` (`{ filename, bytes }`)
 * @param importImage the injected import port (real = `attachment_import
 *   { kind:"bytes" }`; tests inject a fake)
 */
export async function ingestClipImages(
  body: string,
  images: readonly RawClipImage[],
  importImage: ClipImageImporter,
): Promise<ClipImageResult> {
  const refs = findClipImageRefs(body);
  const ingested = emptyMediaByType();
  const omitted = emptyMediaByType();
  const edits: TextEdit[] = [];
  const stored: ImportedAttachment[] = [];
  let dedupHits = 0;

  for (const ref of refs) {
    // Positional correlation: `clip-image:N` → `imageBytes[N]`. A ref with no
    // matching entry (the index is out of range) cannot be imported — it
    // degrades, never guesses.
    const image = images[ref.index];
    const outcome = image === undefined ? null : await importOne(image, importImage);

    if (outcome !== null && outcome.ok) {
      // The catalog filename the host stored (re-sniffed/derived) wins; fall
      // back to the clip's own filename. Form-C via the single emitter
      // (`emitAttachmentEmbed`), exactly like the importer's `planRewrite`.
      const filename = outcome.attachment.filename || image!.filename;
      edits.push({
        from: ref.from,
        to: ref.to,
        replacement: emitAttachmentEmbed(outcome.attachment.id, filename),
      });
      ingested.image++;
      stored.push(outcome.attachment);
      if (outcome.attachment.deduplicated) dedupHits++;
    } else {
      // Residual (oversize / non-image / IO / throw / no-bytes) → placeholder +
      // omitted tally. Importer parity: the rest of the body still lands.
      edits.push({
        from: ref.from,
        to: ref.to,
        replacement: clipPlaceholderComment(image?.filename ?? null),
      });
      omitted.image++;
    }
  }

  return {
    body: applyTextRewrites(body, edits),
    counts: { ingested, omitted },
    dedupHits,
    compression: tallyCompression(stored),
  };
}

/**
 * Import one image, folding ANY rejection (a typed `{ ok: false }` returned by
 * the port, OR a thrown error) into `{ ok: false }` — never throws. Mirrors
 * `importOne` in `editor/src/attachments/insert.ts`: a flaky single import becomes a
 * clean per-image degrade rather than aborting the whole pass.
 */
async function importOne(
  image: RawClipImage,
  importImage: ClipImageImporter,
): Promise<{ ok: true; attachment: ImportedAttachment } | { ok: false }> {
  try {
    return await importImage(image);
  } catch {
    return { ok: false };
  }
}
