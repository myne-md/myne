// Every folder path that currently exists in the vault, for surfaces that need
// to OFFER a folder rather than render the tree (MYND-624, myne-md/myne#828).
//
// The derivation is the SHARED `deriveFolderTree`: a note's `folder:` field
// UNION the `deliberate_folders` prefs set (deliberate empty folders persist,
// MYND-144), with archived folders filtered, ancestors synthesized and the
// display form chosen deterministically. The sidebar already derives from that
// same function; before this, this module walked notes alone, so a folder the
// sidebar showed — a deliberately created empty one — was offered by NO picker
// (periodic notes, new-note location, the command palette's `folder:` pool).
// Keeping one derivation is what stops the two surfaces drifting apart again.
//
// The read is BEST-EFFORT: a locked vault or an IO failure falls back to the
// note-only view, so the caller's free-text fallback still renders.

import { noteList } from "./listNotes";
import { loadNoteBatch } from "./loadNoteBatch";
import { prefsRead } from "../lib/prefs";
import { folderKey } from "../dialect/folderPath";
import { isLiveNote } from "@myne/editor/host/notes/selectors";
import { deriveFolderTree, type FolderNode } from "./folderTree";

export interface FolderPathOption {
  /** Canonical trailing-slash path — the value stored in prefs. */
  path: string;
  /** Depth-indented display label, matching the sidebar's folder options. */
  label: string;
}

/**
 * Resolve a stored folder path to the canonical form present in `paths`,
 * case-insensitively (and NFC-normalized). A configured folder whose stored
 * casing predates the canonical display form would otherwise not match any
 * option, so the picker renders UNSELECTED (a placeholder) while the vault
 * still files there (myne-md/myne#828 review). Returns the stored value
 * unchanged when the pool has no folded match, so an unknown path still shows.
 */
export function resolveFolderOption(
  paths: readonly string[],
  stored: string,
): string {
  if (stored === "") return "";
  const key = folderKey(stored);
  const match = paths.find((p) => folderKey(p) === key);
  return match ?? stored;
}

/** Flatten the derived tree depth-first (a folder immediately precedes its
 *  children), turning each node into a path option. The indent is U+2003 (EM
 *  SPACE), matching `NoteList`'s folder options: a leading U+0020 is collapsed
 *  by the CSS white-space model in the picker rows, so the depth would not
 *  render and two same-named folders at different depths would look identical. */
function flatten(nodes: readonly FolderNode[], out: FolderPathOption[]): void {
  for (const node of nodes) {
    out.push({
      path: node.path,
      label: `${"\u2003".repeat(Math.max(0, node.depth - 1))}${node.name}`,
    });
    flatten(node.children, out);
  }
}

/**
 * Unique folder paths in the vault, ordered so a folder is immediately followed
 * by its own children (depth-first by path), each labelled with a leading
 * indent per level.
 *
 * Returns an empty list only when the vault has no notes AND no deliberate
 * folders — callers render their free-text fallback rather than an empty
 * dropdown.
 */
export async function listFolderPaths(): Promise<FolderPathOption[]> {
  // Deliberate folders can exist with zero notes, so the prefs read happens
  // regardless of the note count. Best-effort: a locked vault yields no
  // deliberate set rather than failing the whole enumeration.
  const prefs = await prefsRead().catch(() => null);
  const deliberateFolders = prefs?.deliberate_folders ?? [];
  const archivedFolders = prefs?.archived_folders ?? [];

  const ids = await noteList();
  const records = ids.length > 0 ? await loadNoteBatch(ids) : [];

  const tree = deriveFolderTree(
    // LIVE notes only, the SAME predicate the sidebar's `liveCache` applies
    // (myne-md/myne#828 review). `deriveFolderTree` unions the note folders it
    // is given, and does NOT filter trash/template/conflict itself, so feeding
    // it every note would offer a folder on a picker whose sidebar hides it —
    // the mirror image of the bug this fixes.
    records
      .filter((r) => isLiveNote(r))
      .map((r) => ({ noteUuid: r.noteUuid, folder: r.folder })),
    deliberateFolders,
    archivedFolders,
  );

  const out: FolderPathOption[] = [];
  flatten(tree.roots, out);
  return out;
}
