// Types for the design-system story catalogue (myne-md/myne#832).
//
// A STORY is one (surface x state). A FIXTURE is the canned `invoke` data plus
// the boot state that makes a state reachable. Keeping these two apart is what
// lets several states share a fixture ("locked", "empty vault") without copying
// handler tables.

import type { ReactNode } from "react";

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

/** The catalogue's top-level grouping. */
export type StoryGroup = "primitives" | "components" | "screens" | "settings";

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
  /** Fixture name (a key of `FIXTURES`) or an inline fixture. */
  fixture?: string | Fixture;
  /** Viewport width in px. Informational; the frame renders it as a device box. */
  viewport?: number;
  /**
   * Extra normalisation applied on top of the default before hashing, for a
   * story that legitimately renders a volatile value the default cannot know
   * about. Rare: prefer making the render deterministic.
   */
  normalize?: (html: string) => string;
  /** Renders the surface in this state. Called with the fixture installed. */
  render: () => ReactNode;
}
