// Pure candidate ranking for the `[[#` / `[[##` heading autocomplete (MYND-305,
// `wikilink.md` §6.1) — extracted from the picker ViewPlugin so it's unit-
// testable without a view. Mirrors `picker-rank.ts` (the note picker): fuzzy-
// match via the shared `fuzzyFilter` scorer (no new dependency), cap the result.
//
//  - `[[#`  ranks the CURRENT note's headings (from `headingSections(doc)`).
//  - `[[##` ranks vault-wide headings (from the `vaultHeadingsFacet`), each row
//    carrying its note context so duplicates across notes are distinguishable.

import { fuzzyFilter, type FuzzyCandidate } from "@myne/editor/host/commands/fuzzy";
import type { HeadingSection } from "@myne/dialect";
import type { VaultHeading } from "./vault-headings";
import type { VaultBlockAnchor } from "./vault-block-anchors";
import { PICKER_CAP } from "./picker-rank";

/** A current-note heading row (`[[#`) — inserts the compact `[[#Heading]]`. */
export type CurrentHeadingRow = {
  kind: "current-heading";
  heading: string;
  level: number;
};
/** A vault-wide heading row (`[[##`) — inserts the full §3.5 path form. */
export type VaultHeadingRow = { kind: "vault-heading"; entry: VaultHeading };
/** A vault-wide block-anchor row (`[[^^`, MYND-382) — inserts `[[Note^blockId]]`. */
export type VaultBlockAnchorRow = {
  kind: "vault-block-anchor";
  entry: VaultBlockAnchor;
};

/**
 * Rank the current note's headings against `query`. De-duplicates identical
 * heading text (the FIRST occurrence wins — anchor resolution lands on the first
 * match anyway, §5.6, so offering the same text twice would be noise). Headings
 * with empty text are excluded (can't author an anchor to an empty heading).
 */
export function rankCurrentHeadings(
  query: string,
  sections: readonly HeadingSection[],
  cap: number = PICKER_CAP,
): CurrentHeadingRow[] {
  const seen = new Set<string>();
  const candidates: FuzzyCandidate<CurrentHeadingRow>[] = [];
  for (const s of sections) {
    const text = s.text.trim();
    if (text === "" || seen.has(text)) continue;
    seen.add(text);
    candidates.push({
      item: { kind: "current-heading", heading: text, level: s.level },
      haystacks: [text],
    });
  }
  return fuzzyFilter(candidates, query)
    .slice(0, cap)
    .map((m) => m.item);
}

/**
 * Rank vault-wide imported block anchors against `query` (MYND-382, `[[^^`),
 * matching the block id, its preview text, AND the owning note's title (so
 * "spec revenue" finds a `^revenue` block in the "Spec" note). No de-dupe across
 * notes — the same block id in two notes is two distinct targets. Enumerate-only:
 * these come from the vault-indices scan of already-existing markers.
 */
export function rankVaultBlockAnchors(
  query: string,
  anchors: readonly VaultBlockAnchor[],
  cap: number = PICKER_CAP,
): VaultBlockAnchorRow[] {
  const candidates: FuzzyCandidate<VaultBlockAnchorRow>[] = anchors.map((a) => ({
    item: { kind: "vault-block-anchor" as const, entry: a },
    haystacks: [a.blockId, a.preview, a.title ?? ""],
  }));
  return fuzzyFilter(candidates, query)
    .slice(0, cap)
    .map((m) => m.item);
}

/**
 * Rank vault-wide headings against `query`, matching the heading text AND the
 * owning note's title (so "spec goals" finds a `## Goals` in the "Spec" note).
 * Entries with empty heading text are excluded. No de-dupe across notes — a
 * `## Setup` in two notes is two legitimately-distinct targets.
 */
export function rankVaultHeadings(
  query: string,
  headings: readonly VaultHeading[],
  cap: number = PICKER_CAP,
): VaultHeadingRow[] {
  const candidates: FuzzyCandidate<VaultHeadingRow>[] = headings
    .filter((h) => h.heading.trim() !== "")
    .map((h) => ({
      item: { kind: "vault-heading" as const, entry: h },
      haystacks: [h.heading, h.title ?? ""],
    }));
  return fuzzyFilter(candidates, query)
    .slice(0, cap)
    .map((m) => m.item);
}
