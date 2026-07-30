// Color-group rule resolver — pure, IPC-free (graph-connection-ux-polish task
// 3): precedence, disabled-rule skip, unmatched → absent, empty list no-op,
// and forward-compat degrade-to-no-match on an unsupported filter leaf.
//
// Plus (task 8) the two pure assembly helpers the graph pane calls BEFORE the
// resolver: `collectRuleTags` (which tags the caller must resolve through the
// vault tag index) and `buildColorGroupNoteMeta` (turning the graph's node ids
// + the resident folder map + the resolved tag membership into the resolver's
// input shape).

import { describe, expect, it } from "vitest";

import {
  buildColorGroupNoteMeta,
  collectRuleTags,
  colorGroupVar,
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

describe("collectRuleTags", () => {
  it("returns the distinct folded tags of every hasTag leaf", () => {
    expect(
      collectRuleTags([
        rule("r1", "group-teal", hasTag("Work")),
        rule("r2", "group-rose", hasTag("personal")),
      ]),
    ).toEqual(["work", "personal"]);
  });

  it("descends through and/or/not combinators", () => {
    const filter: FilterNode = {
      kind: "and",
      children: [
        hasTag("work"),
        { kind: "not", child: hasTag("archived") },
        { kind: "or", children: [hasTag("urgent"), inFolder("Projects/")] },
      ],
    };
    expect(collectRuleTags([rule("r1", "group-teal", filter)])).toEqual([
      "work",
      "archived",
      "urgent",
    ]);
  });

  it("de-duplicates a tag referenced by several rules", () => {
    expect(
      collectRuleTags([
        rule("r1", "group-teal", hasTag("work")),
        rule("r2", "group-rose", hasTag("WORK")),
      ]),
    ).toEqual(["work"]);
  });

  it("skips disabled rules — a rule that cannot match owes no index query", () => {
    expect(
      collectRuleTags([
        rule("r1", "group-teal", hasTag("work"), false),
        rule("r2", "group-rose", hasTag("personal")),
      ]),
    ).toEqual(["personal"]);
  });

  it("ignores an empty tag and returns nothing for a tag-free rule set", () => {
    expect(collectRuleTags([rule("r1", "group-teal", hasTag("  "))])).toEqual([]);
    expect(collectRuleTags([rule("r1", "group-teal", inFolder("Work/"))])).toEqual(
      [],
    );
    expect(collectRuleTags([])).toEqual([]);
  });
});

describe("buildColorGroupNoteMeta", () => {
  it("carries each node's folder from the resident folder map", () => {
    const meta = buildColorGroupNoteMeta(
      ["a", "b"],
      new Map([
        ["a", "Projects/"],
        ["b", null],
      ]),
      new Map(),
    );
    expect(meta).toEqual([
      { id: "a", tags: [], folder: "Projects/" },
      { id: "b", tags: [], folder: null },
    ]);
  });

  it("a node absent from the folder map is treated as unfiled, not dropped", () => {
    const meta = buildColorGroupNoteMeta(["ghost"], new Map(), new Map());
    expect(meta).toEqual([{ id: "ghost", tags: [], folder: null }]);
  });

  it("attaches every rule tag the note is a (subtree-inclusive) member of", () => {
    const meta = buildColorGroupNoteMeta(
      ["a", "b"],
      new Map(),
      new Map([
        ["work", new Set(["a", "b"])],
        ["urgent", new Set(["b"])],
      ]),
    );
    expect(meta[0]).toEqual({ id: "a", tags: ["work"], folder: null });
    expect(meta[1]).toEqual({ id: "b", tags: ["work", "urgent"], folder: null });
  });

  it("feeds the resolver: assembled membership resolves to the rule's color", () => {
    const rules = [
      rule("r1", "group-teal", hasTag("work")),
      rule("r2", "group-rose", inFolder("Personal/")),
    ];
    // What the pane holds: the graph's node ids, the resident folder map, and
    // the tag index's answer for each tag `collectRuleTags` asked about.
    const tags = collectRuleTags(rules);
    expect(tags).toEqual(["work"]);
    const meta = buildColorGroupNoteMeta(
      ["a", "b", "c"],
      new Map([
        ["a", "Work/"],
        ["b", "Personal/"],
        ["c", null],
      ]),
      new Map([["work", new Set(["a"])]]),
    );
    const colors = resolveGraphColorGroups(rules, meta);
    expect(colors.get("a")).toBe("group-teal");
    expect(colors.get("b")).toBe("group-rose");
    expect(colors.has("c")).toBe(false);
  });
});

describe("colorGroupVar — the shared declarative degrade", () => {
  // The canvas resolves a color key off computed style and tests the result for
  // empty. Surfaces that paint the key DECLARATIVELY (an inline `background`, an
  // SVG `fill`) cannot read it back, so their degrade has to live in the
  // expression. `ColorGroup.color` is synced, peer-authorable content, so both
  // failure shapes below are reachable from another client — this is the same
  // forward-compat posture the evaluator gives an unsupported filter leaf.
  it("resolves a known palette key through its token", () => {
    expect(colorGroupVar("group-teal")).toBe("var(--group-teal, var(--fg-2))");
  });

  it("carries a neutral fallback, so an undefined token degrades rather than blanking", () => {
    // Well-formed but undefined here — a ninth palette entry from a future
    // client. It reaches `var()`; the fallback is what saves it.
    expect(colorGroupVar("group-future")).toBe("var(--group-future, var(--fg-2))");
  });

  it("rejects a key that already carries the `--` prefix", () => {
    // `var(----group-rose)` IS a syntactically valid custom-property reference,
    // so it would not error — it would just name a property nothing defines,
    // and (with no fallback) paint the initial value. Anchoring the first
    // character is what keeps it from reaching `var()` at all.
    expect(colorGroupVar("--group-rose")).toBe("var(--fg-2)");
  });

  it("rejects a key that could break out of the declaration", () => {
    expect(colorGroupVar("red); background: url(x")).toBe("var(--fg-2)");
    expect(colorGroupVar("group teal")).toBe("var(--fg-2)");
    expect(colorGroupVar("GROUP-TEAL")).toBe("var(--fg-2)");
  });

  it("treats an absent or empty key as unclassified", () => {
    expect(colorGroupVar(undefined)).toBe("var(--fg-2)");
    expect(colorGroupVar("")).toBe("var(--fg-2)");
  });
});
