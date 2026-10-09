// @vitest-environment jsdom
//
// The rail's tree builder (myne-md/myne#847 task 1).
//
// The nesting is asserted here rather than through a rendered rail, because the
// builder is a pure function and a rendered assertion would test React as much
// as it tests the tree. Every case below is a way a hand-written `parent` can be
// wrong, and each one has to be REPORTED rather than silently dropped: a rail
// that quietly omits a node is the failure this whole guard family exists for.

import { describe, expect, it } from "vitest";
import { flattenTree, storyTree } from "../../stories/src/registry";
import type { StoryDescriptor, StoryGroup } from "../../stories/src/types";

/** A minimal descriptor: only the fields the builder reads. */
function story(
  surface: string,
  state: string,
  group: StoryGroup,
  parent?: string,
): StoryDescriptor {
  return {
    id: `${group}/${surface.toLowerCase()}/${state}`,
    group,
    surface,
    state,
    description: `${surface} in its ${state} state`,
    tags: ["test"],
    ...(parent === undefined ? {} : { parent }),
    render: () => null,
  };
}

describe("the rail's tree", () => {
  it("nests a surface under the parent it names", () => {
    const tree = storyTree([
      story("Shell", "default", "components"),
      story("Panel", "default", "components", "Shell"),
    ]);
    const components = tree.groups.find((entry) => entry.group === "components");
    expect(components?.nodes.map((node) => node.surface)).toEqual(["Shell"]);
    expect(components?.nodes[0].children.map((node) => node.surface)).toEqual(["Panel"]);
    expect(tree.problems).toEqual([]);
  });

  it("keeps a surface with no parent at the top of its group", () => {
    const tree = storyTree([
      story("Alpha", "default", "primitives"),
      story("Beta", "default", "primitives"),
    ]);
    const primitives = tree.groups.find((entry) => entry.group === "primitives");
    expect(primitives?.nodes.map((node) => node.surface)).toEqual(["Alpha", "Beta"]);
  });

  it("reports a parent that names nothing", () => {
    const tree = storyTree([
      story("Orphan", "default", "components", "DoesNotExist"),
    ]);
    expect(tree.problems).toHaveLength(1);
    expect(tree.problems[0]).toContain("DoesNotExist");
    // Reported AND rendered: the catalogue must stay openable while an edge is
    // wrong, and the guard is what fails the build.
    const components = tree.groups.find((entry) => entry.group === "components");
    expect(components?.nodes.map((node) => node.surface)).toEqual(["Orphan"]);
  });

  it("reports a cycle instead of building an infinite tree", () => {
    const tree = storyTree([
      story("A", "default", "components", "B"),
      story("B", "default", "components", "A"),
    ]);
    expect(tree.problems.some((problem) => problem.includes("cycle"))).toBe(true);
  });

  it("reports a surface naming itself", () => {
    const tree = storyTree([story("Solo", "default", "components", "Solo")]);
    expect(tree.problems.some((problem) => problem.includes("its own parent"))).toBe(true);
  });

  it("reports two stories of one surface claiming different parents", () => {
    const tree = storyTree([
      story("Shell", "default", "components"),
      story("Other", "default", "components"),
      story("Panel", "default", "components", "Shell"),
      story("Panel", "disabled", "components", "Other"),
    ]);
    expect(tree.problems.some((problem) => problem.includes("more than one parent"))).toBe(true);
  });

  it("reports a parent in another group", () => {
    const tree = storyTree([
      story("Shell", "default", "screens"),
      story("Panel", "default", "components", "Shell"),
    ]);
    expect(tree.problems.some((problem) => problem.includes("another group"))).toBe(true);
  });

  it("flattens in the order the rail draws: a node's stories, then its children", () => {
    const tree = storyTree([
      story("Shell", "default", "components"),
      story("Shell", "disabled", "components"),
      story("Panel", "default", "components", "Shell"),
    ]);
    expect(flattenTree(tree)).toEqual([
      "components/shell/default",
      "components/shell/disabled",
      "components/panel/default",
    ]);
  });
});
