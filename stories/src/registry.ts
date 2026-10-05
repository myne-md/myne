// The story registry: the single list the shell, the coverage guard, the smoke
// check and the drift baseline all read (myne-md/myne#832).
//
// Adding a story is one entry here plus a render function. Nothing else has to
// learn about it.

import type { StoryDescriptor, StoryGroup } from "./types";
import { PRIMITIVE_STORIES } from "./stories/primitives";
import { SCREEN_STORIES } from "./stories/screens";

export const STORIES: readonly StoryDescriptor[] = [
  ...PRIMITIVE_STORIES,
  ...SCREEN_STORIES,
];

/** Story ids are unique and URL-safe; catch a duplicate at load, not at click. */
const seen = new Set<string>();
for (const story of STORIES) {
  if (seen.has(story.id)) {
    throw new Error(`Duplicate story id "${story.id}" in the registry.`);
  }
  seen.add(story.id);
}

/** Every story, grouped by `group` in a fixed order, for the shell's list. */
export function storiesByGroup(): { group: string; stories: StoryDescriptor[] }[] {
  // Typed as `StoryGroup[]` rather than a bare array so adding a group to the
  // union is a compile error here instead of a section silently missing.
  const order: readonly StoryGroup[] = ["primitives", "components", "screens", "settings"];
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
