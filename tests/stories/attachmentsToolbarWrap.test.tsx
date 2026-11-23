// @vitest-environment jsdom
//
// The attachments toolbar lays out at the width the pane actually is.
//
// myne-md/myne#1102. The bar itself wraps, but each control cluster is ONE flex
// item, so the row's wrap never reached the children: at a narrow pane the type /
// folder / sort pickers and the three action buttons could not move to a second
// line and painted over each other instead.
//
// jsdom computes no layout, so this asserts the mechanism rather than the
// geometry: the clusters themselves declare `flex-wrap`, which is the one thing
// whose ABSENCE produced the overlap, and the right cluster keeps `flex-shrink: 0`
// so it takes its own line rather than squeezing the left one. Read off the story
// catalogue's own render, because a hand-built harness would be a second opinion
// about what the surface looks like.

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { STORIES } from "../../stories/src/registry";
import { resolveFixture } from "../../stories/fixtures";
import { setStoryFixture } from "../../stories/src/host/internals";

const STORY_ID = "components/attachmentslibrary/default";

afterEach(() => cleanup());

describe("the attachments toolbar's clusters wrap", () => {
  it("declares flex-wrap on both clusters, and keeps the right one unshrinkable", async () => {
    const story = STORIES.find((s) => s.id === STORY_ID);
    expect(story, `${STORY_ID} left the catalogue`).toBeTruthy();
    setStoryFixture(resolveFixture(story!.fixture));

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(story!.render()));
    });

    // Every element that carries `flex-wrap: wrap` in its inline style. The bar,
    // the left cluster and the right cluster are the three that should.
    const wrapping = [...container.querySelectorAll<HTMLElement>('[style*="flex-wrap: wrap"]')];
    expect(
      wrapping.length,
      "the toolbar and BOTH clusters must wrap: a cluster without it cannot break, " +
        "so its children overlap at a narrow pane",
    ).toBeGreaterThanOrEqual(3);

    const rightCluster = wrapping.find(
      (el) =>
        (el.getAttribute("style") ?? "").includes("justify-content: flex-end") &&
        (el.getAttribute("style") ?? "").includes("flex-shrink: 0"),
    );
    expect(rightCluster, "the right cluster lost its no-shrink end-aligned shape").toBeTruthy();
    expect(rightCluster!.getAttribute("style")).toContain("flex-wrap: wrap");

    const leftCluster = wrapping.find((el) =>
      (el.getAttribute("style") ?? "").includes("flex: 1 1 320px"),
    );
    expect(leftCluster, "the left cluster lost its flexible basis").toBeTruthy();
    expect(leftCluster!.getAttribute("style")).toContain("flex-wrap: wrap");
  });
});
