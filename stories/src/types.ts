// Types for the design-system workbench (myne-md/myne#832, myne-md/myne#845).
//
// A STORY is one (surface x state). A FIXTURE is the canned `invoke` data plus
// the boot state that makes a state reachable. Keeping these two apart is what
// lets several states share a fixture ("locked", "empty vault") without copying
// handler tables.
//
// `description` and `tags` are load-bearing rather than decorative: the navbar
// search matches against them, so a story that has neither is a story nobody
// can find by intent. `scripts/check-story-catalogue.mjs` fails when one is
// missing, which is the same ratchet shape as the coverage guard.

import type { ReactNode } from "react";

/**
 * The accessibility level a story declares (myne-md/myne#845).
 *
 * The vocabulary is deliberately the one a mature a11y panel uses, because the
 * question it answers is the same: is this story a GATE or a note?
 *
 * - `error`. Axe must find nothing here, and any violation fails the build.
 *   This is the only level that blocks anything.
 * - `todo`. A known finding, recorded rather than hidden. It does not fail
 *   yet, so the debt is visible and can shrink.
 * - `off`. Axe must not run here at all, and `a11yReason` says why. Reserved
 *   for a story whose render genuinely defeats axe (a canvas, an OS surface),
 *   never for a story that merely fails.
 *
 * Declaring nothing means `error`: a new story is gated from birth, and the
 * stories that are not clean say so one line at a time.
 */
export type A11yLevel = "off" | "todo" | "error";

/** A canned answer for one Tauri command, given the invoke arguments. */
export type InvokeHandler = (args: Record<string, unknown>) => unknown;

/**
 * A named set of canned `invoke` responses.
 *
 * `handlers` is keyed by the exact command string the seam sends
 * (`plugin:prefs|prefs_read`, `vault_slot_kind`, …). A command with no handler
 * resolves to a benign empty value rather than throwing, so a story mounts even
 * when it reads a command the fixture did not anticipate. Fixtures are synthetic
 * and MUST NOT contain a recovery phrase or a real account number;
 * `tests/stories/fixtures.test.ts` rejects both.
 */
export interface Fixture {
  /** One-line human summary of the situation this fixture represents. */
  description: string;
  handlers?: Record<string, InvokeHandler>;
}

/**
 * The catalogue's top-level grouping.
 *
 * `foundations` is not a surface group: it holds the token, icon, type, spacing,
 * radius, shadow and motion specimens, which are generated from their sources
 * rather than mounted as components.
 */
export type StoryGroup =
  | "documentation"
  | "foundations"
  | "primitives"
  | "components"
  | "screens"
  | "settings";

/**
 * A state a story deliberately cannot reach from the catalogue, with the reason.
 *
 * The alternative is a silently blank stage, which reads as a broken component
 * (myne-md/myne#845). A story carrying this renders the reason instead.
 */
export interface UnreachableState {
  /** What the state is, in a human sentence. */
  what: string;
  /** The mechanism that blocks the catalogue, e.g. an OS event. */
  why: string;
}

/** One addressable state of one surface. */
export interface StoryDescriptor {
  /**
   * Stable id and URL fragment: `<group>/<surface>/<state>`, all lowercase and
   * hyphenated. The shell routes on it.
   */
  id: string;
  group: StoryGroup;
  /**
   * The surface this story covers, named as in the coverage roster: a module
   * basename under `src/components/` or `src/screens/` (e.g. `Button`, `Unlock`).
   */
  surface: string;
  /** The state being shown (`default`, `disabled`, `error`, `empty`, …). */
  state: string;
  /**
   * One sentence naming what this story shows. Matched by search, shown in the
   * inspector and used as the human summary of the story.
   */
  description: string;
  /** Lowercase keywords for search. At least one is required. */
  tags: readonly string[];
  /**
   * Explicit display name. Omitted for almost every story: the rail derives the
   * name from `surface` by changing casing only (`ModalShell` -> "Modal Shell"),
   * and an override is for the rare case where that reads badly.
   */
  title?: string;
  /**
   * Render without the stage's default padding. For surfaces that genuinely are
   * full width (screens, the editor), not for a card or a banner.
   */
  fullBleed?: boolean;
  /** Fixture name (a key of `FIXTURES`) or an inline fixture. */
  fixture?: string | Fixture;
  /** Viewport width in px. Informational; the frame renders it as a device box. */
  viewport?: number;
  /** Set when the state cannot be reached here; the stage renders the reason. */
  unreachable?: UnreachableState;
  /**
   * The accessibility level this story declares (myne-md/myne#845).
   *
   * - `error`: axe must find nothing here, and a violation FAILS the build.
   * - `todo`: a known finding, recorded rather than hidden; does not fail yet.
   * - `off`: axe must not run here, and `a11yReason` says why.
   *
   * Omitted means `error`, so a new story is GATED from birth rather than
   * silently inheriting debt. The vocabulary is the one a mature a11y panel
   * uses, and it makes "is this story gated, or is it not" a stated fact rather
   * than something you infer from whether anybody wrote a test.
   */
  a11y?: A11yLevel;
  /**
   * Required when `a11y` is `off`: the reason axe must not run here, long enough
   * to describe a mechanism (`tests/stories/a11yLevels.test.tsx` enforces it).
   */
  a11yReason?: string;
  /**
   * Extra normalisation applied on top of the default before hashing, for a
   * story that legitimately renders a volatile value the default cannot know
   * about. Rare: prefer making the render deterministic.
   */
  normalize?: (html: string) => string;
  /** Renders the surface in this state. Called with the fixture installed. */
  render: () => ReactNode;
}
