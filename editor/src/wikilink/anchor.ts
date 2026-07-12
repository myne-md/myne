// Anchor resolution for wikilink deep-links (MYND-305, `wikilink.md` §5.6).
//
// Turns a wikilink anchor (`#Heading` or imported `^block-id`) into a scroll
// target — a byte offset into the resolved note's body — or `null` when the
// anchor matches nothing (the caller then scrolls to the note top, §5.6 step 3).
//
// SYNC-1: heading enumeration reuses the ONE canonical `headingSections` surface
// (`src/dialect/visitors/headingSections.ts`, shared with heading-list-folding /
// MYND-300). No forked heading model, no second parser.
//
// SYNC-5: the anchor itself is the GENERIC `{ heading?, blockId? }` shape carried
// through the open chain — not a wikilink-specific side channel — so backlinks /
// the command palette can reuse this seam (PRD story 10).
//
// Heading match: `foldSegment` fold-identity on the heading text (NFC + Unicode
// lowercase, the §3.6.2 segment-identity rule). NO slug normalization. Duplicate
// heading text → FIRST match wins (deterministic). Imported `^block-id`: reads an
// existing end-of-line marker only — mints nothing, builds no index (§9).

import { headingSections } from "@myne/dialect";
import { foldSegment } from "@myne/dialect/folderPath";

/** The generic anchor a deep-link carries into the open chain (SYNC-5). The
 *  wikilink parser sets at most one of `heading` / `blockId` (it keeps the first
 *  `#`/`^`); the command palette's scroll-to-match sets `query` (MYND-448). One
 *  union, one resolver (`resolveAnchorRange`) — no per-caller side channel. */
export type WikilinkAnchor = {
  heading?: string | null;
  blockId?: string | null;
  /** MYND-448 scroll-to-match: a free-text search query whose earliest literal
   *  term occurrence becomes the scroll + SELECT target. */
  query?: string | null;
};

/** A resolved scroll target span. Heading/block anchors are zero-length (caret
 *  at the line start); a `query` anchor carries the matched range so the editor
 *  selects it (MYND-448 D4). */
export interface AnchorRange {
  from: number;
  to: number;
}

/** True when an anchor carries any navigable target (so the open chain knows to
 *  schedule a post-load scroll instead of landing at the note top). */
export function hasAnchor(anchor: WikilinkAnchor | null | undefined): boolean {
  if (anchor === null || anchor === undefined) return false;
  return (
    (anchor.heading !== null && anchor.heading !== undefined && anchor.heading !== "") ||
    (anchor.blockId !== null && anchor.blockId !== undefined && anchor.blockId !== "") ||
    (anchor.query !== null && anchor.query !== undefined && anchor.query !== "")
  );
}

/** Escape a query term for use as a literal in a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The earliest literal occurrence of ANY whitespace-separated term of `query`
 * in `body`, as a `{from,to}` range so the caller can SELECT the match (MYND-448
 * D3/D4). Case-insensitive (Unicode `i`); a purely-stemmed BM25 hit with no
 * literal term occurrence returns `null` → the caller scrolls to the note top
 * (graceful no-op). Multi-word queries land on whichever term appears first.
 */
export function findQueryRange(body: string, query: string): AnchorRange | null {
  const terms = query.trim().split(/\s+/).filter((term) => term.length > 0);
  let best: AnchorRange | null = null;
  for (const term of terms) {
    let match: RegExpExecArray | null = null;
    try {
      match = new RegExp(escapeRegExp(term), "iu").exec(body);
    } catch {
      match = null;
    }
    if (match !== null && (best === null || match.index < best.from)) {
      best = { from: match.index, to: match.index + match[0].length };
    }
  }
  return best;
}

/**
 * The byte offset (heading LINE start) of the FIRST heading in `body` whose
 * folded text equals the folded `heading` anchor, or `null` when none match.
 * Duplicate headings → first wins (§5.6 step 1). Fold-identity only — never a
 * slug. An empty / whitespace-only anchor matches nothing.
 */
export function findHeadingOffset(body: string, heading: string): number | null {
  const key = foldSegment(heading.trim());
  if (key === "") return null;
  for (const section of headingSections(body)) {
    if (foldSegment(section.text.trim()) === key) return section.from;
  }
  return null;
}

// An imported Obsidian block marker: a `^block-id` at the END of a line (the
// id is `[A-Za-z0-9-]+`, Obsidian's grammar). We MATCH an existing marker; we
// never write one (§9 — Myne mints no block-ids). The id capture excludes the
// leading `^`.
function blockMarkerRegex(blockId: string): RegExp | null {
  if (!/^[A-Za-z0-9-]+$/.test(blockId)) return null;
  // Escape is unnecessary — the id charset has no regex metacharacters — but the
  // guard above already rejects anything that would.
  return new RegExp(`(?:^|[ \\t])\\^${blockId}[ \\t]*$`, "m");
}

/**
 * The byte offset of an imported `^block-id` marker in `body`, or `null` when
 * absent (§5.6 step 2). Returns the offset of the line START carrying the
 * marker so the scroll lands on the marked block. Reads only; mints nothing.
 */
export function findBlockOffset(body: string, blockId: string): number | null {
  const id = blockId.startsWith("^") ? blockId.slice(1) : blockId;
  const re = blockMarkerRegex(id);
  if (re === null) return null;
  const m = re.exec(body);
  if (m === null) return null;
  // Map the match start back to its line start (the marker sits at EOL; the
  // block it tags begins at the line start).
  const matchAt = m.index;
  const lineStart = body.lastIndexOf("\n", matchAt - 1) + 1;
  return lineStart;
}

/**
 * Resolve a generic anchor to a scroll + SELECT range in `body`, or `null` for
 * "no anchor target → scroll to note top" (§5.6 step 3). ONE resolver, ONE
 * precedence (SYNC-5): heading > blockId > query. Heading/block are zero-length
 * (caret at the line start, no selection); a `query` anchor carries the matched
 * span so the editor selects it. In practice the wikilink parser sets exactly
 * one of heading/blockId; the palette sets query.
 */
export function resolveAnchorRange(
  body: string,
  anchor: WikilinkAnchor | null | undefined,
): AnchorRange | null {
  if (anchor === null || anchor === undefined) return null;
  if (anchor.heading !== null && anchor.heading !== undefined && anchor.heading !== "") {
    const offset = findHeadingOffset(body, anchor.heading);
    return offset === null ? null : { from: offset, to: offset };
  }
  if (anchor.blockId !== null && anchor.blockId !== undefined && anchor.blockId !== "") {
    const offset = findBlockOffset(body, anchor.blockId);
    return offset === null ? null : { from: offset, to: offset };
  }
  if (anchor.query !== null && anchor.query !== undefined && anchor.query !== "") {
    return findQueryRange(body, anchor.query);
  }
  return null;
}

/** Back-compat: the scroll OFFSET (range start) of a resolved anchor. */
export function resolveAnchorOffset(
  body: string,
  anchor: WikilinkAnchor | null | undefined,
): number | null {
  const range = resolveAnchorRange(body, anchor);
  return range === null ? null : range.from;
}
