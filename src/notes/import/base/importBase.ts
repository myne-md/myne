// `.base` import entry point (Saved Views #6, MYND-276, task 6).
//
// The ONE core call #4's trigger UI invokes: read → parse → map → drop/warn →
// PERSIST → summary. Imported views ride the EXISTING prefs write path
// (`upsert_saved_view`, the same place hand-authored views live, #3/SYNC-6) — no
// new magic byte, no KEK, no AAD, no dedicated blob: zero new crypto surface.
// Because they're ordinary `vault.prefs` entries they're automatically in the
// MYB1 backup + Phase-2 sync, and bounded by MYP1's 64 KiB pre-AEAD cap (which
// the prefs setter enforces — an oversize write rejects atomically, so a single
// view never half-writes; per-view `atomic_write` means no torn blob).

import type { SavedView } from "../../../lib/prefs";
import { upsertSavedView } from "../../../lib/prefs";
import { splitExportPath } from "../../exportFlow";
import type { BaseImportTally } from "../engine";
import { readAndParseBase, parseBaseSource, type ParsedBase } from "./parseBase";
import { mapParsedBase, type BaseImportWarning } from "./mapBase";
import { tallyBaseImport } from "./baseSummary";

/** Closed error for a persist failure during a `.base` import (e.g. the MYP1
 *  64 KiB cap rejecting an oversize `saved_views`). Carries the view that
 *  failed + the count already persisted (partial-import is the documented
 *  model — the importer is naïve, consistent with the obsidian importer). */
export class BaseImportPersistError extends Error {
  constructor(
    message: string,
    readonly persistedCount: number,
    readonly failedView: string,
  ) {
    super(message);
    this.name = "BaseImportPersistError";
  }
}

/** Injected side-effects (the impure seam — tests pass fakes, production passes
 *  the real prefs write + UUID). */
export interface BaseImportDeps {
  /** Persist one mapped view (production: `upsertSavedView` → `vault.prefs`). */
  readonly persistView: (view: SavedView) => Promise<void>;
  /** Mint a stable view id (production: `crypto.randomUUID`). */
  readonly makeId: () => string;
}

/** Production deps: the real prefs write path + a UUIDv7-ish id. */
export function defaultBaseImportDeps(): BaseImportDeps {
  return {
    persistView: upsertSavedView,
    makeId: () => crypto.randomUUID(),
  };
}

/** The full import core over an already-parsed `.base` — map → persist → tally.
 *  Pure orchestration over the injected `deps`; the read/parse is the caller's
 *  (so this is unit-testable with no IPC). Persists each surviving view via the
 *  existing prefs path; a persist rejection (e.g. MYP1 cap) is wrapped in a
 *  {@link BaseImportPersistError} carrying how many were already written. */
export async function runBaseImport(
  parsed: ParsedBase,
  deps: BaseImportDeps,
): Promise<BaseImportTally> {
  const { views, warnings }: { views: SavedView[]; warnings: BaseImportWarning[] } =
    mapParsedBase(parsed, deps.makeId);

  let persisted = 0;
  for (const view of views) {
    try {
      await deps.persistView(view);
    } catch (e) {
      throw new BaseImportPersistError(
        `failed to persist saved view "${view.name}": ${String(e)}`,
        persisted,
        view.name,
      );
    }
    persisted++;
  }

  return tallyBaseImport(persisted, warnings);
}

/** Import a `.base` from source bytes (RAM-only; no read seam). */
export async function importBaseSource(
  source: string,
  deps: BaseImportDeps,
): Promise<BaseImportTally> {
  return runBaseImport(parseBaseSource(source), deps);
}

/**
 * The end-to-end entry point #4's trigger UI invokes: read the `.base` through
 * the shipped importer seam (`import_read_file`, root-confined), parse, map,
 * persist into `vault.prefs`, and return the import summary tally. `deps`
 * defaults to the production prefs write + UUID; tests inject fakes.
 */
export async function importBaseFile(
  root: string,
  path: string,
  deps: BaseImportDeps = defaultBaseImportDeps(),
): Promise<BaseImportTally> {
  const parsed = await readAndParseBase(root, path);
  return runBaseImport(parsed, deps);
}

/**
 * Convenience entry for a picked ABSOLUTE `.base` file path: derives the
 * root-confining directory (via the shared `splitExportPath` separator scanner —
 * the path-split lives here, not in the UI) and runs {@link importBaseFile}. The
 * caller (the palette action) only owns the file picker + the summary toast.
 */
export async function importBaseFilePath(
  absPath: string,
  deps: BaseImportDeps = defaultBaseImportDeps(),
): Promise<BaseImportTally> {
  const { dir } = splitExportPath(absPath);
  return importBaseFile(dir, absPath, deps);
}
