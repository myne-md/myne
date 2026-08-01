// Importer — the Obsidian source (importer-breadth epic, MYND-579).
//
// The shipped Obsidian walk, expressed as an `ImportSource`. This file is a
// BEHAVIOUR-PRESERVING extraction of `engine.ts`'s old Phase 1: same
// `classifyEntry` taxonomy, same recursion rule, same tallies, same ordering. The
// ten pre-existing `tests/notes/import-*.test.ts` suites are the regression gate —
// they exercise `importVault`, which now runs through this source.
//
// Obsidian is the lossless source: its files are already Myne-dialect markdown, so
// `load()` returns the bytes verbatim with an empty `lossy` list. Every transform
// that DOES apply (the `folder:` / `title:` injections) lives in the shared
// `mapImportedFile` seam, which the engine applies after `load()` for every source.

import { classifyEntry, emptyIgnoreCounts, tallyEntry } from "../skipPredicate";
import {
  decideLinkedEntry,
  joinPath,
  type ImportDirEntry,
  type ImportItemRef,
  type ImportPlan,
  type ImportPorts,
  type ImportSource,
  type LoadedItem,
  type UnfollowedLink,
} from "../source";

/**
 * An `ImportSource` over an Obsidian vault rooted at `root`, reading through the
 * narrow within-root-validated `importer:` seam.
 *
 * `plan()` walks directory ENTRIES ONLY (no file content) so the enumeration stays
 * cheap and `total` is known before the first note is read: dot-prefixed entries
 * are skipped and counted (the SYNC-10 ignore set subsumes `.obsidian/`, `.git/`,
 * `.trash/`, `.DS_Store`), non-dot directories are recursed and recorded for
 * SYNC-4 empty-dir detection, `.md` files are queued, `.canvas` and other
 * non-markdown files go to their own skip buckets.
 *
 * A **symlinked** directory is walked like any other directory — the host
 * resolves it and says so (`ImportDirEntry.link`), because `file_type()` alone
 * reported it as a non-directory and the whole subtree under it disappeared into
 * the "other files skipped" count (myne-md/myne#223). A link the host refuses —
 * outside the picked root, a loop, dangling — is reported by name instead.
 */
export function createObsidianSource(
  root: string,
  ports: ImportPorts,
): ImportSource {
  return {
    id: "obsidian",

    async plan(): Promise<ImportPlan> {
      const items: ImportItemRef[] = [];
      const dirs: string[] = [];
      const ignore = emptyIgnoreCounts();
      const unfollowedLinks: UnfollowedLink[] = [];
      // Cycle guard. The host refuses a link pointing at the listed directory
      // or an ancestor of it (that needs no state), but it cannot see a cycle
      // that closes across siblings — `a/x → b`, `b/y → a`. Remembering which
      // link targets have already been entered terminates that shape too.
      const visitedLinkTargets = new Set<string>();

      const walk = async (relDir: string): Promise<void> => {
        const entries: ImportDirEntry[] = await ports.readDir(joinPath(root, relDir));
        for (const entry of entries) {
          const cls = classifyEntry(entry.name);
          const rel = relDir.length === 0 ? entry.name : `${relDir}/${entry.name}`;
          // A link the host refused — outside the picked root, a loop, dangling
          // — is named in the report, never folded into a skip count.
          if (decideLinkedEntry(entry, rel, visitedLinkTargets, unfollowedLinks) === "skip") {
            continue;
          }
          if (entry.isDir) {
            if (cls === "hidden-ignored") {
              ignore.hiddenIgnored++; // dot-dir — skipped
              continue;
            }
            dirs.push(rel); // non-dot dir → recurse (its classification is moot)
            await walk(rel);
          } else if (cls === "import-as-note") {
            items.push({ relPath: rel });
          } else {
            // Every skip bucket routes through the ONE exhaustive tally site —
            // an inline chain here is what let `excalidraw-skipped` fall into
            // the hidden/config count (myne-md/myne#223).
            tallyEntry(ignore, cls);
          }
        }
      };
      await walk("");

      return { items, dirs, ignore, unfollowedLinks };
    },

    async load(ref: ImportItemRef): Promise<LoadedItem> {
      const markdown = await ports.readFile(joinPath(root, ref.relPath));
      // Lossless: the source bytes ARE Myne-dialect markdown.
      return { markdown, lossy: [] };
    },
  };
}
