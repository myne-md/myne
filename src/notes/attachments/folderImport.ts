// Import a directory tree into the attachment library (myne-md/myne#1075).
//
// The case: a term's lecture notes arrive as a folder of PDFs and slides, and a
// person wants them in the vault as one act rather than four hundred drags.
//
// # Why the walk is here rather than in Rust
//
// The path-validating read seam already exists (`import_read_dir`), it already
// refuses a symlink that leaves the picked root, and it already grants no
// general filesystem capability. A Rust walker would be a second implementation
// of that validation, which is the one thing this repository refuses to do with
// a security boundary. So the walk is TS over the seam, and the only Rust it
// touches is the per-file import that already shipped.
//
// # What is skipped, and why the count is honest
//
// Supported types are decided by the IMPORT, not by a second allowlist here: a
// file the importer refuses is counted as skipped with the reason it gave. A
// copy of the allowlist in this file is a copy that drifts, and it would drift
// silently in the direction of promising a file the vault cannot hold.
//
// One failure never aborts the batch. A folder with one corrupt PDF still
// imports the other three hundred, which is what "skip and report" means.

import {
  attachmentImport,
  attachmentSetFolders,
  type AttachmentFolderAssignment,
} from "../../lib/attachments";
import { importReadDir } from "../import/ports";
import { joinPath } from "../import/source";

/** What one import produced, for the sentence the surface shows afterwards. */
export interface FolderImportSummary {
  /** Files the catalog now holds. */
  imported: number;
  /** Files that were already in the catalog under the same bytes. */
  deduplicated: number;
  /** Files the importer refused, with the reason it gave, counted by reason. */
  skipped: Readonly<Record<string, number>>;
  /** True when the person cancelled, so the surface does not claim completion. */
  cancelled: boolean;
}

/** Knobs a caller supplies; all optional so a test can drive it with none. */
export interface FolderImportOptions {
  /** Called after each file, so a surface can show progress. */
  onProgress?: (done: number, total: number, current: string) => void;
  /** Asked before each file; returning true stops the walk. */
  shouldCancel?: () => boolean;
  /**
   * The vault folder each imported file is filed into, given its path RELATIVE
   * to the picked root (`Hafta 3/slides.pdf`). Default: the root.
   *
   * A function rather than a string because a term's tree is the point: the
   * week subfolders should become the same subfolders in the library, or the
   * import produces four hundred files in one place.
   */
  folderFor?: (relativePath: string) => string;
}

/** The depth ceiling. A pathological tree is a hang, not a feature. */
const MAX_DEPTH = 12;

/** Directories never worth walking into, by the conventions every OS shares. */
const SKIP_DIRS = new Set([".git", "node_modules", ".DS_Store", "__MACOSX"]);

/**
 * Walk `root` and import every file the vault will take.
 *
 * Recursive, skip-and-report, cancellable, and idempotent in the sense that
 * matters: re-running it on the same folder deduplicates by content, so a
 * second import of a tree that changed in one file adds one file.
 */
export async function importFolderTree(
  root: string,
  options: FolderImportOptions = {},
): Promise<FolderImportSummary> {
  const files: { abs: string; rel: string }[] = [];
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    const entries = await importReadDir(root, dir);
    for (const entry of entries) {
      if (options.shouldCancel?.()) return;
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDir) {
        if (SKIP_DIRS.has(entry.name)) continue;
        // A link that leaves the root or loops is not followed: the seam already
        // says so, and walking it anyway is the traversal this avoids.
        if (entry.link !== null) continue;
        await walk(joinPath(dir, entry.name), childRel, depth + 1);
        continue;
      }
      if (entry.link !== null) continue;
      files.push({ abs: joinPath(dir, entry.name), rel: childRel });
    }
  };

  await walk(root, "", 0);

  let imported = 0;
  let deduplicated = 0;
  const placements: AttachmentFolderAssignment[] = [];
  const skipped: Record<string, number> = {};
  const countSkip = (reason: string) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  for (const [index, file] of files.entries()) {
    if (options.shouldCancel?.()) {
      return { imported, deduplicated, skipped, cancelled: true };
    }
    options.onProgress?.(index, files.length, file.rel);
    try {
      const result = await attachmentImport({ kind: "path", path: file.abs });
      if (result.deduplicated) {
        // A file the vault already held keeps the folder it was filed in. It was
        // theirs before this import, and re-filing it would move a file the
        // person had already placed.
        deduplicated += 1;
      } else {
        imported += 1;
        const folder = options.folderFor?.(file.rel);
        if (folder !== undefined) placements.push({ id: result.id, folder });
      }
    } catch (error) {
      // The importer's own reason, never a guess: `UnsupportedType`,
      // `Oversize`, `Io`, or whatever it decides to add next.
      const kind =
        typeof error === "object" && error !== null && "kind" in error
          ? String((error as { kind: unknown }).kind)
          : "Unknown";
      countSkip(kind);
    }
  }

  // One write for the whole tree rather than one per file: the command takes a
  // batch precisely so a four hundred file import is one catalog write.
  if (placements.length > 0) {
    try {
      await attachmentSetFolders(placements);
    } catch {
      // The files are in the vault either way; they are simply unfiled. The
      // caller's sentence says so rather than claiming a clean import.
      countSkip("FolderNotApplied");
    }
  }

  options.onProgress?.(files.length, files.length, "");
  return { imported, deduplicated, skipped, cancelled: false };
}
