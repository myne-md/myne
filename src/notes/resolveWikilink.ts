// Title-keyed wikilink resolution (MYND-144 Task 12).
//
// Under virtual folders there is no `<folder>/<title>.md` file on disk, so a
// wikilink resolves by its **title** component (the note whose `title:`
// matches); a path-form link's folder segment is a *disambiguator* on title
// collision, not the primary key, and the note's actual `folder:` frontmatter
// wins over a stale link segment. This collapses the earlier dual mode
// (title-only via index vs. path-form via exact path) into one model. See
// `docs/spec/wikilink.md` §5.3 + decisions.md 2026-05-29 (C2 refine).

import {
  filenameToTitle,
  foldSegment,
  normalizeFolderPath,
} from "../dialect/folderPath";
import type { WikilinkRef } from "../dialect/types";

/** A note as seen by the resolver — title + canonical folder (or null = root). */
export interface ResolverNote {
  noteUuid: string;
  title: string | null;
  folder: string | null;
}

/**
 * The id set of a live resolver note-set — the ONE place this is built (SYNC-3
 * trash exclusion). The resolver note-set is already the live (non-trashed,
 * non-template) set; this projects it to ids for membership filtering against a
 * trash-blind Rust index (backlinks T3, `byTag`, the graph tag filter). Pure.
 */
export function liveIdSet(notes: ReadonlyArray<ResolverNote>): Set<string> {
  return new Set(notes.map((n) => n.noteUuid));
}

export type WikilinkResolution =
  | {
      status: "resolved";
      noteUuid: string;
      /** True when title collided and the folder did NOT uniquely disambiguate
       *  (resolved via the shortest-path fallback) — drives the "(N matches)"
       *  hover hint (§6.3). */
      ambiguous: boolean;
      /** Number of notes whose title matched (≥ 1). */
      matchCount: number;
    }
  | { status: "broken"; matchCount: 0 };

/** Split a wikilink target into its title component + (for path forms) folder.
 *  Exported so the VaultIndices edge extractor derives the folded title-key
 *  from the SAME parse the resolver uses (single source — no divergence). */
export function parseTarget(ref: WikilinkRef): {
  title: string;
  folder: string | null;
} {
  if (ref.targetKind === "title") {
    return { title: ref.target, folder: null };
  }
  // vault-path: last segment (minus exactly one trailing `.md`) is the title;
  // the prefix is the (virtual) folder.
  const segs = ref.target.split("/").filter((s) => s.length > 0);
  if (segs.length === 0) return { title: ref.target, folder: null };
  const title = filenameToTitle(segs[segs.length - 1]!);
  const prefix = segs.slice(0, -1);
  const folder = prefix.length > 0 ? prefix.join("/") + "/" : null;
  return { title, folder };
}

function folderDepth(folder: string | null): number {
  return folder === null ? 0 : folder.split("/").filter((s) => s.length > 0).length;
}

function foldedFolder(folder: string | null): string {
  return foldSegment(normalizeFolderPath(folder) ?? "");
}

/**
 * Resolve `ref` against the vault note index. Title-keyed; folder segment
 * disambiguates a title collision; FM folder wins over a stale link segment.
 */
export function resolveWikilink(
  ref: WikilinkRef,
  notes: ReadonlyArray<ResolverNote>,
): WikilinkResolution {
  const { title, folder } = parseTarget(ref);
  const titleKey = foldSegment(title);

  // (1) title lookup
  const candidates = notes.filter(
    (n) => n.title !== null && foldSegment(n.title) === titleKey,
  );

  // (5) zero hits → broken
  if (candidates.length === 0) return { status: "broken", matchCount: 0 };
  // (2) single hit → resolve (survives folder move: title unchanged)
  if (candidates.length === 1) {
    return {
      status: "resolved",
      noteUuid: candidates[0]!.noteUuid,
      ambiguous: false,
      matchCount: 1,
    };
  }

  // (3) multiple hits → folder segment as first-tier disambiguator
  if (folder !== null) {
    const fk = foldSegment(folder);
    const folderMatches = candidates.filter((n) => foldedFolder(n.folder) === fk);
    if (folderMatches.length === 1) {
      return {
        status: "resolved",
        noteUuid: folderMatches[0]!.noteUuid,
        ambiguous: false,
        matchCount: candidates.length,
      };
    }
  }

  // (4) no clean folder match → shortest-path heuristic (fewest folder
  // segments; lexicographic folded-folder tiebreak), flagged ambiguous.
  const pick = [...candidates].sort((a, b) => {
    const da = folderDepth(a.folder);
    const db = folderDepth(b.folder);
    if (da !== db) return da - db;
    return foldedFolder(a.folder).localeCompare(foldedFolder(b.folder));
  })[0]!;
  return {
    status: "resolved",
    noteUuid: pick.noteUuid,
    ambiguous: true,
    matchCount: candidates.length,
  };
}
