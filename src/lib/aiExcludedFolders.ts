// AI excluded-folders filter (local-ai epic, ai-ux-surface MYND-408, task 6,
// SYNC-14). The queryable predicate the AI capability siblings (semantic
// search, summarization, auto-tag) consume to skip a note whose folder the user
// excluded from AI read/index.
//
// The set (`prefs.ai_excluded_folders`) holds canonical trailing-slash folder
// paths (NFC-normalized, sorted, deduped by the Rust codec). A note is excluded
// when its folder equals OR is nested under any excluded folder — the trailing
// slash makes the nesting check a plain prefix test that can't false-match a
// sibling whose name merely starts with the excluded name (`Private/` excludes
// `Private/Notes/` but NOT `PrivateStuff/`).
//
// This is the frontend mirror of the Rust `folder_matches_excluded`
// (`src-tauri/src/plugins/local_inference/vector_store.rs`) — the two MUST agree
// so a note gated on one path is gated on the other (a divergence is a privacy
// hole). Both sides: guard against an empty entry (would exclude the whole
// vault), canonicalize BOTH sides structurally (so every non-empty key ends in
// `/` and the nesting test is one prefix check that can't reach a sibling), and
// fold with NFC + case so the comparison is diacritic- and case-insensitive (a
// note under `Private/` stays excluded when the entry was typed `private/` on a
// case-insensitive filesystem, SYNC-14).

/**
 * Structural normalization then NFC + case-fold — the Rust `canonical_folder`
 * twin, and the same key `dialect/src/folderPath.ts::folderKey` produces.
 *
 * The structural half is the load-bearing one: the prefs codec does not
 * canonicalize the path shape, and `markdown-dialect.md` §3.6.2 says reads
 * TOLERATE a missing trailing slash and leading/duplicate slashes — so a note
 * carrying `folder: Private` displays inside `Private/` while a raw comparison
 * would leave it outside the user's own exclusion.
 */
function canonicalFolder(folder: string): string {
  const segments = folder.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return "";
  return `${segments.join("/").normalize("NFC").toLowerCase()}/`;
}

/**
 * Whether a note living in `noteFolder` is excluded from AI by the
 * `ai_excluded_folders` set. `noteFolder` is a folder path in any tolerated
 * shape, or `""` for the vault root.
 */
export function isNoteAiExcluded(
  noteFolder: string,
  excluded: readonly string[],
): boolean {
  if (excluded.length === 0) return false;
  const folder = canonicalFolder(noteFolder);
  if (folder === "") return false; // the vault root is under no real entry
  return excluded.some((ex) => {
    const e = canonicalFolder(ex);
    return e.length > 0 && folder.startsWith(e);
  });
}
