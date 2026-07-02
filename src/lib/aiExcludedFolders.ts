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
// vault), require the entry to end in `/` before a prefix (nesting) match, and
// canonicalize BOTH sides with NFC + case-fold so the comparison is diacritic-
// and case-insensitive (a note under `Private/` stays excluded when the entry
// was typed `private/` on a case-insensitive filesystem, SYNC-14).

/** NFC-normalize then case-fold — the Rust `canonical_folder` twin. */
function canonicalFolder(folder: string): string {
  return folder.normalize("NFC").toLowerCase();
}

/**
 * Whether a note living in `noteFolder` is excluded from AI by the
 * `ai_excluded_folders` set. `noteFolder` is a canonical trailing-slash folder
 * path, or `""` for the vault root.
 */
export function isNoteAiExcluded(
  noteFolder: string,
  excluded: readonly string[],
): boolean {
  if (excluded.length === 0) return false;
  const raw =
    noteFolder === "" || noteFolder.endsWith("/") ? noteFolder : `${noteFolder}/`;
  const folder = canonicalFolder(raw);
  return excluded.some((ex) => {
    const e = canonicalFolder(ex);
    return e.length > 0 && (folder === e || (e.endsWith("/") && folder.startsWith(e)));
  });
}
