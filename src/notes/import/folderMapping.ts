// Obsidian importer — folder leg of the path→note mapping.
//
// Sub-feature 1 of the obsidian-importer epic (MYND-51), task 1. Pure,
// in-memory TS — no IPC, no Rust. The external directory read goes through
// sub-feature 3's Rust seam (`import_read_dir` / `import_read_file`); this
// module only transforms already-read plaintext.
//
// Maps a file's Obsidian-relative path to the canonical trailing-slash
// `folder:` value (markdown-dialect §3.6.2) and injects ONLY that field into
// the imported body via the shipped `patchFolderField` surgery — every other
// body byte is preserved verbatim (C1 / SYNC-9). A vault-root file gets no
// `folder:` field at all (root = the absence of the field, §3.6.2).
//
// Note on the primitive: `createNote(folder)` uses `buildInitialPlaintext`,
// which only composes an *empty*-body note. The importer carries a real
// imported body (often with its own frontmatter), so it uses `patchFolderField`
// — the A/B/C-state-aware writer for the same `folder:` FM slot — to add the
// field without rewriting the body. For an empty body the two are equivalent.

import { patchFolderField } from "../../dialect/surgery";
import { normalizeFolderPath } from "../../dialect/folderPath";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/**
 * Derive the canonical trailing-slash `folder:` value from a file's
 * Obsidian-relative path, or `null` for a vault-root file. Structural
 * normalization only (via `normalizeFolderPath`): duplicate / leading /
 * trailing slashes are tolerated and collapsed. Segments are NOT grammar-
 * validated here — illegal-segment flagging is task 3 (the provenance-split
 * rule keeps imported bytes intact, never sanitized).
 */
export function deriveImportFolder(relativePath: string): string | null {
  const lastSlash = relativePath.lastIndexOf("/");
  const parentRaw = lastSlash === -1 ? "" : relativePath.slice(0, lastSlash);
  return normalizeFolderPath(parentRaw);
}

/**
 * Inject the derived `folder:` field into an imported note's body, preserving
 * every other byte (C1). A root file (`folder === null`) returns the body
 * unchanged — no FM block is injected. For an empty body this matches
 * `buildInitialPlaintext(folder)` exactly.
 */
export function injectImportFolder(body: string, folder: string | null): string {
  if (folder === null) return body;
  return utf8Decoder.decode(patchFolderField(utf8Encoder.encode(body), folder));
}

/**
 * Folder leg of the importer mapping: derive the folder from `relativePath`
 * and inject it into `body`. The title leg (filename→title read-time default,
 * with NO `title:` injection) is task 2; the full
 * `(relativePath, frontmatter) → { plaintext, illegalFlags }` mapping is task 3.
 */
export function composeImportedFolderPlaintext(
  relativePath: string,
  body: string,
): string {
  return injectImportFolder(body, deriveImportFolder(relativePath));
}
