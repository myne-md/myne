// Every folder path that currently exists in the vault, for surfaces that need
// to OFFER a folder rather than render the tree (MYND-624).
//
// The sidebar builds its folder options from the live `SidebarState` cache it
// already holds. Settings has no such cache — it is a modal with its own data —
// and plumbing the sidebar's state into it would tie a preference panel to the
// note list's lifecycle for the sake of one dropdown. This walks the same
// `note_list` + `loadNoteBatch` path the sidebar seeds itself from, which is the
// existing route to that information and adds no backend command.
//
// Ancestors are synthesised: a note filed at `a/b/c/` proves `a/`, `a/b/` and
// `a/b/c/` all exist even if no note sits directly in the first two. Without
// that, a folder that only holds subfolders would be unpickable.

import { noteList } from "./listNotes";
import { loadNoteBatch } from "./loadNoteBatch";

export interface FolderPathOption {
  /** Canonical trailing-slash path — the value stored in prefs. */
  path: string;
  /** Depth-indented display label, matching the sidebar's folder options. */
  label: string;
}

/**
 * Unique folder paths in the vault, ordered so a folder is immediately followed
 * by its own children (depth-first by path), each labelled with a leading
 * indent per level.
 *
 * Returns an empty list when the vault is locked or has no notes — callers
 * render their free-text fallback rather than an empty dropdown.
 */
export async function listFolderPaths(): Promise<FolderPathOption[]> {
  const ids = await noteList();
  if (ids.length === 0) return [];
  const records = await loadNoteBatch(ids);

  const paths = new Set<string>();
  for (const r of records) {
    if (r.folder === null || r.folder === "") continue;
    // Walk the ancestors so intermediate folders are offered too.
    const segments = r.folder.replace(/\/+$/, "").split("/");
    for (let i = 1; i <= segments.length; i++) {
      paths.add(`${segments.slice(0, i).join("/")}/`);
    }
  }

  return [...paths]
    .sort((a, b) => a.localeCompare(b))
    .map((path) => {
      const depth = path.split("/").filter(Boolean).length;
      const name = path.replace(/\/+$/, "").split("/").pop() ?? path;
      return { path, label: `${" ".repeat(Math.max(0, depth - 1))}${name}` };
    });
}
