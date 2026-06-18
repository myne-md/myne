// WL-4 canonical emitter (MYND-38). Byte-exact §3 output is the shared contract
// with #4 conversion + #5 rename — assert the bytes precisely.

import { describe, it, expect } from "vitest";
import {
  emitNoteWikilink,
  emitFolderWikilink,
  emitHeadingAnchorWikilink,
  emitVaultHeadingWikilink,
} from "../../src/editor/wikilink/emit";

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

describe("emitHeadingAnchorWikilink (MYND-305 hybrid — `[[#` compact form)", () => {
  it("emits the target-less compact form for a current-note heading", () => {
    expect(emitHeadingAnchorWikilink("Setup")).toBe("[[#Setup]]");
  });

  it("preserves spaces in the heading verbatim", () => {
    expect(emitHeadingAnchorWikilink("Getting Started")).toBe("[[#Getting Started]]");
  });
});

describe("emitVaultHeadingWikilink (MYND-305 hybrid — `[[##` full path form)", () => {
  it("emits the canonical path form with the anchor + a default `Title › Heading` alias", () => {
    expect(emitVaultHeadingWikilink("Projects/", "Spec", "Goals")).toBe(
      "[[Projects/Spec.md#Goals|Spec › Goals]]",
    );
  });

  it("root note bakes just the filename", () => {
    expect(emitVaultHeadingWikilink(null, "Daily", "Morning")).toBe(
      "[[Daily.md#Morning|Daily › Morning]]",
    );
  });

  it("an explicit display overrides the default alias", () => {
    expect(emitVaultHeadingWikilink("notes/", "01-10", "Plan", "My Plan")).toBe(
      "[[notes/01-10.md#Plan|My Plan]]",
    );
  });
});
