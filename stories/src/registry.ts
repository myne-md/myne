// The story registry: the single list the shell, the coverage guard, the search
// and the inspector all read (myne-md/myne#832, myne-md/myne#845).
//
// Adding a story is one entry here plus a render function. Nothing else has to
// learn about it.

import type { StoryDescriptor, StoryGroup } from "./types";
import { PRIMITIVE_STORIES } from "./stories/primitives";
import { SCREEN_STORIES } from "./stories/screens";
import { SETTINGS_STORIES } from "./stories/settings";
import { COMPONENT_STORIES } from "./stories/components";
import { AI_STORIES } from "./stories/ai-panels";
import { NOTES_STORIES } from "./stories/notes";
import { WELCOME_STORIES } from "./stories/welcome";
import { DOC_STORIES } from "./stories/docs";
import { FOUNDATION_STORIES } from "./stories/foundations";
import { entryName } from "./naming";

export const STORIES: readonly StoryDescriptor[] = [
  ...WELCOME_STORIES,
  ...DOC_STORIES,
  ...FOUNDATION_STORIES,
  ...PRIMITIVE_STORIES,
  ...COMPONENT_STORIES,
  ...AI_STORIES,
  ...NOTES_STORIES,
  ...SCREEN_STORIES,
  ...SETTINGS_STORIES,
];

/** Story ids are unique and URL-safe; catch a duplicate at load, not at click. */
const seen = new Set<string>();
for (const story of STORIES) {
  if (seen.has(story.id)) {
    throw new Error(`Duplicate story id "${story.id}" in the registry.`);
  }
  seen.add(story.id);
}

/** One rail row: a surface and the states registered under it. */
export interface SurfaceGroup {
  /** The `surface` name shared by the stories in this row. */
  surface: string;
  /** The human name the rail and the inspector show. */
  name: string;
  /** The group the surface belongs to (all its stories agree on this). */
  group: StoryGroup;
  /** The states, in registry order. */
  stories: StoryDescriptor[];
}

/**
 * Group stories by surface, in first-seen order.
 *
 * Every group is included, foundations and documentation included: a specimen or
 * the Welcome page is a row in the rail like any other, and leaving them out
 * earlier meant the Foundations group rendered nothing at all.
 */
export function storiesBySurface(stories: readonly StoryDescriptor[] = STORIES): SurfaceGroup[] {
  const bySurface = new Map<string, SurfaceGroup>();
  for (const story of stories) {
    const existing = bySurface.get(story.surface);
    if (existing) {
      existing.stories.push(story);
    } else {
      bySurface.set(story.surface, {
        surface: story.surface,
        name: entryName(story.surface, story.title),
        group: story.group,
        stories: [story],
      });
    }
  }
  return [...bySurface.values()];
}

/** One node in the rail: a surface, its own stories, and its subcomponents. */
export interface TreeNode {
  /** The surface name, which is the module basename. */
  surface: string;
  /** The human name the rail shows. */
  name: string;
  /** The group this surface belongs to. */
  group: StoryGroup;
  /** The stories registered directly on this surface, in registry order. */
  stories: StoryDescriptor[];
  /** Surfaces that named this one as their parent, in registry order. */
  children: TreeNode[];
}

/** The rail as a tree, plus the parent edges that do not hold. */
export interface StoryTree {
  /** Top-level nodes per group, in the fixed group order. */
  groups: { group: StoryGroup; nodes: TreeNode[] }[];
  /**
   * Every `parent` that could not be honoured, one human sentence each.
   *
   * The rail renders what it can rather than throwing, and a separate guard
   * (`scripts/check-story-tree.mjs`) is what fails a build over it. Two readers
   * of the same fact, deliberately: the catalogue must stay openable while a
   * hand-written edge is wrong, and a build must not ship one.
   */
  problems: string[];
}

/** The group order the rail and the filter both read. */
export const GROUP_ORDER: readonly StoryGroup[] = [
  "documentation",
  "foundations",
  "primitives",
  "components",
  "screens",
  "settings",
];

/**
 * Build the rail's tree from the registry (myne-md/myne#847).
 *
 * A surface's `parent` comes from its own stories, and every story on a surface
 * must agree on it: two stories of one surface claiming different parents is a
 * contradiction the tree cannot render, so it is reported rather than resolved
 * by first-wins.
 *
 * Pure, so the nesting is asserted directly instead of through a rendered rail.
 */
export function storyTree(stories: readonly StoryDescriptor[] = STORIES): StoryTree {
  const bySurface = new Map<string, TreeNode>();
  for (const group of storiesBySurface(stories)) {
    bySurface.set(group.surface, { ...group, children: [] });
  }

  const problems: string[] = [];
  const parentOf = new Map<string, string>();

  // Resolve each surface's parent, reporting a disagreement or a missing target.
  for (const group of storiesBySurface(stories)) {
    const declared = group.stories
      .map((story) => story.parent)
      .filter((parent): parent is string => parent !== undefined);
    const unique = [...new Set(declared)];
    if (unique.length > 1) {
      problems.push(
        `surface "${group.surface}" declares more than one parent (${unique.join(", ")})`,
      );
      continue;
    }
    const parent = unique[0];
    if (parent === undefined) continue;
    if (!bySurface.has(parent)) {
      problems.push(`surface "${group.surface}" names parent "${parent}", which does not exist`);
      continue;
    }
    if (parent === group.surface) {
      problems.push(`surface "${group.surface}" names itself as its own parent`);
      continue;
    }
    const parentNode = bySurface.get(parent);
    if (parentNode !== undefined && parentNode.group !== group.group) {
      problems.push(
        `surface "${group.surface}" (${group.group}) names a parent in another group (${parentNode.group})`,
      );
      continue;
    }
    parentOf.set(group.surface, parent);
  }

  // Attach children, skipping any edge whose ancestor chain already contains the
  // child. That is a cycle, and attaching it would make the tree infinite.
  for (const [surface, parent] of parentOf) {
    const node = bySurface.get(surface);
    const parentNode = bySurface.get(parent);
    if (node === undefined || parentNode === undefined) continue;
    let walker: string | undefined = parent;
    let cyclic = false;
    const seen = new Set<string>([surface]);
    while (walker !== undefined) {
      if (seen.has(walker)) {
        cyclic = true;
        break;
      }
      seen.add(walker);
      walker = parentOf.get(walker);
    }
    if (cyclic) {
      problems.push(`parent edges form a cycle through "${surface}"`);
      continue;
    }
    parentNode.children.push(node);
  }

  const groups = GROUP_ORDER.map((group) => ({
    group,
    nodes: [...bySurface.values()].filter(
      (node) => node.group === group && !parentOf.has(node.surface),
    ),
  })).filter((entry) => entry.nodes.length > 0);

  return { groups, problems };
}

/**
 * Every story id in the tree, in the order the rail draws them.
 *
 * This is what the arrow keys walk, and it has to match the visual order or the
 * keyboard and the eye disagree. Depth-first, a node's own stories before its
 * children's.
 */
export function flattenTree(tree: StoryTree): string[] {
  const out: string[] = [];
  const walk = (node: TreeNode): void => {
    for (const story of node.stories) out.push(story.id);
    for (const child of node.children) walk(child);
  };
  for (const entry of tree.groups) {
    for (const node of entry.nodes) walk(node);
  }
  return out;
}

/** Every story, grouped by `group` in a fixed order, for the shell's list. */export function storiesByGroup(): { group: StoryGroup; stories: StoryDescriptor[] }[] {
  // Typed as `StoryGroup[]` rather than a bare array so adding a group to the
  // union is a compile error here instead of a section silently missing.
  const order: readonly StoryGroup[] = [
    "documentation",
    "foundations",
    "primitives",
    "components",
    "screens",
    "settings",
  ];
  return order
    .map((group) => ({
      group,
      stories: STORIES.filter((s) => s.group === group),
    }))
    .filter((g) => g.stories.length > 0);
}

/** The story a URL fragment names, or the first story as a fallback. */
export function storyById(id: string | undefined): StoryDescriptor | undefined {
  return STORIES.find((s) => s.id === id) ?? STORIES[0];
}
