// patchFolderField (4-state incl. state-D delete) + buildInitialPlaintext.
//
// `folder:` is the 3rd Myne-managed canonical FM field (markdown-dialect
// §3.6.1). Write trigger = create (buildInitialPlaintext) + move (patchFolderField).
// Grill: 2026-05-29-folder-hierarchy-sidebar Q5 (grammar/root) + Q7 (a2 create,
// state-D delete, empty-block removal). Inline-string fixtures (not file-based)
// for readability across the many small move/delete scenarios.

import { describe, it, expect } from "vitest";
import { patchFolderField, buildInitialPlaintext } from "../../src/dialect/surgery";
import { enc, dec } from "./_helpers";

const apply = (src: string, value: string | null): string =>
  dec.decode(patchFolderField(enc.encode(src), value));

describe("buildInitialPlaintext (a2 create-timing)", () => {
  it("builds a single-field FM block for a foldered note", () => {
    expect(buildInitialPlaintext("Projects/")).toBe(
      "---\nfolder: Projects/\n---\n\n",
    );
  });
  it("returns empty string for a root note (null)", () => {
    expect(buildInitialPlaintext(null)).toBe("");
  });
  it("returns empty string for a root note (empty string)", () => {
    expect(buildInitialPlaintext("")).toBe("");
  });
  it("quotes a YAML-unsafe folder value", () => {
    expect(buildInitialPlaintext("Q1: Plans/")).toBe(
      '---\nfolder: "Q1: Plans/"\n---\n\n',
    );
  });
});

describe("patchFolderField — state A (no frontmatter)", () => {
  it("prepends a canonical FM block carrying folder", () => {
    expect(apply("# Hello\n", "Projects/")).toBe(
      "---\nfolder: Projects/\n---\n\n# Hello\n",
    );
  });
});

describe("patchFolderField — state B (FM present, folder absent)", () => {
  it("inserts folder before the closing fence, after existing keys", () => {
    expect(apply("---\ntitle: Foo\n---\n\nbody", "Projects/")).toBe(
      "---\ntitle: Foo\nfolder: Projects/\n---\n\nbody",
    );
  });
});

describe("patchFolderField — state C (folder present, replace)", () => {
  it("replaces an existing plain folder value", () => {
    expect(apply("---\nfolder: Old/\n---\n\nbody", "New/")).toBe(
      "---\nfolder: New/\n---\n\nbody",
    );
  });
  it("preserves an existing double-quote style", () => {
    expect(apply('---\nfolder: "Old: X/"\n---\n\nbody', "New/")).toBe(
      '---\nfolder: "New/"\n---\n\nbody',
    );
  });
  it("preserves a trailing comment on the folder line", () => {
    expect(apply("---\nfolder: Old/ # keep me\n---\n\nbody", "New/")).toBe(
      "---\nfolder: New/ # keep me\n---\n\nbody",
    );
  });
  it("escalates to quoting when the new value is YAML-unsafe", () => {
    expect(apply("---\nfolder: Old/\n---\n\nbody", "Q1: Plans/")).toBe(
      '---\nfolder: "Q1: Plans/"\n---\n\nbody',
    );
  });
  it("collapses a block-scalar folder to canonical single-line", () => {
    expect(apply("---\nfolder: |\n  Old/\n---\n\nbody", "New/")).toBe(
      "---\nfolder: New/\n---\n\nbody",
    );
  });
});

describe("patchFolderField — state D (delete / move-to-root)", () => {
  it("removes the whole block when folder is the only field (with body)", () => {
    expect(apply("---\nfolder: Projects/\n---\n\n# Hello", null)).toBe(
      "# Hello",
    );
  });
  it("removes the whole block + trailing blank → empty for an empty body", () => {
    expect(apply("---\nfolder: Projects/\n---\n\n", null)).toBe("");
  });
  it("drops only the folder line when another key remains", () => {
    expect(
      apply("---\ntitle: Foo\nfolder: Projects/\n---\n\nbody", null),
    ).toBe("---\ntitle: Foo\n---\n\nbody");
  });
  it("keeps the block when only a comment remains", () => {
    expect(apply("---\nfolder: Projects/\n# note\n---\n\nbody", null)).toBe(
      "---\n# note\n---\n\nbody",
    );
  });
  it("is a no-op when there is no frontmatter", () => {
    expect(apply("# Hello\n", null)).toBe("# Hello\n");
  });
  it("is a no-op when frontmatter has no folder field", () => {
    expect(apply("---\ntitle: Foo\n---\n\nbody", null)).toBe(
      "---\ntitle: Foo\n---\n\nbody",
    );
  });
});

describe("patchFolderField — C1 byte-stability for other fields", () => {
  it("touches neither other keys, comments, nor body when setting folder", () => {
    const src =
      "---\nupdated: 2026-01-01T00:00:00Z\ntitle: Foo\ncustom: bar # c\n---\n\n# Body\ntext";
    expect(apply(src, "Projects/")).toBe(
      "---\nupdated: 2026-01-01T00:00:00Z\ntitle: Foo\ncustom: bar # c\nfolder: Projects/\n---\n\n# Body\ntext",
    );
  });
});

describe("create→move-to-root round-trip (byte-identity)", () => {
  it("delete after a single-field create yields the root form", () => {
    const foldered = buildInitialPlaintext("Projects/");
    expect(apply(foldered, null)).toBe(buildInitialPlaintext(null)); // ""
  });
  it("move-to-root on a foldered note with body yields the bare body", () => {
    const foldered = buildInitialPlaintext("Projects/") + "# Note body";
    expect(apply(foldered, null)).toBe("# Note body");
  });
});
