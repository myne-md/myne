// The folder scope's matcher (myne-md/myne#1075).
//
// The library, the MCP grant and the agent's exclusion set all answer "is this
// under that folder", and the answer has to be anchored at a segment boundary:
// an unanchored prefix test says `Dersler/` is inside `Ders/`, which is two
// different folders that happen to share three letters.

import { describe, expect, it } from "vitest";
import { folderMatchesScope } from "../../src/notes/attachmentFolderScope";

describe("folderMatchesScope", () => {
  it("matches the scope itself", () => {
    expect(folderMatchesScope("Ders Notları/", "Ders Notları/")).toBe(true);
  });

  it("matches a subfolder, which is what a term actually holds", () => {
    expect(folderMatchesScope("Ders Notları/Hafta 3/", "Ders Notları/")).toBe(true);
    expect(folderMatchesScope("Ders Notları/Hafta 3/Alt/", "Ders Notları/")).toBe(true);
  });

  it("does not match a sibling that shares a prefix", () => {
    expect(folderMatchesScope("Dersler/", "Ders/")).toBe(false);
    expect(folderMatchesScope("Ders Notları 2/", "Ders Notları/")).toBe(false);
  });

  it("treats an empty scope as the whole vault", () => {
    expect(folderMatchesScope("", "")).toBe(true);
    expect(folderMatchesScope("Anything/", "")).toBe(true);
  });

  it("does not match a file at the root when a scope is set", () => {
    expect(folderMatchesScope("", "Ders Notları/")).toBe(false);
  });

  it("ignores case, because the catalog keeps display case", () => {
    expect(folderMatchesScope("ders notları/", "Ders Notları/")).toBe(true);
    expect(folderMatchesScope("inbox/read/", "Inbox/")).toBe(true);
  });

  it("folds ASCII case only, which is what both sides actually need", () => {
    // JS `toLowerCase` is not locale-aware: the Turkish dotted and dotless i do
    // not fold into each other. Both sides of a real comparison come from the
    // same stored path, so this only matters for a hand-typed scope, and a
    // locale-aware fold would be a bigger claim than the field makes.
    expect(folderMatchesScope("DERS NOTLARI/", "ders notları/")).toBe(false);
  });

  it("accepts a scope without a trailing slash", () => {
    expect(folderMatchesScope("Ders Notları/Hafta 1/", "Ders Notları")).toBe(true);
  });
});
