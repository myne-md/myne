// Color-group rule evaluation (graph-connection-ux-polish) — a PURE, IPC-free
// resolver over the {@link ColorGroup} rule list, consumed at canvas paint
// time by the graph renderer (task 8). No canvas dependency, no full-text
// search, no per-rule IPC: it reads tag/folder membership from note metadata
// already resident in memory (the caller assembles {@link ColorGroupNoteMeta}
// from whatever in-memory indices it already holds).
//
// Semantics (PRD "Rule precedence and disabled rules" + "Rule evaluation
// reuses the existing filter stack"):
// - Rules are evaluated in list order; the FIRST match wins.
// - A disabled rule is skipped but its position in the list is otherwise
//   irrelevant to this function (the caller owns retention).
// - A note matching nothing is absent from the returned map — the renderer
//   then falls back to the neutral node color.
// - Only the `hasTag` and `inFolder` leaves are supported in v1. Every other
//   leaf (`search`, `property`, `all`) — and any future leaf a newer client
//   might author — degrades to "no match" rather than throwing, so a rule
//   authored by a future version never breaks an older client's render
//   (forward-compat tolerance, same posture as the blob-format tolerances
//   elsewhere in the spec).

import { folderKey, foldSegment } from "../dialect/folderPath";
import type { ColorGroup, FilterNode } from "../lib/prefs";

/** The slice of a note's metadata a color-group rule can match against —
 *  deliberately narrow (v1 exposes only tag + folder leaves). `tags` and
 *  `folder` are the SAME shapes the rest of the notes domain already carries
 *  ({@link TagEntry.folded}-style folded tag strings; canonical trailing-slash
 *  folder path, or `null` for the vault root) — the caller assembles this from
 *  in-memory indices, never a fresh IPC call per rule. */
export interface ColorGroupNoteMeta {
  readonly id: string;
  /** The note's tags, folded (NFC + lowercase) — see `vaultIndices.ts`'s
   *  `TagEntry.folded`. Un-folded display tags also compare correctly since
   *  matching folds both sides. */
  readonly tags: ReadonlyArray<string>;
  /** Canonical trailing-slash folder path (e.g. `"Work/Project/"`), or `null`
   *  for a note at the vault root. */
  readonly folder: string | null;
}

/** Subtree-inclusive tag match — mirrors `vaultIndices.byTag`'s "tag or any
 *  descendant" semantics: a rule for `"work"` matches a note tagged `"work"`
 *  or `"work/urgent"`. */
function matchesTag(ruleTag: string, noteTags: ReadonlyArray<string>): boolean {
  const target = foldSegment(ruleTag);
  if (target.length === 0) return false;
  return noteTags.some((tag) => {
    const folded = foldSegment(tag);
    return folded === target || folded.startsWith(`${target}/`);
  });
}

/** Subtree-inclusive folder match — mirrors the query engine's `inFolder`
 *  leaf: a rule for `"Work/"` matches a note directly in `Work/` or any
 *  descendant folder. The vault root (empty path) is not a valid `inFolder`
 *  target, matching the query engine's own `folderSubtreeNoteIds` guard. */
function matchesFolder(rulePath: string, noteFolder: string | null): boolean {
  const target = folderKey(rulePath);
  if (target === "" || noteFolder === null) return false;
  return folderKey(noteFolder).startsWith(target);
}

/**
 * Whether `note` matches `node`. Recurses through the boolean combinators
 * (`and`/`or`/`not`) exactly; any leaf outside the v1 allow-list (`hasTag`,
 * `inFolder`) degrades that leaf to `false` rather than throwing — so a
 * combinator containing one unsupported leaf still evaluates correctly on its
 * supported siblings.
 */
function matchesFilter(node: FilterNode, note: ColorGroupNoteMeta): boolean {
  switch (node.kind) {
    case "and":
      return node.children.every((child) => matchesFilter(child, note));
    case "or":
      return node.children.some((child) => matchesFilter(child, note));
    case "not":
      return !matchesFilter(node.child, note);
    case "hasTag":
      return matchesTag(node.tag, note.tags);
    case "inFolder":
      return matchesFolder(node.path, note.folder);
    default:
      // "search" / "property" / "all", or any leaf a future client added —
      // unsupported in v1: degrade to no-match, never throw.
      return false;
  }
}

/**
 * Resolve the color-group rule list to a note-id → color-key map, pure and
 * IPC-free. First match wins; disabled rules are skipped (never matched, but
 * `rules` itself is returned untouched — retention is the caller's list, not
 * this function's concern); a note matching nothing is absent from the map.
 * An empty rule list is a no-op (returns an empty map without touching
 * `notes`).
 */
export function resolveGraphColorGroups(
  rules: ReadonlyArray<ColorGroup>,
  notes: ReadonlyArray<ColorGroupNoteMeta>,
): Map<string, string> {
  const colors = new Map<string, string>();
  const active = rules.filter((rule) => rule.enabled);
  if (active.length === 0) return colors;
  for (const note of notes) {
    for (const rule of active) {
      if (matchesFilter(rule.filter, note)) {
        colors.set(note.id, rule.color);
        break;
      }
    }
  }
  return colors;
}
