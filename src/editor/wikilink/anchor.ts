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

import { headingSections } from "../../dialect";
import { foldSegment } from "../../dialect/folderPath";

/** The generic anchor a deep-link carries into the open chain (SYNC-5). At most
 *  one of `heading` / `blockId` is set in practice (the parser keeps the first
 *  `#`/`^` only), but both are optional so any caller can thread it. */
export type WikilinkAnchor = {
  heading?: string | null;
  blockId?: string | null;
};

/** True when an anchor carries any navigable target (so the open chain knows to
 *  schedule a post-load scroll instead of landing at the note top). */
export function hasAnchor(anchor: WikilinkAnchor | null | undefined): boolean {
  if (anchor === null || anchor === undefined) return false;
  return (
    (anchor.heading !== null && anchor.heading !== undefined && anchor.heading !== "") ||
    (anchor.blockId !== null && anchor.blockId !== undefined && anchor.blockId !== "")
  );
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
 * Resolve a generic anchor to a scroll offset in `body`, or `null` for "no
 * anchor target → scroll to note top" (§5.6 step 3). Heading anchor takes
 * precedence over a block anchor when both are somehow present (the parser only
 * keeps the first `#`/`^`, so in practice exactly one is set).
 */
export function resolveAnchorOffset(
  body: string,
  anchor: WikilinkAnchor | null | undefined,
): number | null {
  if (anchor === null || anchor === undefined) return null;
  if (anchor.heading !== null && anchor.heading !== undefined && anchor.heading !== "") {
    return findHeadingOffset(body, anchor.heading);
  }
  if (anchor.blockId !== null && anchor.blockId !== undefined && anchor.blockId !== "") {
    return findBlockOffset(body, anchor.blockId);
  }
  return null;
}
