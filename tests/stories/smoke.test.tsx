// Story smoke check (myne-md/myne#832 task 9).
//
// Every registered story must mount with no thrown error and no console error.
// This is the BLOCKING half of the story gate: a broken mount is caught at
// commit time rather than in a screenshot. It fails by naming the story.
//
// React's "not wrapped in act" notice is filtered deliberately: it is a
// harness-ordering artifact (a story's async effect resolving after the act
// boundary), not a product error, and failing on it would make the gate flaky
// in a way that trains people to ignore it. Every other console.error fails.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { STORIES } from "../../stories/src/registry";
import { resolveFixture } from "../../stories/fixtures";
import { setStoryFixture } from "../../stories/src/host/internals";

const ACT_NOTICE = "not wrapped in act";

describe("story smoke", () => {
  let errors: string[];
  let spy: { mockRestore: () => void };

  beforeEach(() => {
    errors = [];
    spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      const text = args.map(String).join(" ");
      if (!text.includes(ACT_NOTICE)) errors.push(text);
    });
  });

  afterEach(() => {
    spy.mockRestore();
    cleanup();
  });

  it("the registry is non-empty (a smoke that renders nothing reads as a pass)", () => {
    expect(STORIES.length).toBeGreaterThan(0);
  });

  for (const story of STORIES) {
    it(`${story.id} mounts cleanly`, async () => {
      setStoryFixture(resolveFixture(story.fixture));
      await act(async () => {
        render(story.render());
      });
      expect(errors, `console.error during ${story.id}`).toEqual([]);
    });
  }
});
