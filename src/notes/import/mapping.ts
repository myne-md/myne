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
export function mapImportedFile(
  relativePath: string,
  rawText: string,
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
  if (fmTitle === null) {
    plaintext = utf8Decoder.decode(
      patchTitleField(utf8Encoder.encode(plaintext), readTimeTitle),
    );
  }
  const preexistingFolder: PreexistingFolder | null = hasPreexistingFolder
    ? { existing: String((fm as Record<string, unknown>)["folder"]), derivedFromPath: folder }
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
