// Client-side full-text note search — the mobile stand-in for the desktop
// `note_search` (MYS1 BM25) backend. Desktop persists a ranked index for scale;
// here we scan the already-decrypted note bodies (same "compute over loaded
// notes" pattern as the Graph tab). A persisted MYS1 index is a later scale
// refinement; this searches full CONTENT (not just title/snippet) with a simple
// title-weighted, frequency-aware ranking and a match-context snippet.

export interface SearchHit {
  id: string;
  title: string;
  /** Match context from the body, or the note's own snippet when unmatched. */
  snippet: string;
  score: number;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/** ~70-char context window around the first occurrence of `term` in `body`. */
export function matchSnippet(body: string, term: string): string | null {
  const idx = body.toLowerCase().indexOf(term.toLowerCase());
  if (idx < 0) return null;
  const start = Math.max(0, idx - 28);
  const end = Math.min(body.length, idx + term.length + 42);
  let s = body.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) s = "…" + s;
  if (end < body.length) s = s + "…";
  return s;
}

/**
 * Rank notes against a query. AND semantics: every whitespace-separated term
 * must appear in the title or body. Title matches weight heavily; body matches
 * add a frequency-scaled boost. An empty query returns every note in the input
 * order (score 0), so the caller can render the full list. Results are sorted by
 * descending score (ties keep input order — a stable sort).
 */
export function searchNotes(
  query: string,
  notes: readonly { id: string; title: string; snippet: string }[],
  bodies: Map<string, string>,
): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return notes.map((n) => ({ id: n.id, title: n.title, snippet: n.snippet, score: 0 }));

  const terms = q.split(/\s+/).filter(Boolean);
  const hits: SearchHit[] = [];

  for (const n of notes) {
    const title = n.title.toLowerCase();
    const rawBody = bodies.get(n.id) ?? "";
    const body = rawBody.toLowerCase();

    let score = 0;
    let allPresent = true;
    for (const t of terms) {
      const inTitle = title.includes(t);
      const bodyCount = countOccurrences(body, t);
      if (!inTitle && bodyCount === 0) {
        allPresent = false;
        break;
      }
      if (inTitle) score += 10;
      if (bodyCount > 0) score += 1 + Math.min(bodyCount, 20) * 0.2;
    }
    if (!allPresent) continue;

    const snippet = matchSnippet(rawBody, terms[0]) ?? n.snippet;
    hits.push({ id: n.id, title: n.title, snippet, score });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits;
}
