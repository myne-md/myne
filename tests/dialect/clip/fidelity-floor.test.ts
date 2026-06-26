// Clip serializer — task 2 (capture-extraction): fidelity-floor block + inline
// core (§5 canonical emit forms). Extends the task-1 round-trip rig
// (`./_rig.ts`) construct-by-construct:
//
//   - ATX headings H1–H6 (canonical); Setext underline → normalized to ATX
//   - bullet `- ` / ordered `1. ` lists, incl. nested (canonical indentation)
//   - horizontal rule `---`
//   - emphasis family `*italic*` / `**bold**` / `~~strike~~`
//   - inline links `[text](url)`; reference-style `[text][ref]` + `[ref]: url`
//     definition → normalized to a single inline link
//
// A clip is AUTHORED canonical-D1 content (SYNC-7), so already-canonical
// constructs round-trip to a structurally-identical tree (`assertCanonicalD1`).
// The two NORMALIZATION constructs (Setext→ATX, ref-link→inline) change the tree
// shape by design, so their round-trip target is the CANONICAL EQUIVALENT input
// (asserted via the rig's lower-level `shapeOf` + `serializeClipMarkdown`,
// without touching `_rig.ts`'s signature).

import { describe, expect, it } from "vitest";
import { serializeClipMarkdown } from "../../../src/dialect/clip";
import { assertCanonicalD1, assertIdempotent, shapeOf } from "./_rig";

describe("clip serializer — ATX headings", () => {
  it("emits H1–H6 canonically and round-trips", () => {
    for (let level = 1; level <= 6; level++) {
      const hashes = "#".repeat(level);
      const input = `${hashes} Heading ${level}\n`;
      const emitted = assertCanonicalD1(input);
      expect(emitted).toBe(`${hashes} Heading ${level}`);
    }
  });

  it("strips a closing-hash ATX run to the canonical open-only form", () => {
    const emitted = serializeClipMarkdown("## Title ##\n");
    expect(emitted).toBe("## Title");
    // Re-parses to the same heading level.
    expect(shapeOf(emitted)).toBe(shapeOf("## Title\n"));
  });

  it("collapses surplus space after the hashes", () => {
    expect(serializeClipMarkdown("#    Spaced\n")).toBe("# Spaced");
  });

  it("emits inline emphasis inside a heading", () => {
    const emitted = assertCanonicalD1("## A *word* here\n");
    expect(emitted).toBe("## A *word* here");
  });
});

describe("clip serializer — Setext → ATX normalization", () => {
  it("normalizes a Setext H1 underline to ATX `# `", () => {
    const emitted = serializeClipMarkdown("Title here\n==========\n");
    expect(emitted).toBe("# Title here");
    // Round-trip target is the ATX equivalent, not the Setext source.
    expect(shapeOf(emitted)).toBe(shapeOf("# Title here\n"));
  });

  it("normalizes a Setext H2 underline to ATX `## `", () => {
    const emitted = serializeClipMarkdown("Subtitle\n--------\n");
    expect(emitted).toBe("## Subtitle");
    expect(shapeOf(emitted)).toBe(shapeOf("## Subtitle\n"));
  });

  it("is idempotent through the Setext→ATX normalization", () => {
    const once = serializeClipMarkdown("Heading\n===\n");
    expect(serializeClipMarkdown(once)).toBe(once);
  });
});

describe("clip serializer — bullet lists", () => {
  it("emits `- ` bullets and round-trips", () => {
    const emitted = assertCanonicalD1("- one\n- two\n- three\n");
    expect(emitted).toBe("- one\n- two\n- three");
  });

  it("normalizes `* ` / `+ ` bullets to canonical `- `", () => {
    const emitted = serializeClipMarkdown("* one\n* two\n");
    expect(emitted).toBe("- one\n- two");
    expect(shapeOf(emitted)).toBe(shapeOf("- one\n- two\n"));
  });

  it("coalesces a marker-split bullet run into one tight list (idempotent)", () => {
    // `* a` then `+ b` parse as TWO bullet lists (marker change); both
    // normalize to `- `, so they coalesce to one tight list.
    const emitted = assertIdempotent("* a\n+ b\n");
    expect(emitted).toBe("- a\n- b");
  });
});

describe("clip serializer — ordered lists", () => {
  it("emits `1. ` ordered items and round-trips", () => {
    const emitted = assertCanonicalD1("1. one\n2. two\n");
    expect(emitted).toBe("1. one\n2. two");
  });

  it("normalizes `1) ` ordered markers to canonical `1. `", () => {
    const emitted = serializeClipMarkdown("1) one\n2) two\n");
    expect(emitted).toBe("1. one\n2. two");
    expect(shapeOf(emitted)).toBe(shapeOf("1. one\n2. two\n"));
  });

  it("renumbers an ordered list that does not start at 1", () => {
    expect(serializeClipMarkdown("5. five\n6. six\n")).toBe("1. five\n2. six");
  });

  it("coalesces a marker-split ordered run with continuous numbering (idempotent)", () => {
    // `1. a` then `1) b` parse as TWO ordered lists (marker change), both
    // normalize to `1. ` — coalesced to one list with continuous numbering.
    const emitted = assertIdempotent("1. a\n1) b\n");
    expect(emitted).toBe("1. a\n2. b");
  });
});

describe("clip serializer — nested lists", () => {
  it("emits nested bullets with canonical indentation and round-trips", () => {
    const input = "- one\n  - nested a\n  - nested b\n- two\n";
    const emitted = assertCanonicalD1(input);
    expect(emitted).toBe("- one\n  - nested a\n  - nested b\n- two");
  });

  it("emits a nested ordered list inside a bullet item", () => {
    const input = "- one\n  1. n1\n  2. n2\n";
    const emitted = assertCanonicalD1(input);
    expect(emitted).toBe("- one\n  1. n1\n  2. n2");
  });

  it("emits deeply-nested lists with canonical 2-space-per-level indent", () => {
    const input = "- a\n  - b\n    - c\n";
    const emitted = assertCanonicalD1(input);
    expect(emitted).toBe("- a\n  - b\n    - c");
  });
});

describe("clip serializer — horizontal rule", () => {
  it("emits `---` and round-trips", () => {
    const emitted = assertCanonicalD1("para\n\n---\n\nmore\n");
    expect(emitted).toBe("para\n\n---\n\nmore");
  });

  it("normalizes `***` / `___` rules to canonical `---`", () => {
    expect(serializeClipMarkdown("a\n\n***\n\nb\n")).toBe("a\n\n---\n\nb");
    expect(serializeClipMarkdown("a\n\n___\n\nb\n")).toBe("a\n\n---\n\nb");
  });
});

describe("clip serializer — emphasis family", () => {
  it("emits `*italic*` and round-trips", () => {
    const emitted = assertCanonicalD1("an *italic* word\n");
    expect(emitted).toBe("an *italic* word");
  });

  it("emits `**bold**` and round-trips", () => {
    const emitted = assertCanonicalD1("a **bold** word\n");
    expect(emitted).toBe("a **bold** word");
  });

  it("emits `~~strike~~` and round-trips", () => {
    const emitted = assertCanonicalD1("a ~~struck~~ word\n");
    expect(emitted).toBe("a ~~struck~~ word");
  });

  it("normalizes `_italic_` / `__bold__` to the canonical `*`/`**` family", () => {
    expect(serializeClipMarkdown("_italic_ and __bold__\n")).toBe(
      "*italic* and **bold**",
    );
  });

  it("emits nested emphasis (bold inside italic) canonically", () => {
    const emitted = assertCanonicalD1("*a **b** c*\n");
    expect(emitted).toBe("*a **b** c*");
  });
});

describe("clip serializer — inline links", () => {
  it("emits `[text](url)` and round-trips", () => {
    const emitted = assertCanonicalD1("see [text](https://example.com) here\n");
    expect(emitted).toBe("see [text](https://example.com) here");
  });

  it("preserves a link title", () => {
    const emitted = assertCanonicalD1(
      '[text](https://example.com "a title")\n',
    );
    expect(emitted).toBe('[text](https://example.com "a title")');
  });

  it("emits emphasis inside link text", () => {
    const emitted = assertCanonicalD1("[a *b* c](https://x.com)\n");
    expect(emitted).toBe("[a *b* c](https://x.com)");
  });
});

describe("clip serializer — reference link → inline normalization", () => {
  it("normalizes a full reference link `[text][ref]` to a single inline link", () => {
    const emitted = serializeClipMarkdown(
      "[text][ref]\n\n[ref]: https://example.com\n",
    );
    expect(emitted).toBe("[text](https://example.com)");
    expect(shapeOf(emitted)).toBe(shapeOf("[text](https://example.com)\n"));
  });

  it("normalizes a collapsed reference link `[ref][]`", () => {
    const emitted = serializeClipMarkdown(
      "[ref][]\n\n[ref]: https://example.com\n",
    );
    expect(emitted).toBe("[ref](https://example.com)");
    expect(shapeOf(emitted)).toBe(shapeOf("[ref](https://example.com)\n"));
  });

  it("normalizes a shortcut reference link `[ref]`", () => {
    const emitted = serializeClipMarkdown(
      "[ref]\n\n[ref]: https://example.com\n",
    );
    expect(emitted).toBe("[ref](https://example.com)");
    expect(shapeOf(emitted)).toBe(shapeOf("[ref](https://example.com)\n"));
  });

  it("resolves reference labels case-insensitively (CommonMark fold)", () => {
    const emitted = serializeClipMarkdown(
      "[text][Ref]\n\n[REF]: https://example.com\n",
    );
    expect(emitted).toBe("[text](https://example.com)");
  });

  it("does not emit the resolved `[ref]: url` definition line", () => {
    const emitted = serializeClipMarkdown(
      "[text][ref]\n\n[ref]: https://example.com\n",
    );
    expect(emitted).not.toContain("[ref]:");
  });

  it("leaves a dangling reference (no matching definition) as plain text", () => {
    const emitted = serializeClipMarkdown("[text][missing]\n");
    expect(emitted).toContain("[text][missing]");
  });

  it("is idempotent through the reference→inline normalization", () => {
    assertIdempotent("[text][ref]\n\n[ref]: https://example.com\n");
  });
});

describe("clip serializer — combined authored-note fidelity", () => {
  it("round-trips a realistic multi-construct clip", () => {
    const input = [
      "# Article title",
      "",
      "Intro with *italic*, **bold**, ~~struck~~ text and a [link](https://x.com).",
      "",
      "- first point",
      "- second point",
      "  - a sub-point",
      "",
      "1. step one",
      "2. step two",
      "",
      "---",
      "",
      "## Closing",
      "",
      "Final paragraph.",
      "",
    ].join("\n");
    assertCanonicalD1(input);
  });
});
