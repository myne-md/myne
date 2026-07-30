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

/** A color-group key, shape-checked. Anchored at the FIRST character on
 *  purpose: a plain `[a-z0-9-]+` also accepts a key that already carries the
 *  `--` prefix, which composes into `var(----group-rose)` — a syntactically
 *  valid custom-property name that nothing ever defines, so the declaration is
 *  invalid at computed-value time and the property silently falls back to its
 *  initial value (transparent, for a background). */
const TOKEN_KEY = /^[a-z0-9][a-z0-9-]*$/;

/**
 * One color-group key as a CSS `var()` expression, for the surfaces that paint
 * it DECLARATIVELY (a swatch's inline `background`, an SVG `fill`) instead of
 * resolving it through computed style the way {@link GraphCanvas} does.
 *
 * {@link ColorGroup.color} is synced, peer-authorable content — not a
 * compile-time constant — so two values reach here that the palette picker can
 * never produce: a malformed key, and a well-formed key naming a token this
 * build does not define (a ninth palette entry authored by a future client).
 * The canvas degrades both by reading the computed value back and testing it
 * for empty; declarative CSS cannot read it back, so the degrade has to be
 * written into the expression. Both land on `--fg-2`, the same neutral node
 * color an unclassified node gets (`GraphCanvas`'s neutral batch), so the
 * editor's swatch and the graph agree about a key neither of them understands.
 *
 * Shared rather than duplicated per client for the reason the evaluator is:
 * the value crosses the client boundary through `vault.prefs`, so the two ends
 * must not drift about what it means.
 */
export function colorGroupVar(color: string | undefined): string {
  return color !== undefined && TOKEN_KEY.test(color)
    ? `var(--${color}, var(--fg-2))`
    : "var(--fg-2)";
}

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

/** Collect every folded `hasTag` tag reachable in `node`'s subtree into `out`. */
function collectTagsInto(node: FilterNode, out: Set<string>): void {
  switch (node.kind) {
    case "and":
    case "or":
      for (const child of node.children) collectTagsInto(child, out);
      return;
    case "not":
      collectTagsInto(node.child, out);
      return;
    case "hasTag": {
      // Stored in the SAME folded form `matchesTag` compares against, so a
      // membership answer keyed here lands on the leaf that asked for it. A
      // tag with no non-whitespace content denotes nothing and is skipped —
      // `matchesTag` would reject it too, so skipping only avoids a pointless
      // index query, it never changes the resolved colors.
      const folded = foldSegment(node.tag);
      if (folded.trim().length > 0) out.add(folded);
      return;
    }
    default:
      // No other leaf carries a tag (and the unsupported ones never match).
      return;
  }
}

/**
 * The distinct, folded tags the ENABLED rules reference — i.e. exactly the set
 * of `vault_indices_by_tag` queries the caller must run before it can assemble
 * {@link ColorGroupNoteMeta}. Disabled rules are skipped: a rule that cannot
 * match owes no index query. Pure.
 *
 * The result is O(rules), not O(tags in the vault) and certainly not O(notes) —
 * this is what keeps the paint-time assembly off a per-note or per-rule IPC
 * fan-out (the same `hasTag → byTag(tag)` shape `useRunViewContext` already
 * uses for Saved Views, so both surfaces agree on tag membership by
 * construction).
 */
export function collectRuleTags(
  rules: ReadonlyArray<ColorGroup>,
): string[] {
  const tags = new Set<string>();
  for (const rule of rules) {
    if (!rule.enabled) continue;
    collectTagsInto(rule.filter, tags);
  }
  return [...tags];
}

/**
 * Assemble the resolver's input from what the graph pane already holds: the
 * model's node ids, the resident note-set's folder map, and the tag index's
 * answer for each tag {@link collectRuleTags} asked about (`folded tag → note
 * ids`, already subtree-inclusive Rust-side).
 *
 * A node with no entry in `folderById` is treated as unfiled (`folder: null`)
 * rather than dropped — the graph's node-set and the resident note-set are
 * derived from the same cache, but a node the map has not caught up with must
 * still render (neutral, or matched by a tag rule), never disappear.
 *
 * Pure: no IPC, no canvas, no `GraphNode` import (the model stays `{id,title}`).
 */
export function buildColorGroupNoteMeta(
  nodeIds: ReadonlyArray<string>,
  folderById: ReadonlyMap<string, string | null>,
  tagMembers: ReadonlyMap<string, ReadonlySet<string>>,
): ColorGroupNoteMeta[] {
  return nodeIds.map((id) => {
    const tags: string[] = [];
    for (const [tag, members] of tagMembers) {
      if (members.has(id)) tags.push(tag);
    }
    return { id, tags, folder: folderById.get(id) ?? null };
  });
}
