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

/** Every story, grouped by `group` in a fixed order, for the shell's list. */
export function storiesByGroup(): { group: StoryGroup; stories: StoryDescriptor[] }[] {
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
