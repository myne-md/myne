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
  folderKey,
  isFolderTarget,
} from "@myne/dialect/folderPath";
import { pickIndexNote } from "./folderTree";
import type { WikilinkRef } from "@myne/dialect/types";

/** A note as seen by the resolver — title + canonical folder (or null = root). */
export interface ResolverNote {
  noteUuid: string;
  title: string | null;
  folder: string | null;
  /** True when the note is its folder's index note (`folder_index: true`,
   *  MYND-370). Optional so callers that don't track it still type-check; only
   *  the folder-target (`[[Projects/]]`) resolution path reads it. */
  folderIndex?: boolean;
  /** True when the note is a `kind: drawing` Excalidraw note (drawing-notes SF2,
   *  MYND-499). Optional so callers that don't track it still type-check; the
   *  SF6 inline-embed path reads it to pick a thumbnail widget over a text chip. */
  isDrawing?: boolean;
}

/** The note's vault-relative path (`<folder>/<title>.md`; root → `<title>.md`).
 *  The single home for this projection — the picker, hover, and conversion all
 *  import it so the displayed path never drifts between surfaces. */
export function notePath(n: ResolverNote): string {
  return `${n.folder ?? ""}${n.title ?? ""}.md`;
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
      /** All notes whose title matched (length === matchCount), in the
       *  resolver's deterministic filter order. The single canonical candidate
       *  list (WL-3): #3 picker + #4 inline-ambiguity read this, never
       *  re-filtering titles. For a single hit this is the one resolved note. */
      candidates: ResolverNote[];
    }
  | {
      status: "broken";
      matchCount: 0;
      candidates: ResolverNote[];
      /** Why the link is broken (MYND-370). `"no-folder-note"` — a folder-target
       *  link (`[[Projects/]]`) where the folder exists but has no index note;
       *  `"no-match"` (or absent) — no matching note / folder at all. Drives the
       *  distinct broken-link hint copy in {@link resolutionHint}. */
      brokenReason?: "no-match" | "no-folder-note";
    };

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

/**
 * Resolve a folder-target wikilink (`[[Projects/]]`) to that folder's index note
 * (`folder_index: true`). Mechanically a normal resolve to the index note, so
 * backlinks / hover / graph treat it like any wikilink to that note. Two distinct
 * broken states: the folder exists (some note lives in it) but has no index note
 * → `"no-folder-note"`; nothing lives in the folder at all → `"no-match"`.
 */
function resolveFolderTarget(
  ref: WikilinkRef,
  notes: ReadonlyArray<ResolverNote>,
): WikilinkResolution {
  const fk = folderKey(ref.target);
  const inFolder = notes.filter((n) => folderKey(n.folder) === fk);
  const indexNotes = inFolder.filter((n) => n.folderIndex === true);

  if (indexNotes.length === 0) {
    return {
      status: "broken",
      matchCount: 0,
      candidates: [],
      brokenReason: inFolder.length > 0 ? "no-folder-note" : "no-match",
    };
  }

  // Deterministic winner on the (rare) multi-claimant case — the shared
  // `pickIndexNote` tiebreak, so the link and the sidebar badge agree on which
  // note is the index.
  const winner = pickIndexNote(indexNotes.map((n) => n.noteUuid));
  const pick = indexNotes.find((n) => n.noteUuid === winner) ?? indexNotes[0]!;
  return {
    status: "resolved",
    noteUuid: pick.noteUuid,
    ambiguous: false,
    matchCount: indexNotes.length,
    candidates: indexNotes,
  };
}

/**
 * Resolve `ref` against the vault note index. Title-keyed; folder segment
 * disambiguates a title collision; FM folder wins over a stale link segment.
 */
export function resolveWikilink(
  ref: WikilinkRef,
  notes: ReadonlyArray<ResolverNote>,
): WikilinkResolution {
  // Folder-target form (`[[Projects/]]`) resolves to the folder's index note —
  // a separate path from title-keyed note resolution (MYND-370).
  if (isFolderTarget(ref.target)) return resolveFolderTarget(ref, notes);

  const { title, folder } = parseTarget(ref);
  const titleKey = foldSegment(title);

  // (1) title lookup
  const candidates = notes.filter(
    (n) => n.title !== null && foldSegment(n.title) === titleKey,
  );

  // (5) zero hits → broken
  if (candidates.length === 0) return { status: "broken", matchCount: 0, candidates: [] };
  // (2) single hit → resolve (survives folder move: title unchanged)
  if (candidates.length === 1) {
    return {
      status: "resolved",
      noteUuid: candidates[0]!.noteUuid,
      ambiguous: false,
      matchCount: 1,
      candidates,
    };
  }

  // (3) multiple hits → folder segment as first-tier disambiguator
  if (folder !== null) {
    const fk = foldSegment(folder);
    const folderMatches = candidates.filter((n) => folderKey(n.folder) === fk);
    if (folderMatches.length === 1) {
      return {
        status: "resolved",
        noteUuid: folderMatches[0]!.noteUuid,
        ambiguous: false,
        matchCount: candidates.length,
        candidates,
      };
    }
  }

  // (4) no clean folder match → shortest-path heuristic (fewest folder
  // segments; lexicographic folded-folder tiebreak), flagged ambiguous.
  const pick = [...candidates].sort((a, b) => {
    const da = folderDepth(a.folder);
    const db = folderDepth(b.folder);
    if (da !== db) return da - db;
    return folderKey(a.folder).localeCompare(folderKey(b.folder));
  })[0]!;
  return {
    status: "resolved",
    noteUuid: pick.noteUuid,
    ambiguous: true,
    matchCount: candidates.length,
    candidates,
  };
}

/** The display-hint surface (§6.2). A pure function of `WikilinkResolution`
 *  alone (note-set-free) — the single source of truth for the parenthetical /
 *  broken-link copy that the chip hover (#2), picker (#3), and R2 conversion (#4)
 *  render. `text` carries ONLY the parenthetical: `"(no match)"` for broken,
 *  `"(N matches)"` for an ambiguous resolve, and `""` for a clean single hit
 *  (the caller composes the "Display → path" line for a clean hit). The
 *  `broken` / `ambiguous` booleans let callers branch on state (e.g. #2's
 *  broken-chip styling) without re-reading `status`. */
export function resolutionHint(res: WikilinkResolution): {
  text: string;
  broken: boolean;
  ambiguous: boolean;
} {
  if (res.status === "broken") {
    const text =
      res.brokenReason === "no-folder-note" ? "(no folder note)" : "(no match)";
    return { broken: true, ambiguous: false, text };
  }
  if (res.ambiguous) {
    return { broken: false, ambiguous: true, text: `(${res.matchCount} matches)` };
  }
  return { broken: false, ambiguous: false, text: "" };
}
