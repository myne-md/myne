// patchFrontmatterField (generic keyed scalar surgery, 4-state incl. delete).
//
// The key-parameterised generalisation of patchFolderField, used by setNoteCover
// to write a saved view's cover-image reference into an arbitrary user property.
// `cover` is NOT a Myne-managed canonical field — these tests pin the generic
// A/B/C/D states + YAML quoting of an attachment-embed value (which carries `[`).

import { describe, it, expect } from "vitest";
import { patchFrontmatterField } from "../../src/dialect/surgery";
import { enc, dec } from "./_helpers";

const apply = (src: string, key: string, value: string | null): string =>
  dec.decode(patchFrontmatterField(enc.encode(src), key, value));

// A realistic cover value — a form-C attachment embed (starts with `!`, carries
// `[` and `|`), so it MUST be double-quoted to round-trip as a YAML scalar.
const EMBED = "![[att:abc123|cover.png]]";

describe("patchFrontmatterField — state A (no frontmatter)", () => {
  it("prepends a canonical FM block carrying the key, quoting the embed", () => {
    expect(apply("# Hello\n", "cover", EMBED)).toBe(
      `---\ncover: "${EMBED}"\n---\n\n# Hello\n`,
    );
  });
});

describe("patchFrontmatterField — state B (FM present, key absent)", () => {
  it("inserts the key before the closing fence, after existing keys", () => {
    expect(apply("---\ntitle: Foo\n---\n\nbody", "cover", EMBED)).toBe(
      `---\ntitle: Foo\ncover: "${EMBED}"\n---\n\nbody`,
    );
  });
});

describe("patchFrontmatterField — state C (key present, replace)", () => {
  it("replaces an existing plain value", () => {
    expect(apply("---\ncover: old\n---\n\nbody", "cover", EMBED)).toBe(
      `---\ncover: "${EMBED}"\n---\n\nbody`,
    );
  });
  it("preserves an existing double-quote style", () => {
    expect(apply('---\ncover: "x"\n---\n\nbody', "cover", "plain")).toBe(
      '---\ncover: "plain"\n---\n\nbody',
    );
  });
  it("preserves a trailing comment on the line", () => {
    expect(apply("---\ncover: old # keep\n---\n\nbody", "cover", "new")).toBe(
      "---\ncover: new # keep\n---\n\nbody",
    );
  });
  it("only touches the exact key (not a prefix collision)", () => {
    // `cover_note` must not be mistaken for `cover`.
    expect(
      apply("---\ncover_note: keep\ncover: old\n---\n\nb", "cover", "new"),
    ).toBe("---\ncover_note: keep\ncover: new\n---\n\nb");
  });
});

describe("patchFrontmatterField — state D (delete)", () => {
  it("removes the key line but keeps other keys", () => {
    expect(apply("---\ntitle: Foo\ncover: x\n---\n\nbody", "cover", null)).toBe(
      "---\ntitle: Foo\n---\n\nbody",
    );
  });
  it("removes the whole block when deleting the only key (empty-block collapse)", () => {
    expect(apply("---\ncover: x\n---\n\nbody", "cover", null)).toBe("body");
  });
  it("is a no-op when the key is absent", () => {
    expect(apply("---\ntitle: Foo\n---\n\nbody", "cover", null)).toBe(
      "---\ntitle: Foo\n---\n\nbody",
    );
  });
  it("is a no-op when there is no frontmatter", () => {
    expect(apply("# Hello\n", "cover", null)).toBe("# Hello\n");
  });
});
