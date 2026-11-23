// Which files a folder scope covers (myne-md/myne#1075).
//
// The library's folder scope is a SUBTREE, not one directory: a person who
// scopes to `Ders Notları/` means the term, and a term is held in week folders
// under it. The same rule the MCP scope and the agent's exclusion set already
// apply, and for the same reason: a prefix test that is not anchored at a
// segment boundary would let `Ders/` match `Dersler/`, which is a different
// folder that happens to start with the same letters.
//
// Case-insensitive, because the catalog keeps the DISPLAY case of a path while
// the scope may arrive with different case. Lowercasing here is for the test
// only; the stored value keeps its case (see `canonical_display_folder`).

/** Whether an attachment's folder is inside the scope, or is the scope itself. */
export function folderMatchesScope(folder: string, scope: string): boolean {
  const f = folder.toLowerCase();
  const sc = scope.toLowerCase();
  if (sc === "") return true;
  const anchored = sc.endsWith("/") ? sc : `${sc}/`;
  return f === sc || f.startsWith(anchored);
}
