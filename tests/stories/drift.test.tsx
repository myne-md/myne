// Story DOM-hash drift check (myne-md/myne#832 task 10).
//
// Myne renders inline styles plus CSS variables, so the DOM already carries the
// styling: a normalised DOM hash tracks structural AND visual drift without a
// pixel baseline and its font/AA flake.
//
// Drift WARNS, it never blocks. A component or token change that alters a
// surface is exactly what this is for, and some legitimate changes will move it;
// a hard gate here would be red often enough that people would stop reading it.
// `pnpm stories:record` re-records every baseline deliberately.
//
// What DOES fail is a story with no baseline at all: that is not drift, it is a
// story nobody measured, and a check that silently ignores it is vacuous.
//
// The whole measurement is one test that loops, rather than one test per story:
// the comparison needs every story's hash in hand before it decides, and
// building that from cross-test state would depend on the runner's ordering.
// A story that throws is named in the failure.

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { STORIES } from "../../stories/src/registry";
import { resolveFixture } from "../../stories/fixtures";
import { setStoryFixture } from "../../stories/src/host/internals";
import { normalise } from "../../stories/src/host/normalise";

const BASELINE_PATH = resolve(process.cwd(), "stories/dom-baselines.json");
const RECORD = process.env.STORIES_RECORD === "1";

/** The shared 16-hex digest of an already-normalised string. */
export function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function loadBaseline(): Record<string, string> {
  if (!existsSync(BASELINE_PATH)) return {};
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Record<string, string>;
}

describe("story drift", () => {
  afterEach(() => cleanup());

  it("is a real check (an empty registry reads as a pass)", () => {
    expect(STORIES.length).toBeGreaterThan(0);
  });

  it(RECORD ? "records every story hash" : "warns on drift, fails on an unmeasured story", async () => {
    const measured: Record<string, string> = {};
    for (const story of STORIES) {
      setStoryFixture(resolveFixture(story.fixture));
      try {
        let container!: HTMLElement;
        await act(async () => {
          ({ container } = render(story.render()));
        });
        // The per-story hook is applied on top of the default, so a story that
        // knows about its own volatile value can say so.
        const normalised = normalise(container.innerHTML);
        measured[story.id] = digest(
          story.normalize ? story.normalize(normalised) : normalised,
        );
      } catch (err) {
        throw new Error(
          `story "${story.id}" threw while being measured: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        cleanup();
      }
    }

    if (RECORD) {
      // Written as a REPLACEMENT set, not merged: a baseline entry for a story
      // that was removed or renamed must not survive to describe nothing.
      writeFileSync(BASELINE_PATH, JSON.stringify(measured, null, 2) + "\n");
      return;
    }

    const baseline = loadBaseline();
    const drifted = Object.entries(measured)
      .filter(([id, value]) => baseline[id] && baseline[id] !== value)
      .map(([id]) => id);
    const unrecorded = Object.keys(measured).filter((id) => !baseline[id]);

    if (drifted.length > 0) {
      // A warning, deliberately. Prints in the run log; does not fail.
      console.warn(
        `story-drift: ${drifted.length} story(ies) changed: ${drifted.join(", ")}.` +
          ` If the change is intended, run \`pnpm stories:record\`.`,
      );
    }

    // A story with no baseline is not drift, it is an unmeasured story: this
    // half is a hard gate so the drift check cannot quietly cover nothing.
    expect(
      unrecorded,
      `these stories have no baseline: run \`pnpm stories:record\``,
    ).toEqual([]);
  });
});
