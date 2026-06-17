// WL-4 canonical emitter (MYND-38). Byte-exact §3 output is the shared contract
// with #4 conversion + #5 rename — assert the bytes precisely.

import { describe, it, expect } from "vitest";
import { emitNoteWikilink, emitFolderWikilink } from "../../src/editor/wikilink/emit";

describe("emitNoteWikilink (§3, WL-4 always-bake folder)", () => {
  it("root note → [[<title>.md|<title>]]", () => {
    expect(emitNoteWikilink(null, "Wednesday")).toBe("[[Wednesday.md|Wednesday]]");
    expect(emitNoteWikilink("", "Wednesday")).toBe("[[Wednesday.md|Wednesday]]");
  });

  it("nested note bakes the folder segment", () => {
    expect(emitNoteWikilink("Projects/", "Foo")).toBe("[[Projects/Foo.md|Foo]]");
    expect(emitNoteWikilink("notes/2025/", "01-10")).toBe("[[notes/2025/01-10.md|01-10]]");
  });

  it("explicit display overrides the alias", () => {
    expect(emitNoteWikilink("Projects/", "Foo", "My Foo")).toBe("[[Projects/Foo.md|My Foo]]");
  });

  it("spaces in the title are literal (§3.4 — no URL-encoding)", () => {
    expect(emitNoteWikilink(null, "01-10 Wednesday")).toBe(
      "[[01-10 Wednesday.md|01-10 Wednesday]]",
    );
  });
});

describe("emitFolderWikilink (MYND-370 folder-target form)", () => {
  it("inserts the trailing-slash path verbatim, no alias", () => {
    expect(emitFolderWikilink("Projects/")).toBe("[[Projects/]]");
  });

  it("preserves a nested folder path's trailing slash", () => {
    expect(emitFolderWikilink("Projects/Myne/")).toBe("[[Projects/Myne/]]");
  });
});
