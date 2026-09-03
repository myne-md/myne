// The one recursive walk that turns a directory into a roster's denominator.
//
// THE FAILURE THIS PREVENTS, and it is not hypothetical. Three guards each ask
// the same question, "what files are under here, so I can require a verdict for
// every one", and each had its own walk. `check-web-screens.mjs` records in its
// own header why its walk RECURSES: a prefix rule once swallowed
// `ProvisioningStep.tsx`, and the recursive walk "caught it by this gate rather
// than by a reviewer". `check-manual-test-roster.mjs` (myne-md/myne#548) was
// written later with a shallow copy, and the fix one guard over did not travel:
// 88 files exist under `src/screens/` and `src/components/settings/` and the
// shallow walk returned 61. The 27 it missed were all of
// `src/screens/vault-creation/`, all of `src/screens/vault-recover/` and all of
// `src/components/settings/search/`, the recovery-phrase display step among them,
// sitting outside a denominator whose whole premise is that every file in it is
// accounted for. Nothing reported it, and the guard printed `ok`.
//
// That is the same shape `scripts/lib/shared-roots.mjs` exists for, one question
// over: "each guard kept a private copy, and updating one copy did not update the
// others." A guard that needs a directory's files imports this. A guard that
// deliberately wants a shallow listing says so in its own header and does not.
//
// TWO SHAPES, because the callers genuinely differ and collapsing them would be
// the wrong fix. A roster keyed by repo-relative path (`src/screens/Unlock.tsx`)
// passes `relativeTo: "."`; a roster keyed within its own directory
// (`vault-recover/PhraseEntryStep.tsx`) passes the directory. The difference is
// in the KEY the roster was written with, not in the walk.

import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Every file under `dirs`, recursively, sorted, as roster keys.
 *
 * @param {string[]} dirs                 directories to walk
 * @param {object}   [opts]
 * @param {string}   [opts.relativeTo]    base the returned paths are relative to (default `"."`)
 * @param {RegExp}   [opts.extensions]    keep only basenames matching this (default: keep all)
 * @param {boolean}  [opts.missingIsNull] return `null` instead of throwing when a directory is
 *                                        absent. Off by default on purpose: a denominator
 *                                        directory that is not there is a broken checkout, and a
 *                                        walk that quietly returns fewer files is how a guard
 *                                        reports `ok` over a tree it could not read.
 * @returns {string[] | null}
 */
export function walkFiles(dirs, { relativeTo = ".", extensions = null, missingIsNull = false } = {}) {
  const out = [];
  // `withFileTypes` rather than a `statSync` per entry: `readdir` already knows
  // whether each name is a directory, so asking again is one extra syscall per
  // FILE across every consumer of this helper. Measured on the shared trees
  // (~1330 files): 61.4 ms of stat+read against 28.1 ms without the stat.
  // `check-twin-inventory.mjs` records the same fix for its own walk with the
  // same reasoning; this one serves four guards at once.
  //
  // One narrowing comes with it and is deliberate rather than overlooked:
  // `statSync` FOLLOWS a symlink, `Dirent.isDirectory()` reports the entry's own
  // type, so a symlinked directory is no longer traversed. No symlink exists
  // under any walked root today (checked), and a roster-coverage guard that
  // followed one would count the same file under two paths. If a shared tree
  // ever grows one, this is the line to revisit.
  //
  // `.sort()` on the entry NAMES is kept, and the ordering note below is why.
  const walk = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (!extensions || extensions.test(e.name)) out.push(relative(relativeTo, full));
    }
  };
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      if (missingIsNull) return null;
      throw new Error(`walkFiles: directory does not exist: ${dir}`);
    }
    walk(dir);
  }
  // NOT sorted globally at the end, and that is load-bearing rather than an
  // omission. `readdirSync(...).sort()` inside the walk already gives a stable
  // order within each directory, and leaving `dirs` in argument order is what
  // makes this a drop-in for the private walks it replaced. A global sort
  // interleaves the groups: `check-web-surfaces.mjs` renders one table row per
  // file in exactly this order into a checked-in document, so sorting here
  // rewrote 154 rows of `web-surface-assessment.md` on the next `--emit` with the
  // same 154 files in it, which is where a real row change hides.
  return out;
}

/** The extension filter two of the three callers share. */
export const TS_FILES = /\.(ts|tsx)$/;
