// MYND-562: folded-identity decoration keying + fold-on-load migration.
import { describe, expect, it } from "vitest";

import {
  foldDecorationKeys,
  rewriteFolderPrefix,
} from "../../src/notes/decorationRewrite";

describe("foldDecorationKeys (fold-on-load migration)", () => {
  it("folds display-cased folder keys and leaves note UUIDs untouched", () => {
    const { next, changed } = foldDecorationKeys({
      "PERSONAL/": "clay",
      "Work/Myne/": "moss",
      "note-uuid-123": "ochre", // note color — no trailing slash, never folded
    });
    expect(changed).toBe(true);
    expect(next).toEqual({
      "personal/": "clay",
      "work/myne/": "moss",
      "note-uuid-123": "ochre",
    });
  });

  it("is idempotent — folding an already-folded map changes nothing", () => {
    const folded = { "personal/": "clay", "note-uuid": "moss" };
    const once = foldDecorationKeys(folded);
    expect(once.changed).toBe(false);
    expect(once.next).toBe(folded); // same reference — caller skips persist
    const twice = foldDecorationKeys(once.next);
    expect(twice.next).toEqual(folded);
  });

  it("resolves a fold-collision to the lexicographic-min raw key's value", () => {
    // "PERSONAL/" (0x50) sorts before "personal/" (0x70): its value wins,
    // deterministic and identical on every device.
    const { next, changed } = foldDecorationKeys({
      "personal/": "moss",
      "PERSONAL/": "clay",
    });
    expect(changed).toBe(true);
    expect(next).toEqual({ "personal/": "clay" });
  });
});

describe("rewriteFolderPrefix (rename keeps folded keys)", () => {
  it("re-roots a renamed subtree into folded space", () => {
    const { next, changed } = rewriteFolderPrefix(
      { "projects/": "clay", "projects/myne/": "moss", "other/": "slate" },
      "Projects/",
      "Work/",
    );
    expect(changed).toBe(true);
    expect(next).toEqual({
      "work/": "clay",
      "work/myne/": "moss",
      "other/": "slate", // outside the renamed subtree — untouched
    });
  });

  it("treats a case-only rename as a no-op (folded identity unchanged)", () => {
    const map = { "projects/": "clay" };
    const { next, changed } = rewriteFolderPrefix(map, "projects/", "Projects/");
    expect(changed).toBe(false);
    expect(next).toBe(map);
  });
});
