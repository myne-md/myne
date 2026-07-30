// Importer — the engine (plan → serial ingest).
//
// Sub-feature 3 of the obsidian-importer epic (MYND-53), tasks 3 + 4 + 5.
// Generalized to any source by the importer-breadth epic (MYND-579).
//
// A two-stage, serial, cancellable importer that ties together every sibling
// sub-feature's pure logic:
//   - Stage 1 asks the `ImportSource` for a PLAN — item descriptors (no note
//     content), the directories seen for empty-dir detection (SYNC-4), and the
//     SYNC-10 skip tallies. For Obsidian that is the old directory walk, now in
//     `sources/obsidian.ts`. See `source.ts` for why this is a plan+load pair
//     rather than one async generator (D3 vs a determinate `total`).
//   - Stage 2 ingests the planned items SERIALLY (D3 — one item's markdown in RAM
//     at a time; SYNC-1 no-plaintext-to-disk: only `note_create` writes,
//     encrypted). For each item: `source.load()` yields the markdown;
//     `mapImportedFile` (sub-feature 1) produces the plaintext + read-time title +
//     illegal-segment flags + any pre-existing-`folder:` note; `decideImport`
//     (sub-feature 2) applies the SYNC-5 idempotent skip / copy toggle before
//     `note_create`; cancellation (SYNC-6) stops the run and keeps the partial
//     import (no rollback).
// At end-of-import, the empty source dirs are persisted with ONE
// `set_deliberate_folders` write (SYNC-4).
//
// Reads come from an injected `ImportSource`, writes from an injected `ImportSink`,
// so the engine is unit-testable without Tauri; the production factory wires the
// Obsidian source to the `importer:` read-seam and the sink to `notes:note_create`
// + `prefs:set_deliberate_folders`. The engine itself never touches
// AEAD/magic/identifiers (delegated to `note_create`) and never runs the dialect
// parser worker for ingest — `mapImportedFile` reads frontmatter directly and the
// body is preserved verbatim (C1), so a separate worker parse is not load-bearing
// here.
//
// ONE INGEST PATH IS LOAD-BEARING. Every source funnels through the single loop
// below, which is why per-note lossy data has exactly one collection point
// (`ImportResult.lossyNotes`, consumed by the import-report note, MYND-585) rather
// than one per adapter.

import { type IgnoreCounts } from "./skipPredicate";
import { createObsidianSource } from "./sources/obsidian";
import type {
  ImportPorts,
  ImportSink,
  ImportSource,
  LossyNote,
} from "./source";
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
import {
  addCompressionTally,
  emptyCompressionTally,
  type CompressionTally,
} from "../../editor/attachments/insert";

// `ImportDirEntry` / `ImportPorts` now live on the seam (`source.ts`) so adapters
// depend on the seam alone; re-exported here because every shipped caller and test
// imports them from the engine.
export type { ImportDirEntry, ImportPorts } from "./source";

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
  /** How many ingested images ingest-time compression shrank, and by how much.
   *  An import runs through the same shared-core transform a paste does, so the
   *  import summary owes the same disclosure the paste toast gives
   *  (`decisions.md` 2026-07-30) — a bulk route is where silently discarding
   *  pixels would be least noticed, not most excusable. Zeros if no media
   *  importer, or if nothing compressed. */
  compression: CompressionTally;
  emptyFoldersPreserved: number;
  /** Remaining (un-ingested) `.md` count if cancelled mid-walk; `null` if completed. */
  cancelled: number | null;
  /** Total `.md` files discovered (the N in "Importing X of N"). */
  total: number;
  /** `.base` saved-views import tally — present only on a `.base` import flow
   *  (MYND-276); the `.md` vault walk leaves it `undefined`. */
  baseImport?: BaseImportTally;
  /**
   * Notes that imported successfully but lost representable detail (MYND-579).
   * Always present; empty for a lossless source like Obsidian `.md`. This is the
   * ONE collection point for per-note fidelity loss — the generated import-report
   * note (MYND-585) is its only consumer. Deliberately NOT per-construct counters:
   * HTML→markdown loss is pervasive inside notes that still count as imported, so
   * there is no honest integer to tally.
   */
  lossyNotes: LossyNote[];
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

/**
 * Import every note a source offers. `existingIdentity` is the live-vault
 * `(folder,title)` identity set (`buildExistingIdentitySet`); `policy` is the
 * global skip / import-as-copy toggle. Pure orchestration over the injected
 * `source` (reads) and `sink` (writes).
 */
export async function importFromSource(
  source: ImportSource,
  sink: ImportSink,
  existingIdentity: ReadonlySet<string>,
  policy: DuplicatePolicy,
  options: ImportOptions = {},
): Promise<ImportResult> {
  // ----- Stage 1: plan (descriptors only, never note content) -----
  const plan = await source.plan();
  const { items, dirs: allDirs, ignore } = plan;

  // ----- Stage 2: serial ingest (D3 — one item's markdown live at a time) -----
  const total = items.length;
  const seen = new Set(existingIdentity); // also dedups within this run
  const illegalFlags: IllegalSegmentFlag[] = [];
  const preexistingFolders: PreexistingFolder[] = [];
  const noteFolders: (string | null)[] = [];
  const media: MediaCounts = { ingested: emptyMediaByType(), omitted: emptyMediaByType() };
  let compression: CompressionTally = emptyCompressionTally();
  const lossyNotes: LossyNote[] = [];
  let imported = 0;
  let skippedExisting = 0;
  let cancelled: number | null = null;

  for (let i = 0; i < items.length; i++) {
    if (options.shouldCancel?.()) {
      cancelled = total - i; // keep the partial import — no rollback (SYNC-6)
      break;
    }
    const ref = items[i]!;
    const rel = ref.relPath;
    const loaded = await source.load(ref);
    // Folded HERE rather than in the created-note branch below, because a source
    // that ingests inside `load()` (Evernote's inline base64 resources) has
    // already stored and already compressed those bytes by the time dedup gets a
    // say — the attachments are in the vault whether or not this note survives.
    // The `importMedia` tally below is the opposite case and folds there for the
    // same reason: nothing is ingested for a note that is skipped.
    if (loaded.compression !== undefined) {
      compression = addCompressionTally(compression, loaded.compression);
    }
    const mapped = mapImportedFile(rel, loaded.markdown);
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
        compression = addCompressionTally(compression, m.compression);
      }
      await sink.createNote(plaintext);
      imported++;
      noteFolders.push(folder); // empty-dir collection stays path-derived
      seen.add(noteIdentityKey(identityFolder, mapped.readTimeTitle));
      // Record fidelity loss only for notes we actually created — a skipped
      // duplicate has no note for the import report to link to.
      if (loaded.lossy.length > 0) {
        lossyNotes.push({
          relPath: rel,
          folder: identityFolder,
          title: mapped.readTimeTitle,
          dropped: loaded.lossy,
        });
      }
    }
    options.onProgress?.(i + 1, total);
  }

  // ----- SYNC-4: one deliberate-folders write for empty source dirs -----
  const deliberate = collectDeliberateImportFolders(allDirs, noteFolders);
  if (deliberate.length > 0) {
    await sink.setDeliberateFolders(deliberate);
  }

  return {
    imported,
    skippedExisting,
    illegalFlags,
    preexistingFolders,
    ignore,
    media,
    compression,
    emptyFoldersPreserved: deliberate.length,
    cancelled,
    total,
    lossyNotes,
  };
}

/**
 * Import an Obsidian vault rooted at `root` (the user-picked absolute path).
 *
 * Thin wrapper over {@link importFromSource} with the Obsidian source — retained
 * so every shipped caller and the pre-existing `tests/notes/import-*` suites keep
 * working unchanged across the MYND-579 generalization (they are the regression
 * gate for it). `ports` satisfies `ImportSink` structurally, so it doubles as the
 * write half.
 */
export async function importVault(
  root: string,
  ports: ImportPorts,
  existingIdentity: ReadonlySet<string>,
  policy: DuplicatePolicy,
  options: ImportOptions = {},
): Promise<ImportResult> {
  return importFromSource(
    createObsidianSource(root, ports),
    ports,
    existingIdentity,
    policy,
    options,
  );
}
