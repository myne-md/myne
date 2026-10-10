// The Documentation page for a surface (myne-md/myne#847).
//
// Every component in a mature design system carries a page, and the research
// converged on the same nine items across independent sources: overview, when to
// use it and when not to, anatomy, states, behaviour, content guidance,
// accessibility, tokens, related components. Three of those the registry already
// knows, so they are GENERATED here and cannot go stale: a wrong page then means
// a wrong descriptor, which is a thing the guards already police.
//
// The rest no machine can produce. "When not to use this" and content guidance
// are judgements, so they are AUTHORED, optional, and on the descriptor rather
// than in a second file that a surface can be silently missing from.
//
// The page says which half is which. A reader has to know whether they are
// trusting a generator or a person, and a page that blurs the two makes the
// authored half look as reliable as the generated one.
//
// It lives in the INSPECTOR rather than as a rail row. A rail row would need a
// parent node to hang from, and task 1 hoists a single-state surface into one
// row, so a rail row would either double the rail or leave the single-state
// surfaces without a page (myne-md/myne#847).

import type { StoryDescriptor } from "./types";
import { entryName } from "./naming";
import { a11yLevelOf } from "./a11y-level";

/** One section of the page. */
export interface DocumentationSection {
  heading: string;
  /** One line per fact. Rendered as a list. */
  lines: string[];
  /**
   * `generated` is read from the registry and cannot disagree with it.
   * `authored` is a person's judgement, and the page labels it as such.
   */
  kind: "generated" | "authored";
}

/**
 * The page for one surface.
 *
 * `stories` is that surface's stories in registry order, which is what the
 * states section lists and what the accessibility section counts.
 */
export function documentationFor(
  surface: string,
  stories: readonly StoryDescriptor[],
): DocumentationSection[] {
  const sections: DocumentationSection[] = [];
  const first = stories[0];

  // 1. Overview. The surface name is carried as its own line so a reader who
  // arrived from a search result knows which component they are reading about.
  sections.push({
    heading: "Overview",
    kind: "generated",
    lines: [`Surface: ${surface}`, ...(first === undefined ? [] : [first.description])],
  });

  // 2. When to use it, and when not. The "when not" half is authored below, so
  // this section exists only when somebody wrote it.
  const authored = stories.find((story) => story.docs !== undefined)?.docs;

  // 3. Anatomy is not derivable from a story descriptor, so it is absent rather
  // than faked. Listed here as a comment so the omission reads as a decision.

  // 4. States.
  sections.push({
    heading: "States",
    kind: "generated",
    lines: stories.map((story) => `${story.state}: ${story.id}`),
  });

  // 7. Accessibility.
  const levels = stories.map((story) => a11yLevelOf(story));
  const counts = new Map<string, number>();
  for (const level of levels) counts.set(level, (counts.get(level) ?? 0) + 1);
  sections.push({
    heading: "Accessibility",
    kind: "generated",
    lines: [
      ...[...counts.entries()].map(([level, count]) => `${count} story(ies) declared \`${level}\``),
      "The gate is `tests/stories/a11yLevels.test.tsx`; the Accessibility tab shows the facts.",
    ],
  });

  // 9. Related surfaces, when authored.
  if (authored?.related !== undefined && authored.related.length > 0) {
    sections.push({
      heading: "Related surfaces",
      kind: "authored",
      lines: [...authored.related],
    });
  }

  // 6. Content guidance, when authored.
  if (authored?.content !== undefined) {
    sections.push({ heading: "Content guidance", kind: "authored", lines: [authored.content] });
  }

  // 2 (continued). When not to use it, when authored.
  if (authored?.whenNotToUse !== undefined) {
    sections.push({ heading: "When not to use it", kind: "authored", lines: [authored.whenNotToUse] });
  }

  return sections;
}

/** The display name a page uses for its subject. */
export function documentationTitle(surface: string, stories: readonly StoryDescriptor[]): string {
  return entryName(surface, stories[0]?.title);
}
