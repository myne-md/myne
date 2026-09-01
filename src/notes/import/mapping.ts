// Obsidian importer — the unified per-file mapping seam.
//
// Sub-feature 1 of the obsidian-importer epic (MYND-51), task 3 (story 14).
//
// One pure, non-throwing, non-blocking function turns a single imported file
// into its Myne note plaintext + the metadata the engine (sub-feature 3) needs:
//   - `plaintext`      : original body + the injected Myne-managed fields —
//                        `folder:` (directory-derived) and, when the file has no
//                        FM `title:`, `title:` (filename-derived). Every other
//                        byte preserved (C1 — the SYNC-9 sanctioned-transform
//                        allowlist).
//   - `readTimeTitle`  : FM `title:` or filename-derived — the value injected
//                        into `title:` (when absent) + the identity key
//                        (sub-feature 2) + summary
//   - `illegalFlags`   : segments illegal under the Myne grammar, PRESERVED
//                        byte-for-byte and surfaced in the post-import
//                        "needs attention" report (SYNC-3) — never sanitized,
//                        never skipped, never blocking.
//   - `preexistingFolder` : set when the imported file ALREADY carried its own
//                        `folder:` field. Obsidian has no `folder:` convention,
//                        but a vault may legitimately carry the key; overwriting
//                        it would be a silent rewrite (C1). We preserve the file
//                        byte-for-byte and surface the directory-vs-frontmatter
//                        discrepancy for the user to reconcile.
//
// Keeping all of this behind one pure function lets the engine stay a thin
// walk-and-ingest loop.

import { parseFrontmatter } from "../../dialect/visitors/frontmatter";
import {
  folderKey,
  isLegalSegment,
  isLegalPathLength,
  utf8ByteLength,
  MAX_SEGMENT_BYTES,
} from "../../dialect/folderPath";
import { patchTitleField } from "../../dialect";
import { deriveImportFolder, injectImportFolder } from "./folderMapping";
import { deriveImportTitle } from "./titleMapping";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

export type IllegalSegmentReason =
  | "illegal-char"
  | "segment-too-long"
  | "path-too-long";

export interface IllegalSegmentFlag {
  /** The offending segment (or derived path), verbatim — never mutated. */
  segment: string;
  /** Whether the flag came from a folder segment or the note title. */
  kind: "folder" | "title";
  /** The file's Obsidian-relative path, for the needs-attention row. */
  relativePath: string;
  reason: IllegalSegmentReason;
}

/** The imported file already had its own `folder:` field — preserved, not overwritten. */
export interface PreexistingFolder {
  /** The file's own `folder:` value, kept byte-for-byte. */
  existing: string;
  /** The folder the directory structure would otherwise have produced. */
  derivedFromPath: string | null;
}

export interface ImportedFileMapping {
  plaintext: string;
  readTimeTitle: string;
  illegalFlags: IllegalSegmentFlag[];
  preexistingFolder: PreexistingFolder | null;
}

function segmentReason(segment: string): IllegalSegmentReason | null {
  if (utf8ByteLength(segment) > MAX_SEGMENT_BYTES) return "segment-too-long";
  if (!isLegalSegment(segment)) return "illegal-char";
  return null;
}

/**
 * Map one imported Obsidian file to its Myne note plaintext + metadata. Pure,
 * never throws. Illegal segments are preserved byte-for-byte and returned as
 * flags; a pre-existing `folder:` field is preserved (never overwritten — C1)
 * and surfaced via `preexistingFolder`. The caller decides how to surface both
 * in the post-import "needs attention" report; it never blocks the walk.
 */
/** Per-source knobs for {@link mapImportedFile}. */
export interface MapImportedFileOptions {
  /**
   * Inject the filename-derived title when the file has no frontmatter
   * `title:`. Defaults to `true`, which is the Obsidian-shaped assumption every
   * path-based source relies on: the filename IS the note's name there.
   *
   * `false` for a source whose filenames carry no name. Its notes then land
   * Untitled exactly as they were in the source, which is the honest outcome
   * and the one the identity layer handles by content hash instead.
   */
  readonly titleFromFilename?: boolean;
}

export function mapImportedFile(
  relativePath: string,
  rawText: string,
  options: MapImportedFileOptions = {},
): ImportedFileMapping {
  const fm = parseFrontmatter(rawText).parsed as Record<string, unknown> | null;
  const fmTitle = typeof fm?.["title"] === "string" ? (fm["title"] as string) : null;
  const readTimeTitle = deriveImportTitle(relativePath, fmTitle);
  const folder = deriveImportFolder(relativePath);

  // C1: never overwrite a `folder:` field the imported file authored itself.
  const hasPreexistingFolder = fm != null && "folder" in fm;
  let plaintext = hasPreexistingFolder
    ? rawText // preserve byte-for-byte
    : injectImportFolder(rawText, folder);

  // Title injection (SYNC-9 sanctioned transform). Obsidian takes a note's title
  // from its filename, but Myne is frontmatter-only-title — so a file with no FM
  // `title:` would land "Untitled". Materialize the filename-derived title into
  // the Myne-managed `title:` field (via the same surgery as create/rename),
  // verbatim — even an illegal value is preserved + flagged below, never
  // sanitized. A pre-existing FM `title:` wins and is left untouched. Composes
  // with the `folder:` injection above (each patcher touches only its own line).
  //
  // A source whose filenames are NOT names opts out (`titleFromFilename:
  // false`). The Myne vault source is the case that forced the option: its
  // filenames are note UUIDs, so injecting one would title the note `019…` hex
  // rather than leave it Untitled, and "Untitled" is what the source actually
  // says. `conflict.ts` used to assert that a title-less note "is not reachable
  // through this import path"; a Myne source makes it reachable in bulk, which
  // is why the claim is now false and the option exists.
  if (fmTitle === null && options.titleFromFilename !== false) {
    plaintext = utf8Decoder.decode(
      patchTitleField(utf8Encoder.encode(plaintext), readTimeTitle),
    );
  }
  // Equality suppression (SYNC-8, export-suite): a file whose own `folder:`
  // already equals the path-derived folder needs no attention — flagging it
  // would mark every note of a re-imported Myne export tree.
  //
  // "Equals" is `folderKey` — normalize + NFC + case-fold — because that is
  // Myne's ONE folder identity, and the two neighbouring paths in this feature
  // already use it: the engine keys dedup on `noteIdentityKey` → `folderKey`,
  // and the folder tree keys nodes on `foldSegment`. A raw string comparison
  // here made those three disagree, and flagged rows the user cannot act on:
  // `folder: Sub` (no trailing slash), `folder: SUB/` (case) and
  // `_import//folder///Sub//` (duplicate slashes) are all the SAME folder as
  // the derived `Sub/`, filed there correctly, merged into one tree node. A
  // needs-attention list carrying rows with nothing to fix teaches users to
  // dismiss it (myne-md/myne#223).
  const existingFolder = hasPreexistingFolder
    ? String((fm as Record<string, unknown>)["folder"])
    : null;
  const preexistingFolder: PreexistingFolder | null =
    existingFolder !== null && folderKey(existingFolder) !== folderKey(folder)
      ? { existing: existingFolder, derivedFromPath: folder }
      : null;

  const illegalFlags: IllegalSegmentFlag[] = [];

  // Folder-derived flags only describe what we WOULD inject — skip them when we
  // preserved the file's own `folder:` (the derived folder is unused for it).
  if (!hasPreexistingFolder) {
    const folderSegments =
      folder === null ? [] : folder.split("/").filter((s) => s.length > 0);
    for (const seg of folderSegments) {
      const reason = segmentReason(seg);
      if (reason !== null) {
        illegalFlags.push({ segment: seg, kind: "folder", relativePath, reason });
      }
    }
    // The derived virtual wikilink-target path (folder + title + `.md`) has its
    // own PATH_MAX cap (§3.6.2). Over-cap is a flag, never a hard error.
    const derivedPath = (folder ?? "") + readTimeTitle + ".md";
    if (!isLegalPathLength(derivedPath)) {
      illegalFlags.push({
        segment: derivedPath,
        kind: "title",
        relativePath,
        reason: "path-too-long",
      });
    }
  }

  const titleReason = segmentReason(readTimeTitle);
  if (titleReason !== null) {
    illegalFlags.push({
      segment: readTimeTitle,
      kind: "title",
      relativePath,
      reason: titleReason,
    });
  }

  return { plaintext, readTimeTitle, illegalFlags, preexistingFolder };
}

/**
 * Write `title` into the note's Myne-managed `title:` field.
 *
 * The same surgery create and rename use, exported so the engine can apply a
 * source's RENAME decision without keeping a second encoder pair. It is
 * deliberately the same call the filename-injection above makes: a renamed note
 * must be renamed in its own bytes, not merely reported as renamed, or the
 * identity set and the note disagree the moment the import ends.
 */
export function applyTitle(markdown: string, title: string): string {
  return utf8Decoder.decode(patchTitleField(utf8Encoder.encode(markdown), title));
}
