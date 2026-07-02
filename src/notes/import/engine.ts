// Obsidian importer — the engine (walk → assemble → serial ingest).
//
// Sub-feature 3 of the obsidian-importer epic (MYND-53), tasks 3 + 4 + 5.
//
// A two-phase, serial, cancellable importer that ties together every sibling
// sub-feature's pure logic:
//   - Phase 1 walks directory ENTRIES only (no file content) via the Rust
//     read-seam, classifying each entry with the SYNC-10 predicate
//     (sub-feature 5): dot-prefixed entries are skipped (transparency count),
//     non-dot directories are recursed, only `.md` files are queued for ingest,
//     `.canvas` / other non-`.md` go to their skip buckets. It also records
//     every directory for empty-dir detection (SYNC-4).
//   - Phase 2 ingests the queued `.md` files SERIALLY (D3 — one file in RAM at a
//     time; SYNC-1 no-plaintext-to-disk: only `note_create` writes, encrypted).
//     For each file: `mapImportedFile` (sub-feature 1) produces the plaintext +
//     read-time title + illegal-segment flags + any pre-existing-`folder:` note;
//     `decideImport` (sub-feature 2) applies the SYNC-5 idempotent skip / copy
//     toggle before `note_create`; cancellation (SYNC-6) stops the walk and
//     keeps the partial import (no rollback).
// At end-of-import, the empty source dirs are persisted with ONE
// `set_deliberate_folders` write (SYNC-4).
//
// IO is injected as `ImportPorts` so the engine is unit-testable without Tauri;
// the production factory wires the ports to the `importer:` read-seam, the
// `notes:note_create` command, and the `prefs:set_deliberate_folders` command.
// The engine itself never touches AEAD/magic/identifiers (delegated to
// `note_create`) and never runs the dialect parser worker for ingest —
// `mapImportedFile` reads frontmatter directly and the body is preserved
// verbatim (C1), so a separate worker parse is not load-bearing here.

import { classifyEntry, emptyIgnoreCounts, type IgnoreCounts } from "./skipPredicate";
import {
  mapImportedFile,
  type IllegalSegmentFlag,
  type PreexistingFolder,
} from "./mapping";
import { deriveImportFolder } from "./folderMapping";
import { decideImport, noteIdentityKey, type DuplicatePolicy } from "./conflict";
import { collectDeliberateImportFolders } from "./emptyDirs";
import {
  processImportedMedia,
  emptyMediaByType,
  type MediaCounts,
  type MediaByType,
  type RefImporter as MediaRefImporter,
} from "./media";

/** One external directory entry — mirrors the Rust `ImportDirEntry`. */
export interface ImportDirEntry {
  name: string;
  isDir: boolean;
}

/** Injected IO ports (Tauri commands in production; fakes in tests). */
export interface ImportPorts {
  /** List a directory's entries (name + isDir, no content). */
  readDir(absPath: string): Promise<ImportDirEntry[]>;
  /** Read a file's UTF-8 source bytes. */
  readFile(absPath: string): Promise<string>;
  /** Encrypt + write one note; returns its id. */
  createNote(plaintext: string): Promise<string>;
  /** Persist the importer's empty-dir folders (the impl unions with existing prefs). */
  setDeliberateFolders(folders: readonly string[]): Promise<void>;
}

/** Tally for a `.base` saved-views import (Saved Views #6, MYND-276, SYNC-12).
 *  An OPTIONAL sub-field of {@link ImportResult} — the vault `.md` walk leaves it
 *  unset; the `.base` bridge populates it. Counts what crossed and what was
 *  dropped so the trigger UI (#4) can show an honest import summary. */
export interface BaseImportTally {
  /** Views that mapped successfully and will be persisted. */
  importedViews: number;
  /** Views skipped whole — unsupported `type` (e.g. `map`) OR an entire-filter
   *  drop (SYNC-12). */
  skippedViews: number;
  /** Individual filter clauses dropped (unsupported operator/function/`file.*`,
   *  SYNC-7/9) across all imported views. */
  droppedUnsupportedFilters: number;
  /** Top-level `formulas` entries dropped (no formula engine, SYNC-5). */
  droppedFormulas: number;
  /** Top-level `summaries` entries dropped (no summary engine, SYNC-5). */
  droppedSummaries: number;
  /** Top-level `properties` display-config entries dropped (cosmetic, SYNC-5). */
  droppedPropertiesDisplay: number;
}

export interface ImportResult {
  imported: number;
  skippedExisting: number;
  illegalFlags: IllegalSegmentFlag[];
  preexistingFolders: PreexistingFolder[];
  ignore: IgnoreCounts;
  /** Media ingested vs omitted, by type (SYNC-7 / SYNC-2); zeros if no media importer. */
  media: MediaCounts;
  emptyFoldersPreserved: number;
  /** Remaining (un-ingested) `.md` count if cancelled mid-walk; `null` if completed. */
  cancelled: number | null;
  /** Total `.md` files discovered (the N in "Importing X of N"). */
  total: number;
  /** `.base` saved-views import tally — present only on a `.base` import flow
   *  (MYND-276); the `.md` vault walk leaves it `undefined`. */
  baseImport?: BaseImportTally;
}

export interface ImportOptions {
  onProgress?: (done: number, total: number) => void;
  shouldCancel?: () => boolean;
  /** Resolve+import a media ref (SYNC-7 hybrid auto-ingest). When omitted, media
   *  refs are left untouched and the media counts stay zero. */
  importMedia?: MediaRefImporter;
}

function addByType(into: MediaByType, from: MediaByType): void {
  into.image += from.image;
  into.pdf += from.pdf;
  into.audio += from.audio;
  into.video += from.video;
  into.other += from.other;
}

function joinPath(root: string, rel: string): string {
  return rel.length === 0 ? root : `${root}/${rel}`;
}

/**
 * Import an Obsidian vault rooted at `root` (the user-picked absolute path).
 * `existingIdentity` is the live-vault `(folder,title)` identity set
 * (`buildExistingIdentitySet`); `policy` is the global skip / import-as-copy
 * toggle. Pure orchestration over the injected `ports`.
 */
export async function importVault(
  root: string,
  ports: ImportPorts,
  existingIdentity: ReadonlySet<string>,
  policy: DuplicatePolicy,
  options: ImportOptions = {},
): Promise<ImportResult> {
  // ----- Phase 1: walk entries (no content) — classify + collect -----
  const mdFiles: string[] = [];
  const allDirs: string[] = [];
  const ignore = emptyIgnoreCounts();

  const walk = async (relDir: string): Promise<void> => {
    const entries = await ports.readDir(joinPath(root, relDir));
    for (const entry of entries) {
      const cls = classifyEntry(entry.name);
      const rel = relDir.length === 0 ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDir) {
        if (cls === "hidden-ignored") {
          ignore.hiddenIgnored++; // dot-dir (`.obsidian/`, `.git/`, …) — skipped
          continue;
        }
        allDirs.push(rel); // non-dot dir → recurse (its classification is moot)
        await walk(rel);
      } else if (cls === "import-as-note") {
        mdFiles.push(rel);
      } else if (cls === "canvas-skipped") {
        ignore.canvasSkipped++;
      } else if (cls === "non-markdown-skipped") {
        ignore.nonMarkdownSkipped++;
      } else {
        ignore.hiddenIgnored++; // dot-prefixed file (incl. the `.foo.md` edge)
      }
    }
  };
  await walk("");

  // ----- Phase 2: serial ingest -----
  const total = mdFiles.length;
  const seen = new Set(existingIdentity); // also dedups within this run
  const illegalFlags: IllegalSegmentFlag[] = [];
  const preexistingFolders: PreexistingFolder[] = [];
  const noteFolders: (string | null)[] = [];
  const media: MediaCounts = { ingested: emptyMediaByType(), omitted: emptyMediaByType() };
  let imported = 0;
  let skippedExisting = 0;
  let cancelled: number | null = null;

  for (let i = 0; i < mdFiles.length; i++) {
    if (options.shouldCancel?.()) {
      cancelled = total - i; // keep the partial import — no rollback (SYNC-6)
      break;
    }
    const rel = mdFiles[i]!;
    const rawText = await ports.readFile(joinPath(root, rel));
    const mapped = mapImportedFile(rel, rawText);
    illegalFlags.push(...mapped.illegalFlags);
    if (mapped.preexistingFolder !== null) {
      preexistingFolders.push(mapped.preexistingFolder);
    }

    const folder = deriveImportFolder(rel);
    // Dedup identity must key on the folder the note is ACTUALLY persisted under.
    // A file carrying its own `folder:` FM field is stored there (mapping.ts keeps
    // it byte-for-byte) and the live identity-set keys on that real folder — so
    // keying dedup on the path-derived folder misses the match and re-creates the
    // note on every re-import (SYNC-5 idempotency break). Both sides run through
    // noteIdentityKey → folderKey → normalizeFolderPath (idempotent), so passing
    // the raw FM value here is enough (no extra normalization needed).
    const identityFolder = mapped.preexistingFolder?.existing ?? folder;
    if (decideImport(seen, identityFolder, mapped.readTimeTitle, policy) === "skip") {
      skippedExisting++;
    } else {
      // Media is processed only for notes we actually create, on the
      // folder-injected plaintext (the `folder:` FM carries no media refs).
      let plaintext = mapped.plaintext;
      if (options.importMedia) {
        const m = await processImportedMedia(plaintext, options.importMedia);
        plaintext = m.body;
        addByType(media.ingested, m.counts.ingested);
        addByType(media.omitted, m.counts.omitted);
      }
      await ports.createNote(plaintext);
      imported++;
      noteFolders.push(folder); // empty-dir collection stays path-derived
      seen.add(noteIdentityKey(identityFolder, mapped.readTimeTitle));
    }
    options.onProgress?.(i + 1, total);
  }

  // ----- SYNC-4: one deliberate-folders write for empty source dirs -----
  const deliberate = collectDeliberateImportFolders(allDirs, noteFolders);
  if (deliberate.length > 0) {
    await ports.setDeliberateFolders(deliberate);
  }

  return {
    imported,
    skippedExisting,
    illegalFlags,
    preexistingFolders,
    ignore,
    media,
    emptyFoldersPreserved: deliberate.length,
    cancelled,
    total,
  };
}
