// @vitest-environment node
//
// The parent-edge guard (myne-md/myne#847 task 2).
//
// A guard is proven by injecting the defect it claims to catch, never by running
// it over a clean tree: a guard that has stopped checking is green by
// definition. Each case below injects one of the three ways a hand-written
// `parent` goes wrong and asserts the guard names it.
//
// The first case is also the one the guard's own parser got wrong on its first
// run, which is why it is asserted here rather than trusted.

import { describe, expect, it } from "vitest";
import { declaredEdges, findings, importConnected } from "../../scripts/check-story-tree.mjs";

/**
 * A surface-name to module-path map plus a reader, so no case touches the real
 * tree. Keyed by SURFACE, because that is what the guard looks up: an earlier
 * version of this helper keyed it by path and every case failed for a reason
 * that had nothing to do with what it was testing.
 */
function world(sources: Record<string, { path: string; source: string }>) {
  const surfacePaths = new Map(
    Object.entries(sources).map(([surface, entry]) => [surface, entry.path]),
  );
  const byPath = new Map(Object.entries(sources).map(([, entry]) => [entry.path, entry.source]));
  const read = (path: string): string => byPath.get(path) ?? "";
  return { surfacePaths, read };
}

describe("the parent-edge guard", () => {
  it("reads a `parent` written ABOVE its own `surface:` line", () => {
    // The first version scanned forward from `surface:`, so this field was
    // attributed to the NEXT descriptor and reported as a fabricated edge
    // against the wrong component.
    const source = `export const S = [
  {
    id: "a/default",
    parent: "Parent",
    group: "components",
    surface: "Child",
    state: "default",
    description: "d",
    tags: ["t"],
    render: () => null,
  },
  {
    id: "b/default",
    group: "components",
    surface: "Other",
    state: "default",
    description: "d",
    tags: ["t"],
    render: () => null,
  },
];`;
    const { edges, surfaces } = declaredEdges([["stories/src/stories/x.tsx", source]]);
    expect(edges).toEqual([
      { file: "stories/src/stories/x.tsx", surface: "Child", parent: "Parent" },
    ]);
    expect(surfaces).toEqual(new Set(["Child", "Other"]));
  });

  it("names a parent that no story declares", () => {
    const { surfacePaths, read } = world({});
    const problems = findings({
      edges: [{ file: "f", surface: "Child", parent: "Ghost" }],
      surfaces: new Set(["Child"]),
      surfacePaths,
      read,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("Ghost");
  });

  it("names a cycle", () => {
    const { surfacePaths, read } = world({
      A: { path: "src/components/A.tsx", source: 'import { B } from "./B";' },
      B: { path: "src/components/B.tsx", source: 'import { A } from "./A";' },
    });
    const problems = findings({
      edges: [
        { file: "f", surface: "A", parent: "B" },
        { file: "f", surface: "B", parent: "A" },
      ],
      surfaces: new Set(["A", "B"]),
      surfacePaths,
      read,
    });
    expect(problems.some((problem) => problem.includes("cycle"))).toBe(true);
  });

  it("names a fabricated edge: two real surfaces with no import between them", () => {
    const { surfacePaths, read } = world({
      Child: { path: "src/components/Child.tsx", source: 'import { Something } from "./Elsewhere";' },
      Parent: { path: "src/components/Parent.tsx", source: 'import { Other } from "./AlsoElsewhere";' },
    });
    const problems = findings({
      edges: [{ file: "f", surface: "Child", parent: "Parent" }],
      surfaces: new Set(["Child", "Parent"]),
      surfacePaths,
      read,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("no import edge");
  });

  it("accepts an edge where the PARENT imports the child", () => {
    // The direction has to be free: `SettingsModal` imports its panels, while
    // `ModalShell` is imported BY its children.
    const { surfacePaths, read } = world({
      Child: { path: "src/components/Child.tsx", source: "export const Child = 1;" },
      Parent: { path: "src/components/Parent.tsx", source: 'import { Child } from "./Child";' },
    });
    const problems = findings({
      edges: [{ file: "f", surface: "Child", parent: "Parent" }],
      surfaces: new Set(["Child", "Parent"]),
      surfacePaths,
      read,
    });
    expect(problems).toEqual([]);
  });

  it("accepts an edge where the CHILD imports the parent", () => {
    const { surfacePaths, read } = world({
      Child: { path: "src/components/Child.tsx", source: 'import { Parent } from "./Parent";' },
      Parent: { path: "src/components/Parent.tsx", source: "export const Parent = 1;" },
    });
    const problems = findings({
      edges: [{ file: "f", surface: "Child", parent: "Parent" }],
      surfaces: new Set(["Child", "Parent"]),
      surfacePaths,
      read,
    });
    expect(problems).toEqual([]);
  });

  it("does not count a specifier that merely contains the other basename", () => {
    // A resolved-path comparison, not a substring one: this is the difference
    // between the guard checking composition and the guard checking spelling.
    const { surfacePaths, read } = world({
      Child: { path: "src/components/Child.tsx", source: 'import { X } from "./ChildishHelpers";' },
      Parent: { path: "src/components/Parent.tsx", source: "export const Parent = 1;" },
    });
    expect(
      importConnected("src/components/Child.tsx", "src/components/Parent.tsx", read),
    ).toBe(false);
  });
});
