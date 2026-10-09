// @vitest-environment jsdom
//
// A story must render something a reader can see (myne-md/myne#845).
//
// This spec exists because three surfaces shipped stories that mounted cleanly,
// passed the smoke check and rendered NOTHING: `Toast` is a headless bridge that
// only pushes into the store, `Toaster` subscribes to a store no story filled,
// and `PairingDialog` rendered its challenge box empty because no fixture
// answered the command behind it. A blank stage reads as a broken component, and
// neither the smoke check (which asserts no console error) nor the a11y gate
// (which measures the DOM that IS there) can tell "nothing rendered" from "this
// surface is genuinely minimal".
//
// The assertions are deliberately about TEXT a user would see, not about a DOM
// shape, so they stay true if the markup is refactored.

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { STORIES } from "../../stories/src/registry";
import { resolveFixture } from "../../stories/fixtures";
import { setStoryFixture } from "../../stories/src/host/internals";

/** Mount one story by id and hand back the container. */
async function mount(id: string): Promise<HTMLElement> {
  const story = STORIES.find((candidate) => candidate.id === id);
  if (story === undefined) throw new Error(`no story ${id}`);
  setStoryFixture(resolveFixture(story.fixture));
  let container: HTMLElement | null = null;
  await act(async () => {
    container = render(story.render()).container;
  });
  return container as unknown as HTMLElement;
}

afterEach(() => {
  cleanup();
});

describe("a story shows what it claims to show", () => {
  it("the Toast story renders the message, not just the headless bridge", async () => {
    const el = await mount("components/toast/default");
    // The bridge draws nothing; the paired Toaster is what puts the text on
    // screen. Asserting the text is the whole point.
    expect(el.textContent).toContain("Saved");
  });

  it("the Toaster story renders the stack, not an empty store", async () => {
    const el = await mount("components/toaster/default");
    for (const message of ["Saved", "Attachment uploaded", "Sync failed"]) {
      expect(el.textContent, `${message} must be on screen`).toContain(message);
    }
  });

  it("the PairingDialog story renders a challenge code", async () => {
    const el = await mount("components/pairingdialog/default");
    const code = el.querySelector('[data-testid="pairing.challenge"]');
    expect(code, "the challenge element must exist").not.toBeNull();
    // An EMPTY challenge box is the bug this asserts against: the box rendered,
    // and its height collapsed because it held nothing.
    expect((code?.textContent ?? "").trim().length).toBeGreaterThan(0);
  });

  it("every unreachable state carries the prose the note renders", async () => {
    // The note itself is drawn by the shell (`StoryStage`), not by `render()`,
    // so it cannot be asserted from a story mount. What CAN be asserted is that
    // every story declaring `unreachable` supplies both halves of the sentence:
    // a note missing `why` would render a heading and nothing else, which is the
    // same blank-stage failure in a different place.
    const broken = STORIES.filter(
      (story) =>
        story.unreachable !== undefined &&
        (story.unreachable.what.trim().length === 0 || story.unreachable.why.trim().length === 0),
    ).map((story) => story.id);
    expect(broken, "an `unreachable` note needs both what and why").toEqual([]);
    expect(
      STORIES.filter((story) => story.unreachable !== undefined).length,
      "the check must not be vacuous",
    ).toBeGreaterThan(0);
  });
});
