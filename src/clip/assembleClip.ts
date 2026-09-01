// desktop-ingest task 5 — shared ingest assembly routine (clip body shape) +
// `note_create` seal (MYND-445, browser-extension epic, sub-feature
// `desktop-ingest`). This is the sub-feature's MAIN ENTRY POINT.
//
// WHAT THIS IS
// ------------
// The single shared assembly routine that ORDERS the pieces tasks 1–4 produce
// and seals the result into an ordinary `MY01` note via the EXISTING
// `noteCreate(plaintext)`. It is the one place desktop ingest is composed: the
// host (sub-feature 1) relays a raw clip envelope, and this routine drives it
// through validation → image ingest → wikilink resolution → provenance
// composition → seal, returning a typed result the host reply (task 6) and the
// in-app notice (task 7) both consume.
//
// THE STEP ORDER (and WHY)
// ------------------------
//   (1) VAULT-UNLOCKED CHECK. If the vault is locked, return `{ kind: "locked" }`
//       and write NOTHING — `noteCreate` is NEVER called, there is NO pending
//       queue, nothing is captured at rest (SYNC: a locked vault drops the clip,
//       it never buffers plaintext to disk). This is the FIRST gate so a hostile
//       or accidental clip into a locked vault can never touch the note store.
//   (2) VALIDATE the envelope (task 1, the ingress boundary gate). On a typed
//       rejection, return `{ kind: "error", reason }` — no partially-validated
//       envelope ever reaches the later steps.
//   (3) INGEST IMAGES + degrade (task 3). This imports each in-memory clip image
//       and splices form-C `![[att:<id>|filename]]` embeds INTO the body in place
//       (residuals degrade to placeholder comments, importer-parity). The
//       `MediaCounts` it returns ride out in the `accepted` result.
//   (4) RESOLVE outbound wikilinks (task 4) over the image-spliced body. Run
//       AFTER images (the image rewrite never touches `[[wikilinks]]`, and
//       resolving over the already-spliced body keeps a single rewrite plan on
//       the final body shape) and BEFORE compose:
//
//         resolve-vs-compose ORDER RATIONALE — resolve operates on the BODY's
//         `[[wikilinks]]`; compose PREPENDS provenance frontmatter (which carries
//         no wikilinks). Resolving first means the wikilink pass sees only body
//         bytes, never the injected `source:`/`url:`/`clipped:` block — so a
//         provenance value that happens to look like `[[text]]` can never be
//         mis-rewritten as a link, and the wikilink byte-offsets are computed on
//         the body alone. Compose then prepends the frontmatter to the resolved
//         body. (The reverse order — compose then resolve — would force the
//         wikilink pass to skip the frontmatter region and risk offset drift; we
//         avoid that entirely.)
//   (5) COMPOSE provenance frontmatter + body (task 2). Prepends `source:` /
//       `url:` / `clipped:` (SYNC-14) onto the resolved body, producing the final
//       plaintext of a ROOT note (SYNC-15).
//   (6) SEAL via the EXISTING `noteCreate(plaintext)` — NO new command, NO
//       widened signature, NO new capability ACL entry. The 16 MiB composed-body
//       cap is enforced RUST-SIDE inside `note_create` (`MAX_PLAINTEXT_LEN`); an
//       oversize composed body surfaces as a `PlaintextTooLarge` reject, which we
//       map to `{ kind: "error" }` (no half-saved note — the seal is atomic).
//   (7) RETURN `{ kind: "accepted", noteId, counts }` — ONLY after `noteCreate`
//       actually resolves. NO optimistic ack: a rejecting seal yields an error
//       result, never an `accepted` one.
//
// INVARIANTS
// ----------
//   - C1 BYTE-STABILITY. The ONLY mutations to the handed-off markdown are the
//     already-sanctioned media-ref rewrite to form-C (task 3), the wikilink
//     path-form rewrite (task 4), and the frontmatter injection (task 2). This
//     routine performs NO content sanitization on write (no byte-scrubbing —
//     that would violate C1). The note is sealed as raw bytes; any HTML renders
//     as plain text through the existing DOMPurify allowlist at SERVE time, not
//     here (render-safety by construction — this routine adds no render path).
//   - NO CORE-SIDE FETCH. The routine NEVER dereferences `url` / `source` — it
//     only carries them into frontmatter as opaque scalars. No SSRF, no
//     read-receipt leak. The image bytes already live in RAM (SYNC-12); the
//     resolver note-set is loaded from the local decrypted index, never the
//     network.
//   - LOCKED → NOTHING WRITTEN. Step (1) short-circuits before any write.
//
// THE BOOKMARK SEAM (task 9 / sub-feature 5)
// ------------------------------------------
// The `body` is a CALLER-SUPPLIED parameter, SEPARATE from `envelope.markdownBody`.
// For `full-article` / `selection` the caller passes `envelope.markdownBody` (the
// canonicalized clip markdown). A url-bookmark (sub-feature 5, MYND-447) supplies a
// content-light bookmark body through the IDENTICAL path WITHOUT forking this
// routine — the body is the parameterization point. This module does NOT build the
// bookmark body (that is sub-feature 5); it only exposes the seam.
//
// The COMPOSE step is the OTHER parameterization point. A clip composes provenance
// via `composeClipPlaintext` (managed-blind `source:`/`url:`/`clipped:`); a
// bookmark needs a DIFFERENT shape (managed `title:` + `source:`/`clipped:`, no
// `url:`). Per desktop-ingest task 9 this routine must NOT branch on `captureKind`
// internally — so the composer is a caller-supplied `composePlaintext` arg
// DEFAULTING to `composeClipPlaintext`. Every existing clip test + the live clip
// path is byte-for-byte unchanged (the default is the clip composer); the bookmark
// caller passes its own composer. Only the compose function is swapped — the
// validate → images → wikilinks → seal logic stays identical.
//
// INJECTABLE SEAMS. Every IPC seam is injected via the {@link ClipAssemblyDeps}
// object (`{ noteCreate, importImage, isVaultUnlocked, loadResolverNotes }`) so the
// routine is fully unit-testable with fakes. {@link defaultClipAssemblyDeps} binds
// the real ports (the production wiring); tests pass fakes.

import { composeClipPlaintext } from "./composeClipPlaintext";
import { ingestClipImages, type ClipImageImporter } from "./ingestClipImages";
import { resolveClipWikilinks } from "./resolveClipWikilinks";
import { validateClipEnvelope, type RawClipEnvelope } from "./validateClipEnvelope";

import type { MediaCounts } from "../notes/import/media";
import type { CompressionTally } from "../editor/attachments/insert";
import type { ClipEnvelopeRejection, ValidatedClipEnvelope } from "./validateClipEnvelope";
import type { ResolverNote } from "../notes/resolveWikilink";

import { noteCreate } from "../notes/createNote";
import { importOne } from "../editor/attachments/insert";
import { isVaultUnlocked } from "../lib/vault-unlock";
import { noteList } from "../notes/listNotes";
import { loadNoteBatch, type TitleRecord } from "../notes/loadNoteBatch";
import { resolverNotesFromCache } from "../notes/resolverNotes";

/**
 * The injectable IPC seams the assembly routine drives. Each is a port so the
 * routine is unit-testable with fakes (no Tauri runtime, no real IPC). The
 * production bindings live in {@link defaultClipAssemblyDeps}.
 */
export interface ClipAssemblyDeps {
  /** Seal the composed plaintext into a new `MY01` note → its `NoteId`. The
   *  EXISTING `note_create` command (no widened signature, no new ACL entry). */
  readonly noteCreate: (plaintext: string) => Promise<string>;
  /** Import one in-memory clip image's bytes (the task-3 port; real impl =
   *  `attachment_import { kind: "bytes" }`). */
  readonly importImage: ClipImageImporter;
  /** Read-only probe of the unlocked-vault slot (the locked gate). */
  readonly isVaultUnlocked: () => Promise<boolean>;
  /** Load the DECRYPTED resolver note-set DESKTOP-side (the task-4 loader;
   *  real impl = `noteList()` → `loadNoteBatch()` → resolver projection). */
  readonly loadResolverNotes: () => Promise<readonly ResolverNote[]>;
}

/**
 * The compose step's caller-supplied seam: turn the validated envelope + the
 * fully-resolved body into the final note plaintext. DEFAULTS to
 * {@link composeClipPlaintext} (the clip provenance shape — managed-blind
 * `source:`/`url:`/`clipped:`), so every existing clip test + the live clip path
 * is byte-for-byte unchanged. A url-bookmark (sub-feature 5, MYND-447) passes its
 * own composer (managed `title:` + `source:`/`clipped:`, no `url:`) — the ONLY
 * delta from a clip is this function + the content-light body + no images. The
 * routine never branches on `captureKind`; the captureKind decision lives at the
 * CALLER (the dispatch listener).
 */
export type ClipPlaintextComposer = (
  envelope: ValidatedClipEnvelope,
  resolvedBody: string,
) => string;

/**
 * The typed outcome of an assembly pass — what task 6 maps to the host reply
 * (`accepted | error | locked`) and what task 7 reads for the in-app notice.
 *
 *   - `accepted`  — the note was sealed. Carries the new `noteId` (for the
 *     notice's "open" action) and the {@link MediaCounts} (for the
 *     "N images, M omitted" notice copy). Returned ONLY after `noteCreate`
 *     resolves — never optimistically.
 *   - `locked`    — the vault was locked; NOTHING was written.
 *   - `error`     — a validation rejection (task 1) OR a `noteCreate` reject
 *     (e.g. `PlaintextTooLarge` for an oversize composed body). The `reason`
 *     is the validation rejection literal or the note-create error `kind`.
 */
export type ClipIngestResult =
  | {
      readonly kind: "accepted";
      readonly noteId: string;
      readonly counts: MediaCounts;
      /** Ingest-time image compression performed while sealing this clip —
       *  carried out to task 7's notice so a clipped image discloses on the
       *  same terms a pasted one does (`decisions.md` 2026-07-30). */
      readonly compression: CompressionTally;
    }
  | { readonly kind: "locked" }
  | { readonly kind: "error"; readonly reason: ClipAssemblyErrorReason };

/**
 * The closed taxonomy of `error`-class reasons: a boundary-validation rejection
 * (task 1's {@link ClipEnvelopeRejection}) OR a `note_create` failure `kind`
 * (`src/types/note-create-error.ts` — e.g. `"PlaintextTooLarge"`). Kept as a
 * string union so task 6 can map any reason to the host reply without a second
 * enum to maintain.
 */
export type ClipAssemblyErrorReason = ClipEnvelopeRejection | string;

/**
 * Recover the error `kind` from a `noteCreate` rejection so it can ride into the
 * `{ kind: "error" }` result. `note_create` rejects with a `NoteCreateError`
 * (`{ kind: "...", detail?: ... }`); we surface the `kind` literal (e.g.
 * `"PlaintextTooLarge"`). An unexpected non-shaped throw falls back to a generic
 * marker — the routine NEVER lets a seal failure leak as a thrown exception.
 */
function noteCreateErrorReason(err: unknown): string {
  if (
    typeof err === "object" &&
    err !== null &&
    "kind" in err &&
    typeof (err as { kind: unknown }).kind === "string"
  ) {
    return (err as { kind: string }).kind;
  }
  return "NoteCreateFailed";
}

/**
 * THE shared assembly routine — drive a raw clip handoff through tasks 1–4 and
 * seal it into a new root note, returning the typed {@link ClipIngestResult}.
 *
 * @param envelope the RAW (hostile, un-validated) clip envelope the host relayed
 *   into ingest. Validated at step (2); never trusted before that.
 * @param body the markdown body to ingest — the CALLER-SUPPLIED parameterization
 *   point (the bookmark seam, sub-feature 5). For `full-article` / `selection`
 *   pass `envelope.markdownBody`; a url-bookmark passes its own content-light body.
 * @param deps the injectable IPC seams. Pass {@link defaultClipAssemblyDeps} in
 *   production; tests pass fakes.
 * @param composePlaintext the OPTIONAL compose-step seam (defaults to the clip
 *   composer {@link composeClipPlaintext}). A url-bookmark passes its own composer;
 *   the clip path leaves it defaulted, so it is byte-for-byte unchanged.
 * @returns the typed result (`accepted` only after the seal resolves).
 */
export async function assembleClip(
  envelope: RawClipEnvelope,
  body: string,
  deps: ClipAssemblyDeps,
  composePlaintext: ClipPlaintextComposer = composeClipPlaintext,
): Promise<ClipIngestResult> {
  // (1) LOCKED GATE — first, before any write. A locked vault drops the clip;
  //     nothing is buffered to disk, `noteCreate` is never reached.
  if (!(await deps.isVaultUnlocked())) {
    return { kind: "locked" };
  }

  // (2) VALIDATE the envelope (task 1). A typed rejection maps to `error`.
  const validated = validateClipEnvelope(envelope);
  if (validated.kind === "err") {
    return { kind: "error", reason: validated.reason };
  }

  // (3) INGEST IMAGES (task 3) — splice form-C embeds into the body, degrade
  //     residuals, tally `MediaCounts`. The image source is the VALIDATED
  //     envelope's in-memory bytes (path-traversal-checked filenames).
  const imageResult = await ingestClipImages(
    body,
    validated.envelope.imageBytes,
    deps.importImage,
  );

  // (4) RESOLVE outbound wikilinks (task 4) over the image-spliced body —
  //     BEFORE compose so the wikilink pass sees only body bytes (never the
  //     provenance frontmatter). See the resolve-vs-compose rationale above.
  const resolvedBody = await resolveClipWikilinks(
    imageResult.body,
    deps.loadResolverNotes,
  );

  // (5) COMPOSE provenance frontmatter + the resolved body → the final ROOT-note
  //     plaintext. The composer is the caller-supplied seam (defaulting to the
  //     clip composer); a url-bookmark swaps ONLY this function (the routine never
  //     branches on captureKind — that decision lives at the caller).
  const plaintext = composePlaintext(validated.envelope, resolvedBody);

  // (6) SEAL via the EXISTING `noteCreate`. The 16 MiB composed-body cap is
  //     enforced Rust-side; a `PlaintextTooLarge` (or any other) reject maps to
  //     `error` — NO half-saved note, NO optimistic ack.
  let noteId: string;
  try {
    noteId = await deps.noteCreate(plaintext);
  } catch (err) {
    return { kind: "error", reason: noteCreateErrorReason(err) };
  }

  // (7) ACCEPTED — only now that the seal resolved. Carries the new id + counts.
  return {
    kind: "accepted",
    noteId,
    counts: imageResult.counts,
    compression: imageResult.compression,
  };
}

/**
 * The DEFAULT resolver-note-set loader (task 4's real port): load the live note
 * id list, decrypt the batch, and project each {@link TitleRecord} to a
 * {@link ResolverNote} through the SAME `resolverNotesFromCache` projection every
 * reader surface uses — so trash / template exclusion (SYNC-1) can never drift
 * between the clip path and the rest of the app. Reuses the importer's
 * `loadExistingIdentity` shape (`noteList()` → `loadNoteBatch()` → project).
 *
 * The decrypted note graph is read DESKTOP-side only (SYNC-11) — it is never
 * requested from or sent to the browser.
 */
async function loadDefaultResolverNotes(): Promise<readonly ResolverNote[]> {
  const ids = await noteList();
  const records = await loadNoteBatch(ids);
  // `resolverNotesFromCache` keys on a `Map<NoteId, TitleRecord>` (it applies the
  // resolver-cache trash/template exclusion internally), so re-key the batch.
  const cache = new Map<string, TitleRecord>(
    records.map((r) => [r.noteUuid, r] as const),
  );
  return resolverNotesFromCache(cache);
}

/**
 * The production wiring: the real IPC ports bound to {@link assembleClip}'s
 * injectable seams. Built lazily as a function so a caller (task 6's host reply
 * mapper) gets a fresh deps object, and tests never accidentally reach a real
 * port. NO new command and NO new capability ACL entry is introduced — every
 * port here is an EXISTING one (`note_create`, `attachment_import`,
 * `vault_is_unlocked`, `note_list` + `note_titles_batch`).
 */
export function defaultClipAssemblyDeps(): ClipAssemblyDeps {
  return {
    // `null`, and that is a decision rather than an omission (myne-md/myne#613).
    // A clipped note is filed at the vault root: `buildClipPlaintext` writes no
    // `folder:`, so there is no folder for the create to register. Decision 0541
    // names the clipper as one of the routes a foldered note can arrive by; that
    // is about a note the clipper's own frontmatter could carry, and today it
    // carries none. If clipping ever gains a destination folder, this argument is
    // where it has to be threaded, and the compiler will not let it be forgotten.
    noteCreate: (plaintext) => noteCreate(plaintext, null),
    // Real task-3 port: `attachment_import { kind: "bytes" }` via the shipped
    // `importOne` (which re-sniffs MIME, enforces the 64 MiB per-image cap, and
    // content-addresses). `importOne` already folds any reject into a typed
    // `ImportOutcome`; narrow it to the `ClipImageImporter` contract (the
    // `reason` on the failure arm is irrelevant to the degrade — task 3 omits
    // on any `{ ok: false }`).
    importImage: async (image) => {
      const outcome = await importOne({
        kind: "bytes",
        bytes: Array.from(image.bytes),
        filename: image.filename,
      });
      return outcome.ok
        ? { ok: true as const, attachment: outcome.attachment }
        : { ok: false as const };
    },
    isVaultUnlocked: () => isVaultUnlocked(),
    loadResolverNotes: () => loadDefaultResolverNotes(),
  };
}
