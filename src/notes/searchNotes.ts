// IPC wrapper for the `note_search` Tauri command (MYND-29 backend; consumed
// by MYND-40's command-palette full-text note search).
//
// Slot::Unlocked-gated BM25 full-text search over note title + body. Returns a
// BM25-ranked, top-N-capped list of {note_id, title, score, matched_in}, or an
// empty list when the vault is not unlocked OR the query is empty (the Rust
// command is infallible — it never returns an error variant; the empty-query
// browse list is the frontend's job, see the command palette). A transport-
// level failure still rejects the invoke promise, so callers that care guard
// with try/catch.

import { invoke } from "@tauri-apps/api/core";
import type { NoteSearchResult } from "../types/note-search-result";

/**
 * Full-text search the live in-RAM index. Resolves to an empty list when the
 * vault is locked or the query is empty.
 */
export async function searchNotes(query: string): Promise<NoteSearchResult[]> {
  return await invoke<NoteSearchResult[]>("plugin:notes|note_search", { query });
}

/**
 * Generation-guard decision for the async note-search type-ahead (MYND-40):
 * apply an arriving result ONLY if it belongs to the latest dispatched query.
 *
 * Tauri `invoke` is not cancelable, so an earlier query's response can land
 * AFTER a newer one (the user typed "ru" → "rus" → "rust" and "ru" resolves
 * last). Stamping each dispatch with a monotonically increasing sequence and
 * applying a response only when its sequence is still the latest keeps the
 * rendered list consistent with what the user last typed — a stale response
 * is dropped rather than overwriting fresher results.
 *
 * Pure + side-effect-free (no React, no IPC) so it is unit-testable the moment
 * a JS test runner lands (PRD testing decision).
 */
export function shouldApplyNoteSearchResult(
  resultSeq: number,
  latestSeq: number,
): boolean {
  return resultSeq === latestSeq;
}

/** A one-line match-context snippet: the text just before / after the literal
 *  query occurrence, plus the matched span itself (so the UI can highlight it).
 *  Answers "what did this note match?" — e.g. a hit inside an image markdown
 *  reference reads as "…link: ![Clickable image](funny-reaction-gif…" instead
 *  of a bare "matched in body". */
export type MatchSnippet = { before: string; match: string; after: string };

/** Strip wikilink/embed punctuation + internal ids for a READABLE snippet.
 *  `![[att:<hex>|funny.gif]]` → `funny.gif` (the display alias) so a match
 *  inside an embedded-attachment reference doesn't surface the raw
 *  `att:<32-hex>` id and `![[ … ]]` brackets. `[[note|alias]]` → `alias`,
 *  `[[note]]` → `note`. Ordinary markdown image/link URLs are left intact (they
 *  may legitimately carry the searched filename). Display-only. */
function cleanSnippetText(s: string): string {
  return s
    .replace(/!?\[\[[^\]|]*\|([^\]]+)\]\]/g, "$1") // [[target|alias]] → alias
    .replace(/!?\[\[([^\]]+)\]\]/g, "$1"); // [[target]] → target
}

/**
 * Build a {@link MatchSnippet} around the FIRST case-insensitive literal
 * occurrence of `query` in `body`, with up to `radius` context chars each side
 * (whitespace collapsed to one line, ellipses at truncation). Returns `null`
 * when the query does not occur literally (a stem-only hit) — the caller then
 * keeps the plain "matched in body" marker. Display-only: uses `toLowerCase`
 * (not the engine's Turkish casefold), so a Turkish-cased match may not be
 * located; that is an acceptable degrade to the existing badge.
 */
export function extractMatchSnippet(
  body: string,
  query: string,
  radius = 34,
): MatchSnippet | null {
  const q = query.trim();
  if (q === "") return null;
  const text = cleanSnippetText(body);
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return null;
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + q.length + radius);
  const clean = (s: string): string => s.replace(/\s+/g, " ");
  return {
    before: (start > 0 ? "…" : "") + clean(text.slice(start, idx)),
    match: text.slice(idx, idx + q.length),
    after: clean(text.slice(idx + q.length, end)) + (end < text.length ? "…" : ""),
  };
}
