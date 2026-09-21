// The graph's shared OVERLAY (myne-md/myne#727).
//
// This is the piece that makes "identical behaviour on both clients" a fact
// rather than a promise. Both the desktop pane and the mobile graph tab call
// `buildGraphOverlay`, so the tag nodes, the colour rules and the derived
// default grouping cannot drift: there is one implementation and two callers.
//
// The client-specific inputs are the interesting part and they are what the
// cases below pin: desktop takes its tags from the Rust tag tree (which reports
// `subtreeCount` directly) while mobile derives them from its own `TagIndex`,
// and `tagIndexToGraphTags` is what makes those two agree about which tags
// qualify for the default grouping.

import { describe, expect, it } from "vitest";
import {
  buildGraphOverlay,
  tagIndexToGraphTags,
} from "../../src/notes/graphOverlay";
import { GROUP_COLOR_KEYS } from "../../src/notes/graphColorGroups";
import type { ColorGroup } from "../../src/lib/prefs";
import type { GraphModel } from "../../src/notes/graphModel";

/** The overlay's model is nullable only for a caller's pre-first-build
 *  sentinel; every case here has one. This narrows it in one place rather than
 *  scattering non-null assertions through the assertions. */
function modelOf(overlay: { model: GraphModel | null }): GraphModel {
  if (overlay.model === null) throw new Error("overlay.model is null");
  return overlay.model;
}

const MODEL: GraphModel = {
  nodes: [
    { id: "a", title: "Alpha" },
    { id: "b", title: "Bravo" },
  ],
  edges: [{ source: "a", target: "b", weight: 1 }],
};

const TAGS = [
  { key: "work", display: "Work", subtreeCount: 2 },
  { key: "work/urgent", display: "urgent", subtreeCount: 1 },
  { key: "lonely", display: "lonely", subtreeCount: 1 },
];

const MEMBERS = new Map<string, ReadonlySet<string>>([
  ["work", new Set(["a", "b"])],
  ["work/urgent", new Set(["a"])],
  ["lonely", new Set(["b"])],
]);

const NO_FOLDERS = new Map<string, string | null>();

const bareTagRule = (tag: string, color = "group-teal"): ColorGroup => ({
  id: "r1",
  name: tag,
  color,
  enabled: true,
  filter: { kind: "hasTag", tag },
});

const build = (input: Partial<Parameters<typeof buildGraphOverlay>[0]> = {}) =>
  buildGraphOverlay({
    model: MODEL,
    colorGroups: [],
    tags: TAGS,
    members: MEMBERS,
    folderById: NO_FOLDERS,
    wholeVault: true,
    ...input,
  });

describe("buildGraphOverlay", () => {
  it("derives a default group per qualifying tag when the vault has none", () => {
    const out = build();
    // `work` (2 notes) and `work/urgent` (1) and `lonely` (1): only the first
    // covers two notes, so it is the only derived group.
    expect(out.derivedGroupCount).toBe(1);
    expect(out.colors.get("a")).toBe(GROUP_COLOR_KEYS[0]);
    expect(out.colors.get("b")).toBe(GROUP_COLOR_KEYS[0]);
  });

  it("adds a tag NODE for a bare hasTag rule, painted from the same map", () => {
    const out = build({ colorGroups: [bareTagRule("work")] });
    expect(modelOf(out).nodes).toHaveLength(MODEL.nodes.length + 1);
    expect(modelOf(out).nodes.some((n) => n.kind === "tag")).toBe(true);
    // The hub and its notes share one colour map, so they cannot disagree.
    expect(out.colors.get("tag:work")).toBe("group-teal");
    expect(out.colors.get("a")).toBe("group-teal");
    // …and it is connected to exactly its members.
    expect(
      modelOf(out)
        .edges.filter((e) => e.source === "tag:work")
        .map((e) => e.target),
    ).toEqual(["a", "b"]);
  });

  it("keeps the notes-only paths notes-only", () => {
    // A hub has no place in a neighbourhood BFS, a tag's own subgraph or an
    // orphan list, so those views ask for no hubs and still get the colours.
    const out = build({ colorGroups: [bareTagRule("work")], wholeVault: false });
    expect(out.model).toBe(MODEL);
    expect(out.colors.get("a")).toBe("group-teal");
  });

  it("says the vault authored rules, so nothing is reported as derived", () => {
    const out = build({ colorGroups: [bareTagRule("work")] });
    expect(out.derivedGroupCount).toBe(0);
  });

  it("gives an authored rule precedence over the derived default", () => {
    const out = build({ colorGroups: [bareTagRule("lonely", "group-rose")] });
    // The authored rule is the ONLY one evaluated, so `a` is unmatched and
    // keeps the neutral colour, and `b` takes the authored one.
    expect(out.colors.get("b")).toBe("group-rose");
    expect(out.colors.has("a")).toBe(false);
  });

  it("returns one stable empty map, so a caller can compare by identity", () => {
    const out = build({ model: { nodes: [], edges: [] } });
    expect(out.colors.size).toBe(0);
    expect(build({ model: { nodes: [], edges: [] } }).colors).toBe(out.colors);
  });

  it("caps the derived groups at the palette's length", () => {
    // `GROUP_COLOR_KEYS_LENGTH` is a private constant in the module rather than
    // an import of the palette, so this asserts the two agree.
    const many = Array.from({ length: 20 }, (_, i) => ({
      key: `t${i}`,
      display: `t${i}`,
      subtreeCount: 5,
    }));
    const out = build({ tags: many });
    expect(out.derivedGroupCount).toBe(GROUP_COLOR_KEYS.length);
  });
});

describe("tagIndexToGraphTags", () => {
  const index = () =>
    tagIndexToGraphTags(
      new Map([
        ["work", ["a", "b"]],
        ["work/urgent", ["a"]],
        ["lonely", ["b"]],
      ]),
      new Map([
        ["work", "Work"],
        ["work/urgent", "urgent"],
        ["lonely", "lonely"],
      ]),
    );

  it("reports the SUBTREE-inclusive count the Rust tag tree reports", () => {
    // The whole point: desktop gets this number from the tag tree, mobile has to
    // derive it, and a parent whose own notes are few but whose descendants are
    // many must not be dropped from the default grouping on one client only.
    const { tags } = index();
    const work = tags.find((t) => t.key === "work");
    expect(work?.subtreeCount).toBe(2);
    expect(work?.display).toBe("Work");
    expect(tags.find((t) => t.key === "lonely")?.subtreeCount).toBe(1);
  });

  it("counts a note once however many of the subtree's tags it carries", () => {
    const { tags } = tagIndexToGraphTags(
      new Map([
        ["work", ["a"]],
        ["work/urgent", ["a"]],
      ]),
      new Map(),
    );
    expect(tags.find((t) => t.key === "work")?.subtreeCount).toBe(1);
  });

  it("falls back to the folded key when no display name is known", () => {
    const { tags } = tagIndexToGraphTags(new Map([["work", ["a"]]]), new Map());
    expect(tags[0]?.display).toBe("work");
  });

  it("hands the memberships through unchanged, so the overlay can query them", () => {
    const { members } = index();
    expect([...(members.get("work") ?? [])].sort()).toEqual(["a", "b"]);
  });

  it("agrees with what the desktop tree would supply for the same vault", () => {
    // The two inputs are compared through the ONE consumer that reads them.
    const { tags, members } = index();
    const fromMobile = buildGraphOverlay({
      model: MODEL,
      colorGroups: [],
      tags,
      members,
      folderById: NO_FOLDERS,
      wholeVault: true,
    });
    const fromTree = buildGraphOverlay({
      model: MODEL,
      colorGroups: [],
      tags: TAGS,
      members: MEMBERS,
      folderById: NO_FOLDERS,
      wholeVault: true,
    });
    expect(fromMobile.derivedGroupCount).toBe(fromTree.derivedGroupCount);
    expect([...fromMobile.colors.entries()].sort()).toEqual(
      [...fromTree.colors.entries()].sort(),
    );
    expect(modelOf(fromMobile).nodes.map((n) => n.id).sort()).toEqual(
      modelOf(fromTree).nodes.map((n) => n.id).sort(),
    );
  });
});
