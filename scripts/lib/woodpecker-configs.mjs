// The ONE place that knows where this repo's Woodpecker config lives, and which
// workflow files it is supposed to consist of.
//
// THE FAILURE THIS PREVENTS. The config used to be a single `.woodpecker.yml`
// at the repo root, and two guards read that literal path. It is now a
// DIRECTORY of two workflow files, `main.yml` (everything that runs on a push)
// and `e2e.yml` (both end-to-end suites, manual-only; myne-md/myne#579), because
// Woodpecker's default lookup prefers `.woodpecker/` over the root file. A
// guard still pointing at the old path does not report a smaller scan: it
// throws ENOENT, or, worse, if somebody "fixes" that by tolerating a missing
// file, it reports `ok` for a config it never opened. Both guards this module
// serves are `pre-commit` guards whose whole job is to stop a config that would
// kill every gate on every branch, so a guard that silently stops looking is
// the exact hole they exist to close.
//
// TWO PROPERTIES, AND EACH ONE FIXES A HOLE THE OTHER LEAVES.
//
// The roster is NAMED, because a purely derived list cannot notice a file going
// away. `shared-roots.mjs` names its roots explicitly so "a root on the roster
// but absent from the checkout is a failure here, not a smaller walk". Delete or
// rename `e2e.yml` (a bad merge, a rename to `e2e.yml.disabled`, a cleanup) and
// the entire pre-release E2E workflow ceases to exist with nothing in the
// repository noticing: not these guards, and not `check-e2e-floor.mjs`, which
// only runs INSIDE that file. So `REQUIRED_CONFIGS` is a membership check.
//
// The SCAN is the union of that roster and every workflow file actually in the
// directory, because a purely named list cannot notice a file arriving. This
// module shipped for one review round returning the roster alone, and three
// independent reviewers each reproduced the same hole with their own fixture: a
// third `.woodpecker/nightly.yml` carrying an unescaped single-dollar brace
// token, which Woodpecker WILL run and which errors the entire pipeline before
// any step starts, made `check-woodpecker-substitution.mjs` print `ok`. Worse,
// `lefthook.yml` globs `.woodpecker/*.yml`, so editing that third file fires the
// hook and hands the author a green from a guard that never opened it. That is
// the `scanned-assets.mjs` rule inverted: a guard must fail on an input nobody
// classified, never skip it.
//
// Adding a third workflow file stays a legitimate change and is not a failure.
// It simply gets scanned like the other two.
//
// A ROOT `.woodpecker.yml` ALONGSIDE THE DIRECTORY IS A FAILURE, not a second
// file to scan. Woodpecker's lookup takes the directory and IGNORES the root
// file, so such a file is dead config: someone edits it, pushes, and nothing
// they changed has any effect, with no error anywhere. Scanning it would be
// worse than failing on it, because a clean scan of a file that does not run is
// a guard endorsing a lie.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const CONFIG_DIR = ".woodpecker";

/** The workflow files this repository is supposed to have, by name. */
export const REQUIRED_CONFIGS = ["main.yml", "e2e.yml"];

/** Root-level config paths Woodpecker would IGNORE once `CONFIG_DIR` exists. */
const SHADOWED_ROOT_CONFIGS = [".woodpecker.yml", ".woodpecker.yaml"];

/**
 * Repo-relative paths of every Woodpecker workflow file, sorted.
 *
 * `root` exists so the tests can point this at a fixture directory; production
 * callers take the default.
 */
export function woodpeckerConfigPaths(root = ROOT) {
  const dir = join(root, CONFIG_DIR);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(
      `woodpecker-configs: ${CONFIG_DIR}/ does not exist under ${root}. ` +
        "Woodpecker reads its config from that directory (myne-md/myne#579 " +
        "moved it there from the root .woodpecker.yml), so its absence means " +
        "the repository has no CI at all rather than nothing to check.",
    );
  }

  const shadowed = SHADOWED_ROOT_CONFIGS.filter((n) => existsSync(join(root, n)));
  if (shadowed.length > 0) {
    throw new Error(
      `woodpecker-configs: ${shadowed.join(", ")} exists alongside ${CONFIG_DIR}/. ` +
        "Woodpecker's config lookup takes the DIRECTORY and ignores the root " +
        "file, so that file is dead config: edits to it change nothing and " +
        "report nothing. Move its contents into a workflow file under " +
        `${CONFIG_DIR}/ and delete it.`,
    );
  }

  const missing = REQUIRED_CONFIGS.filter((n) => !existsSync(join(root, CONFIG_DIR, n)));
  if (missing.length > 0) {
    throw new Error(
      `woodpecker-configs: ${CONFIG_DIR}/{${missing.join(", ")}} missing. ` +
        "Both workflow files are named on purpose. `main.yml` is the per-push " +
        "pipeline and `e2e.yml` is the manual pre-release E2E lane, and the " +
        "second is the one that can disappear in a merge without anyone " +
        "noticing for weeks (nothing else in the repo reads it; " +
        "check-e2e-floor.mjs only runs INSIDE it). Removing one is a decision " +
        "to argue for in REQUIRED_CONFIGS, not a rename to make quietly.",
    );
  }

  // The union: the named roster plus every other workflow file present. Sorted
  // and de-duplicated, so the caller sees each file once regardless of which
  // half it came from.
  const present = readdirSync(join(root, CONFIG_DIR)).filter(
    (n) =>
      (n.endsWith(".yml") || n.endsWith(".yaml")) &&
      statSync(join(root, CONFIG_DIR, n)).isFile(),
  );
  const names = [...new Set([...REQUIRED_CONFIGS, ...present])].sort();
  return names.map((n) => `${CONFIG_DIR}/${n}`);
}

/** `[{ rel, text }]` for every workflow file. */
export function readWoodpeckerConfigs(root = ROOT) {
  return woodpeckerConfigPaths(root).map((rel) => ({
    rel,
    text: readFileSync(join(root, rel), "utf8"),
  }));
}
