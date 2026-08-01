// Generic HTML import source (importer-breadth epic, MYND-582).
//
// A picked directory of `.html` / `.htm` files → one note each, converted through
// the shared converter (`html/index.ts`). The tree-walk shape already fits, so the
// only source-specific pieces are the per-adapter entry classification and the
// convert step — which is exactly what the MYND-579 seam was built to allow.
//
// Remote media refs in the output are left as inert markdown and NEVER fetched: no
// `src` survives the sanitizer as a fetchable resource here (the document is never
// rendered), and the dialect does not render a raw-path ref as an `<img>`
// (`markdown-dialect.md` §7). The anti-feature holds without a special case.

import { htmlToMarkdown } from "../html";
import { emptyIgnoreCounts } from "../skipPredicate";
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

/** Is this entry name an HTML document this adapter imports? */
export function isHtmlEntry(name: string): boolean {
  return /\.html?$/i.test(name);
}

/** Swap an `.html`/`.htm` suffix for `.md` so title derivation reads cleanly. */
export function htmlDisplayPath(rel: string): string {
  return `${rel.replace(/\.html?$/i, "")}.md`;
}

/**
 * An `ImportSource` over a directory tree of HTML documents rooted at `root`.
 *
 * `plan()` walks ENTRIES only (no content), mirroring the Obsidian source: dot
 * entries are skipped and counted, non-dot directories are recursed and recorded
 * for SYNC-4 empty-dir detection, `.html`/`.htm` are queued, everything else lands
 * in the non-markdown skip bucket (media referenced BY a document still resolves
 * through the shared media-ingest path — it just is not a note of its own).
 */
export function createHtmlSource(root: string, ports: ImportPorts): ImportSource {
  return {
    id: "html",

    async plan(): Promise<ImportPlan> {
      const items: ImportItemRef[] = [];
      const dirs: string[] = [];
      const ignore = emptyIgnoreCounts();
      const unfollowedLinks: UnfollowedLink[] = [];
      // The host resolves symlinked directories for every tree walk now, so
      // every tree walk owes the same cycle guard (myne-md/myne#223).
      const visitedLinkTargets = new Set<string>();

      const walk = async (relDir: string): Promise<void> => {
        let entries: ImportDirEntry[];
        try {
          entries = await ports.readDir(joinPath(root, relDir));
        } catch {
          return; // an unreadable subtree yields fewer items, never a failed import
        }
        for (const entry of entries) {
          const rel = relDir.length === 0 ? entry.name : `${relDir}/${entry.name}`;
          if (entry.name.startsWith(".")) {
            ignore.hiddenIgnored++;
            continue;
          }
          if (decideLinkedEntry(entry, rel, visitedLinkTargets, unfollowedLinks) === "skip") {
            continue;
          }
          if (entry.isDir) {
            dirs.push(rel);
            await walk(rel);
          } else if (isHtmlEntry(entry.name)) {
            // `relPath` is the DISPLAY path the shared mapping seam derives folder
            // and title from, and `deriveImportTitle` strips exactly one trailing
            // `.md` — so an `.html` suffix left here would land in the note title
            // verbatim ("report.html"). The real on-disk path rides in `handle`.
            items.push({ relPath: htmlDisplayPath(rel), handle: rel });
          } else {
            ignore.nonMarkdownSkipped++;
          }
        }
      };
      await walk("");

      return { items, dirs, ignore, unfollowedLinks };
    },

    async load(ref: ImportItemRef): Promise<LoadedItem> {
      // Read the REAL path from `handle`; `relPath` is the `.md` display path.
      const real = typeof ref.handle === "string" ? ref.handle : ref.relPath;
      const raw = await ports.readFile(joinPath(root, real));
      const { markdown, lossy } = await htmlToMarkdown(raw, "html");
      return { markdown, lossy };
    },
  };
}
