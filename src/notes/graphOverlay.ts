// The graph's OVERLAY: what the model looks like once tags become nodes and the
// colour rules are applied (myne-md/myne#727).
//
// One pure function, called by every client, because the two clients used to
// answer "what does the graph look like" separately and drifted: mobile drew
// notes only, with no colour groups and no tag nodes, while desktop drew all
// three. "Identical behaviour" is not a promise anyone can keep by copying code
// twice; it is what you get when there is one implementation and two callers.
//
// Pure: no IPC, no canvas, no React. The caller supplies the rules (authored or
// derived), the tag list, and the tag memberships it already holds, and gets
// back the model to render and the colour map to paint it with.

import {
  buildColorGroupNoteMeta,
  collectRuleTags,
  effectiveColorGroups,
  resolveGraphColorGroups,
  tagNodeRules,
} from "./graphColorGroups";
import {
  tagNodeId,
  withTagNodes,
  type GraphModel,
  type TagMembership,
} from "./graphModel";
import type { ColorGroup } from "../lib/prefs";

/** A tag as the graph sees it: a folded key, a display name, and how many notes
 *  it covers (subtree-inclusive, so a parent tag counts its descendants). */
export interface GraphTag {
  key: string;
  display: string;
  subtreeCount: number;
}

export interface GraphOverlay {
  /** The model to render: the built one, plus a node per tag in the whole-vault
   *  view. Identical to the input when there is nothing to add, so a caller can
   *  compare by identity. `null` only on the sentinel a caller uses before its
   *  first build resolves. */
  model: GraphModel | null;
  /** note-or-tag node id → colour-group token key (`group-teal`). */
  colors: ReadonlyMap<string, string>;
  /** How many groups the DERIVED default is contributing, for a panel that wants
   *  to say so and offer to make them editable. Zero when the vault has authored
   *  rules. */
  derivedGroupCount: number;
}

const EMPTY: ReadonlyMap<string, string> = new Map();

/**
 * Build the render-time overlay.
 *
 * `wholeVault` is the one thing the caller decides: a tag node has no place in
 * a neighbourhood BFS, a tag's own subgraph or an orphan list, so those views
 * pass `false` and stay notes-only. Everything else is the same on every client.
 */
export function buildGraphOverlay(input: {
  model: GraphModel;
  /** The vault's authored rules, possibly empty. */
  colorGroups: ReadonlyArray<ColorGroup>;
  /** Every tag the client knows about, for the derived default grouping. */
  tags: ReadonlyArray<GraphTag>;
  /** Folded tag → the note ids carrying it, subtree-inclusive. */
  members: ReadonlyMap<string, ReadonlySet<string>>;
  /** Note id → its canonical folder path, or null at the vault root. */
  folderById: ReadonlyMap<string, string | null>;
  wholeVault: boolean;
}): GraphOverlay {
  const rules = effectiveColorGroups(input.colorGroups, input.tags);
  const derivedGroupCount =
    input.colorGroups.length === 0 ? defaultGroupCount(input.tags) : 0;

  // The tags the rules reference: the exact set of memberships owed. The
  // tag-node rules are a subset, so a hub costs no extra lookup.
  const queried = new Map<string, ReadonlySet<string>>();
  for (const tag of collectRuleTags(rules)) {
    queried.set(tag, input.members.get(tag) ?? new Set());
  }

  const meta = buildColorGroupNoteMeta(
    input.model.nodes.map((n) => n.id),
    input.folderById,
    queried,
  );
  const colors = new Map(resolveGraphColorGroups(rules, meta));

  // --- Tag nodes: whole-vault view only -----------------------------------
  const hubs: TagMembership[] = [];
  if (input.wholeVault) {
    const displayByKey = new Map(input.tags.map((t) => [t.key, t.display]));
    // A tag whose members are all outside this model contributes NO hub, and so
    // must contribute no COLOUR either: a colour for a node that is not in the
    // picture is an entry nothing reads, and it is what stops the empty case
    // from handing back the same stable map every time.
    const live = new Set(input.model.nodes.map((n) => n.id));
    for (const rule of tagNodeRules(rules)) {
      const all = queried.get(rule.key);
      if (all === undefined) continue;
      const members = new Set([...all].filter((id) => live.has(id)));
      if (members.size === 0) continue;
      hubs.push({
        key: rule.key,
        display: displayByKey.get(rule.key) ?? rule.key,
        members,
      });
      // The hub is painted from the SAME map the notes are, so a hub and its
      // notes cannot disagree about the group they belong to. The hub's colour
      // is its rule's, which is not always the colour its notes got: a rule
      // earlier in the list can claim a note first, and that is correct.
      colors.set(tagNodeId(rule.key), rule.color);
    }
  }

  return {
    model: withTagNodes(input.model, hubs),
    colors: colors.size === 0 ? EMPTY : colors,
    derivedGroupCount,
  };
}

function defaultGroupCount(
  tags: ReadonlyArray<{ subtreeCount: number }>,
): number {
  return Math.min(
    tags.filter((t) => t.subtreeCount >= 2).length,
    // The palette's length, which is the other bound on how many derived groups
    // can exist. Imported lazily to keep this module's import graph flat.
    GROUP_COLOR_KEYS_LENGTH,
  );
}

/** Kept as a constant rather than an import of the array, so this module does
 *  not pull the palette in just to take its length. `check-token-parity` does
 *  not read this file; the value is asserted equal to `GROUP_COLOR_KEYS.length`
 *  by a test instead. */
const GROUP_COLOR_KEYS_LENGTH = 8;

/**
 * The tag list and memberships, from the two maps a client-side tag index
 * already holds (`folded tag → note ids`, `folded tag → display name`).
 *
 * Mobile derives tags in the WebView rather than from the Rust tag tree, so it
 * has no `subtreeCount`; this computes the same subtree-inclusive count the tree
 * reports, by unioning a tag's own notes with every descendant's. Without it the
 * two clients would disagree about which tags qualify for the derived default
 * grouping (a parent tag whose own notes are few but whose descendants are many
 * would be dropped on mobile and kept on desktop).
 */
export function tagIndexToGraphTags(
  byTag: ReadonlyMap<string, ReadonlyArray<string>>,
  display: ReadonlyMap<string, string>,
): { tags: GraphTag[]; members: ReadonlyMap<string, ReadonlySet<string>> } {
  const members = new Map<string, ReadonlySet<string>>();
  for (const [tag, ids] of byTag) members.set(tag, new Set(ids));

  const tags: GraphTag[] = [];
  for (const tag of byTag.keys()) {
    const subtree = new Set<string>();
    for (const [other, ids] of members) {
      if (other === tag || other.startsWith(`${tag}/`)) {
        for (const id of ids) subtree.add(id);
      }
    }
    tags.push({
      key: tag,
      display: display.get(tag) ?? tag,
      subtreeCount: subtree.size,
    });
  }
  return { tags, members };
}
