// Obsidian importer — conflict / duplicate handling (idempotent re-import).
//
// Sub-feature 2 of the obsidian-importer epic (MYND-50), tasks 1–3 (SYNC-5).
//
// MYND-50 was re-scoped from "skip/overwrite/rename" to idempotent re-import:
// "overwrite" is structurally impossible (note_create mints a backend UUIDv7,
// create-only) and duplicate (folder, title) pairs are legal. So the only real
// behavior is: before each `note_create`, check whether a LIVE note with the
// same (folder, title) identity already exists, and — under the default toggle
// — skip it (never overwrite, never update; C1 + no lost edits).
//
// Identity = the SAME case-fold + NFC fold the daily-note resolver uses
// (`folderKey` + `foldSegment(title)`), so the importer's match key is the
// resolver's key, not a second scheme (not content-hash, not source-path).
//
// RESIDUAL (documented): Myne's frontmatter-only-title model does not persist a
// note's filename. An imported file with NO frontmatter `title:` becomes an
// "Untitled" note (no persisted title), so it carries no matchable (folder,
// title) identity — re-importing an untitled-note vault therefore creates
// duplicates rather than skipping. Dedup is exact for FM-titled notes (and for
// imports whose filename matches an existing note's title). This is inherent to
// the frontmatter-only-title decision (2026-05-28) and the (folder, title)
// identity SYNC-5 mandated; it is not papered over with a content hash.

import { foldSegment, folderKey } from "../../dialect/folderPath";

/** Minimal existing-note shape for identity matching (folder + title + lifecycle). */
export interface ExistingNote {
  folder: string | null;
  /** FM `title:` as Myne persists it; `null` = Untitled (no matchable identity). */
  title: string | null;
  /** Value-strict RFC-3339 timestamp when trashed; `null` = live. Matches
   *  `TitleRecord.trashed`, so the engine (sub-feature 3) passes note records
   *  straight through with no `string|null → boolean` adapter to invert. */
  trashed: string | null;
  template: boolean;
}

/**
 * Case-fold + NFC identity key for a (folder, title) pair — the same fold the
 * daily-note resolver matches on (`folderKey` + `foldSegment(title)`). NUL-joined
 * so a folder/title boundary can't be forged by an adversarial title.
 */
export function noteIdentityKey(folder: string | null, title: string): string {
  return folderKey(folder) + "\u0000" + foldSegment(title);
}

/**
 * Identity set of the LIVE vault (non-trashed, non-template, titled notes).
 * Untitled notes are excluded — they have no matchable identity (see the
 * RESIDUAL note above). Built once per import run from the whole vault, so a hit
 * covers both prior-import notes and Myne-native notes.
 */
export function buildExistingIdentitySet(
  notes: readonly ExistingNote[],
): Set<string> {
  const set = new Set<string>();
  for (const n of notes) {
    if (n.trashed !== null || n.template || n.title === null) continue;
    set.add(noteIdentityKey(n.folder, n.title));
  }
  return set;
}

/**
 * Read-only existence predicate — never mutates. Does a live note already have
 * this (folder, title) identity?
 */
export function noteIdentityExists(
  existing: ReadonlySet<string>,
  folder: string | null,
  title: string,
): boolean {
  return existing.has(noteIdentityKey(folder, title));
}

/** The single global pre-import toggle: skip a duplicate (default), or import it as a copy. */
export type DuplicatePolicy = "skip" | "import-as-copy";

/** Skip is the default — non-destructive, idempotent re-import. */
export const DEFAULT_DUPLICATE_POLICY: DuplicatePolicy = "skip";

/** Per-file outcome just before `note_create`. There is no overwrite/update outcome. */
export type ImportDecision = "create" | "skip";

/**
 * Decide whether to create or skip a candidate import, TS-side before
 * `note_create` (SYNC-1). Pure + read-only: an existing note is never touched.
 * `import-as-copy` always creates (a second legal (folder, title) pair, byte-
 * identical content, no rename / no `(1)` suffix — any later disambiguation is
 * MYND-51's flag path, never originated here).
 */
export function decideImport(
  existing: ReadonlySet<string>,
  folder: string | null,
  title: string,
  policy: DuplicatePolicy,
): ImportDecision {
  if (policy === "import-as-copy") return "create";
  return noteIdentityExists(existing, folder, title) ? "skip" : "create";
}

/** Per-run tally feeding the shared summary DTO (SYNC-2). The engine (sub-feature
 *  3) maps `skippedExisting` to the DTO's "skipped (already exist)" field; this
 *  feature only populates the count, it does not redefine the DTO shape. */
export interface ImportDecisionTally {
  created: number;
  skippedExisting: number;
}

export function tallyDecisions(
  decisions: readonly ImportDecision[],
): ImportDecisionTally {
  let created = 0;
  let skippedExisting = 0;
  for (const d of decisions) {
    if (d === "skip") skippedExisting++;
    else created++;
  }
  return { created, skippedExisting };
}
