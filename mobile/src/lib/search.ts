// Backend full-text search (MYS1 BM25 engine, shared `myne-core::search`). The
// mobile WebView already holds every note's plaintext, so it pushes the corpus
// to the in-RAM index (`search_index_replace`) and queries it (`note_search`) —
// BM25 ranking + stemming + Turkish-correct folding, matching desktop, without a
// TS re-implementation. Falls back to nothing in browser-dev (no Tauri host);
// the caller uses the client-side `searchNotes` there.

import { invoke } from "@tauri-apps/api/core";

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

/** Replace the whole search index with the given corpus (atomic bulk swap). */
export function searchIndexReplace(docs: SearchDoc[]): Promise<void> {
  return invoke("plugin:search|search_index_replace", { docs });
}

/** Query the index; ≤50 hits, highest BM25 score first. */
export function noteSearch(query: string): Promise<NoteSearchResult[]> {
  return invoke<NoteSearchResult[]>("plugin:search|note_search", { query });
}
