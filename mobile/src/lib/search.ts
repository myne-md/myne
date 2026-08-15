// Backend full-text search (MYS1 BM25 engine, shared `myne-core::search`). The
// mobile WebView already holds every note's plaintext, so it pushes the corpus
// to the in-RAM index (`search_index_replace`) and queries it (`note_search`) —
// BM25 ranking + stemming + Turkish-correct folding, matching desktop, without a
// TS re-implementation. Falls back to nothing in browser-dev (no Tauri host);
// the caller uses the client-side `searchNotes` there.

import { invoke } from "../platform/core";

export interface SearchDoc {
  id: string;
  title: string;
  body: string;
}

/** One backend hit — note the snake_case fields (Tauri camelCases command args,
 *  NOT serialized struct fields). */
export interface NoteSearchResult {
  note_id: string;
  title: string;
  score: number;
}

/** Replace the whole search index with the given corpus (atomic bulk swap).
 *  The SEED, used once per unlock — feeding the corpus on every save is what
 *  made one note's edit cost work proportional to the vault (myne-mobile#41). */
export function searchIndexReplace(docs: SearchDoc[]): Promise<void> {
  return invoke("plugin:search|search_index_replace", { docs });
}

/** Re-index just the notes that changed (replace-semantics per id), leaving the
 *  rest of the corpus in place. Batched so one sweep is one round-trip. */
export function searchIndexApply(docs: SearchDoc[]): Promise<void> {
  return invoke("plugin:search|search_index_apply", { docs });
}

/** Drop notes from the index by id — without this a purged note keeps matching
 *  queries until the next full replace. */
export function searchIndexRemove(ids: string[]): Promise<void> {
  return invoke("plugin:search|search_index_remove", { ids });
}

/** Query the index; ≤50 hits, highest BM25 score first. */
export function noteSearch(query: string): Promise<NoteSearchResult[]> {
  return invoke<NoteSearchResult[]>("plugin:search|note_search", { query });
}
