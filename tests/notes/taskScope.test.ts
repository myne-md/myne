// Scope selector semantics (MYND-616 task 3).
//
// Three claims worth testing rather than reading: folder scope reaches into
// subfolders, several tags are OR'd (not AND'd — the choice that decides whether
// the selector feels precise or broken), and the two combine with AND. The
// fourth, "no new query leaf", is testable because `scopeToFilter` emits the
// frozen node type: a scope that needed a new leaf would not compile.

import { describe, expect, it } from "vitest";
import {
  EMPTY_SCOPE,
  filterTasksByScope,
  folderInScope,
  isScopeEmpty,
  noteInScope,
  scopeToFilter,
  tagsInScope,
  toggleScopeTag,
  type TaskScope,
} from "../../src/notes/taskScope";
import type { VaultTask } from "../../src/notes/taskIndex";

function task(noteId: string, noteFolder: string | null): VaultTask {
  return {
    noteId,
    noteTitle: noteId,
    noteFolder,
    lineIndex: 0,
    rawLine: "- [ ] x",
    completed: false,
    oversized: false,
  } as VaultTask;
}

const scope = (over: Partial<TaskScope>): TaskScope => ({ ...EMPTY_SCOPE, ...over });

describe("folder scope is subtree-inclusive", () => {
  it("includes the folder itself", () => {
    expect(folderInScope("Projects", "Projects")).toBe(true);
  });

  it("includes subfolders, at any depth", () => {
    expect(folderInScope("Projects", "Projects/Myne")).toBe(true);
    expect(folderInScope("Projects", "Projects/Myne/Specs")).toBe(true);
  });

  it("excludes a sibling that merely shares a prefix", () => {
    // The failure a raw string prefix would produce. Keys carry a trailing
    // separator, so the test is segment-aligned.
    expect(folderInScope("Projects", "Projects-Archive")).toBe(false);
  });

  it("excludes an unrelated folder and the root", () => {
    expect(folderInScope("Projects", "Personal")).toBe(false);
    expect(folderInScope("Projects", null)).toBe(false);
  });

  it("is permissive when no folder is selected", () => {
    expect(folderInScope(null, "Anything")).toBe(true);
    expect(folderInScope(null, null)).toBe(true);
  });

  it("folds the same way the write path does", () => {
    // Query-fold == write-fold (§3.7.8): a case difference must not split a
    // folder in two.
    expect(folderInScope("projects", "Projects/Myne")).toBe(true);
  });
});

describe("tags are OR'd, not AND'd", () => {
  it("matches a note carrying ANY selected tag", () => {
    // The decisive one. AND'ing would return empty for most real selections —
    // most notes carry one of a user's top-level tags, not several — and a
    // selector that usually yields nothing reads as broken, not precise.
    expect(tagsInScope(["work", "home"], ["work"])).toBe(true);
    expect(tagsInScope(["work", "home"], ["home"])).toBe(true);
  });

  it("does not require a note to carry every selected tag", () => {
    expect(tagsInScope(["work", "home"], ["work"])).toBe(true);
  });

  it("excludes a note carrying none of them", () => {
    expect(tagsInScope(["work", "home"], ["errands"])).toBe(false);
    expect(tagsInScope(["work"], [])).toBe(false);
  });

  it("is subtree-inclusive per tag, matching the hasTag leaf", () => {
    expect(tagsInScope(["area"], ["area/sub"])).toBe(true);
    expect(tagsInScope(["area"], ["area/sub/deeper"])).toBe(true);
  });

  it("does not match a tag that merely shares a prefix", () => {
    expect(tagsInScope(["area"], ["areas"])).toBe(false);
  });

  it("is permissive when nothing is selected — an empty selection is not a constraint", () => {
    expect(tagsInScope([], [])).toBe(true);
    expect(tagsInScope([], ["anything"])).toBe(true);
  });
});

describe("folder AND tags", () => {
  it("requires both when both are set", () => {
    const s = scope({ folder: "Projects", tags: ["work"] });
    expect(noteInScope(s, "Projects/Myne", ["work"])).toBe(true);
    expect(noteInScope(s, "Personal", ["work"])).toBe(false);
    expect(noteInScope(s, "Projects/Myne", ["home"])).toBe(false);
  });

  it("applies whichever half is set", () => {
    expect(noteInScope(scope({ folder: "Projects" }), "Projects/Myne", [])).toBe(true);
    expect(noteInScope(scope({ tags: ["work"] }), "Anywhere", ["work"])).toBe(true);
  });
});

describe("narrowing a task list", () => {
  const tags: Record<string, string[]> = {
    a: ["work"],
    b: ["home"],
    c: [],
  };
  const tagsOf = (id: string): readonly string[] => tags[id] ?? [];
  const tasks = [task("a", "Projects/Myne"), task("b", "Projects"), task("c", "Personal")];

  it("returns everything for an empty scope", () => {
    expect(filterTasksByScope(tasks, EMPTY_SCOPE, tagsOf).map((t) => t.noteId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("narrows by folder subtree", () => {
    expect(
      filterTasksByScope(tasks, scope({ folder: "Projects" }), tagsOf).map((t) => t.noteId),
    ).toEqual(["a", "b"]);
  });

  it("narrows by OR'd tags", () => {
    expect(
      filterTasksByScope(tasks, scope({ tags: ["work", "home"] }), tagsOf).map((t) => t.noteId),
    ).toEqual(["a", "b"]);
  });

  it("narrows by both together", () => {
    expect(
      filterTasksByScope(tasks, scope({ folder: "Projects", tags: ["work"] }), tagsOf).map(
        (t) => t.noteId,
      ),
    ).toEqual(["a"]);
  });

  it("does not mutate the shared cached list", () => {
    const frozen = Object.freeze([...tasks]);
    expect(() => filterTasksByScope(frozen, EMPTY_SCOPE, tagsOf)).not.toThrow();
  });
});

describe("no new query leaf is introduced", () => {
  it("an unset scope is the degenerate `all` leaf", () => {
    expect(scopeToFilter(EMPTY_SCOPE)).toEqual({ kind: "all" });
  });

  it("a folder alone is one inFolder leaf", () => {
    expect(scopeToFilter(scope({ folder: "Projects" }))).toEqual({
      kind: "inFolder",
      path: "Projects",
    });
  });

  it("one tag is one hasTag leaf — not an or-node of one", () => {
    expect(scopeToFilter(scope({ tags: ["work"] }))).toEqual({ kind: "hasTag", tag: "work" });
  });

  it("several tags are an OR of hasTag leaves", () => {
    expect(scopeToFilter(scope({ tags: ["work", "home"] }))).toEqual({
      kind: "or",
      children: [
        { kind: "hasTag", tag: "work" },
        { kind: "hasTag", tag: "home" },
      ],
    });
  });

  it("folder plus tags is an AND over the two", () => {
    expect(scopeToFilter(scope({ folder: "Projects", tags: ["work", "home"] }))).toEqual({
      kind: "and",
      children: [
        { kind: "inFolder", path: "Projects" },
        {
          kind: "or",
          children: [
            { kind: "hasTag", tag: "work" },
            { kind: "hasTag", tag: "home" },
          ],
        },
      ],
    });
  });

  it("uses only leaf kinds the saved-views AST already froze", () => {
    const kinds = new Set<string>();
    const walk = (n: { kind: string; children?: unknown[] }): void => {
      kinds.add(n.kind);
      for (const c of (n.children ?? []) as Array<{ kind: string }>) walk(c);
    };
    walk(scopeToFilter(scope({ folder: "P", tags: ["a", "b"] })));
    for (const kind of kinds) {
      expect(["all", "and", "or", "not", "hasTag", "inFolder", "search", "property"]).toContain(
        kind,
      );
    }
  });
});

describe("toggling tags", () => {
  it("adds and removes, preserving selection order", () => {
    let s = EMPTY_SCOPE;
    s = toggleScopeTag(s, "work");
    s = toggleScopeTag(s, "home");
    expect(s.tags).toEqual(["work", "home"]);
    s = toggleScopeTag(s, "work");
    expect(s.tags).toEqual(["home"]);
  });

  it("removes case-insensitively — the same fold the matcher uses", () => {
    const s = toggleScopeTag({ folder: null, tags: ["Work"] }, "work");
    expect(s.tags).toEqual([]);
  });

  it("leaves the folder alone", () => {
    expect(toggleScopeTag(scope({ folder: "Projects" }), "work").folder).toBe("Projects");
  });

  it("an emptied selection is empty scope again", () => {
    const s = toggleScopeTag(toggleScopeTag(EMPTY_SCOPE, "work"), "work");
    expect(isScopeEmpty(s)).toBe(true);
  });
});
