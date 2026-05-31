// TS mirror of the Rust `SearchResult` DTO returned by `note_search`
// (src-tauri/src/plugins/notes/commands.rs). Manually kept in sync — there is
// no codegen (see src/CLAUDE.md "Tauri command bindings"). Field names match
// serde's serialization exactly (snake_case `note_id` / `matched_in`).

/**
 * Which field(s) the query matched in for a hit (MYND-40). Drives the command
 * palette's "matched in body" badge: a body-only hit (`{title:false, body:true}`)
 * is a note whose title does not contain the query, so the row is marked.
 * Computed by the engine with its own stemmer, so it is precise where a
 * frontend substring check would be wrong (stemmed / Turkish-cased matches).
 */
export type NoteMatchedIn = {
  title: boolean;
  body: boolean;
};

/** One ranked full-text search hit returned to the command palette. */
export type NoteSearchResult = {
  note_id: string;
  title: string;
  score: number;
  matched_in: NoteMatchedIn;
};
