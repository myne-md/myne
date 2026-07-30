// Color-group rule resolver — pure, IPC-free (graph-connection-ux-polish task
// 3): precedence, disabled-rule skip, unmatched → absent, empty list no-op,
// and forward-compat degrade-to-no-match on an unsupported filter leaf.

import { describe, expect, it } from "vitest";

import {
  resolveGraphColorGroups,
  type ColorGroupNoteMeta,
} from "../../src/notes/graphColorGroups";
import type { ColorGroup, FilterNode } from "../../src/lib/prefs";

function rule(
  id: string,
  color: string,
  filter: FilterNode,
  enabled = true,
): ColorGroup {
  return { id, name: id, color, enabled, filter };
}

function note(
  id: string,
  tags: ReadonlyArray<string> = [],
  folder: string | null = null,
): ColorGroupNoteMeta {
  return { id, tags, folder };
}

const hasTag = (tag: string): FilterNode => ({ kind: "hasTag", tag });
const inFolder = (path: string): FilterNode => ({ kind: "inFolder", path });

describe("resolveGraphColorGroups", () => {
  it("returns an empty map for an empty rule list (no-op)", () => {
    const colors = resolveGraphColorGroups([], [note("a", ["work"])]);
    expect(colors.size).toBe(0);
  });

  it("matches a note carrying the rule's tag", () => {
    const colors = resolveGraphColorGroups(
      [rule("r1", "moss", hasTag("work"))],
      [note("a", ["work"]), note("b", ["personal"])],
    );
    expect(colors.get("a")).toBe("moss");
    expect(colors.has("b")).toBe(false);
  });

  it("matches a descendant tag (subtree-inclusive, like byTag)", () => {
    const colors = resolveGraphColorGroups(
      [rule("r1", "moss", hasTag("work"))],
      [note("a", ["work/urgent"])],
    );
    expect(colors.get("a")).toBe("moss");
  });

  it("matches a note in the rule's folder or a descendant folder", () => {
    const colors = resolveGraphColorGroups(
      [rule("r1", "slate", inFolder("Projects/"))],
      [
        note("a", [], "Projects/"),
        note("b", [], "Projects/Sub/"),
        note("c", [], "Other/"),
        note("d", [], null),
      ],
    );
    expect(colors.get("a")).toBe("slate");
    expect(colors.get("b")).toBe("slate");
    expect(colors.has("c")).toBe(false);
    expect(colors.has("d")).toBe(false);
  });

  it("first match wins when a note matches more than one rule", () => {
    const colors = resolveGraphColorGroups(
      [
        rule("r1", "moss", hasTag("work")),
        rule("r2", "slate", hasTag("urgent")),
      ],
      [note("a", ["work", "urgent"])],
    );
    expect(colors.get("a")).toBe("moss");
  });

  it("precedence follows list order, not rule id or insertion of matches", () => {
    const colors = resolveGraphColorGroups(
      [
        rule("r2", "slate", hasTag("urgent")),
        rule("r1", "moss", hasTag("work")),
      ],
      [note("a", ["work", "urgent"])],
    );
    expect(colors.get("a")).toBe("slate");
  });

  it("skips a disabled rule but a lower-precedence enabled rule can still match", () => {
    const colors = resolveGraphColorGroups(
      [
        rule("r1", "moss", hasTag("work"), false),
        rule("r2", "slate", hasTag("work")),
      ],
      [note("a", ["work"])],
    );
    expect(colors.get("a")).toBe("slate");
  });

  it("a note matching no rule is absent from the map (neutral fallback)", () => {
    const colors = resolveGraphColorGroups(
      [rule("r1", "moss", hasTag("work"))],
      [note("a", ["personal"])],
    );
    expect(colors.has("a")).toBe(false);
  });

  it("evaluates and/or/not combinators over supported leaves", () => {
    const filter: FilterNode = {
      kind: "and",
      children: [hasTag("work"), { kind: "not", child: hasTag("archived") }],
    };
    const colors = resolveGraphColorGroups(
      [rule("r1", "moss", filter)],
      [note("a", ["work"]), note("b", ["work", "archived"])],
    );
    expect(colors.get("a")).toBe("moss");
    expect(colors.has("b")).toBe(false);
  });

  it("an unsupported leaf degrades to no-match instead of throwing", () => {
    const searchLeaf: FilterNode = { kind: "search", query: "anything" };
    expect(() =>
      resolveGraphColorGroups(
        [rule("r1", "moss", searchLeaf)],
        [note("a", ["work"])],
      ),
    ).not.toThrow();
    const colors = resolveGraphColorGroups(
      [rule("r1", "moss", searchLeaf)],
      [note("a", ["work"])],
    );
    expect(colors.has("a")).toBe(false);
  });

  it("an unsupported leaf inside a combinator degrades only that leaf", () => {
    const filter: FilterNode = {
      kind: "or",
      children: [hasTag("work"), { kind: "all" }],
    };
    const colors = resolveGraphColorGroups(
      [rule("r1", "moss", filter)],
      [note("a", ["work"]), note("b", ["personal"])],
    );
    expect(colors.get("a")).toBe("moss");
    // "all" degrades to no-match rather than matching everything, so "b"
    // (no "work" tag) stays unmatched even though it would match a real "all".
    expect(colors.has("b")).toBe(false);
  });
});
