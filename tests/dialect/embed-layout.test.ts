// Form-C embed layout segments (myne-md/myne#409 task 3).
//
// The grammar, in one place:
//
//     ![[att:<id>|filename|w=300|align=center|alt=free text to the end]]
//
//     w     = <1..8192> | <1..100>%
//     h     = <1..8192>
//     align = left | center | right
//     alt   = terminal, swallows the rest
//
// Three binding rules, each of which exists because of a specific failure:
//
//   1. Segment 1 is ALWAYS the filename, and from segment 2 on an UNKEYED
//      segment rejoins the filename with its `|`. An attachment filename can
//      already contain a pipe today (`renameFileCard` only trims, and a pipe is
//      a legal POSIX filename character), so `![[att:<id>|re|port.png]]` is
//      already on disk. A positional or shape-recognised grammar would silently
//      reinterpret those notes.
//   2. `alt=` is terminal. Alt text is free prose and can contain a pipe, and
//      the importer carries `![A sunset | 2026](photo.png)` into this slot, so
//      forbidding the character would mean mutating user content on import.
//   3. Reporting splits by case. An UNRECOGNISED key is version skew (three
//      clients ship independently against one synced vault, so the note is
//      right and the client is old) and is dropped SILENTLY. A KNOWN key with
//      an INVALID value is author error, the only fixable case, and is dropped
//      AND reported with its source text verbatim.

import { describe, expect, it } from "vitest";
import {
  MAX_EMBED_DIMENSION_PX,
  emitEmbedAlias,
  emptyEmbedLayout,
  isAliasSafeText,
  parseEmbedAlias,
  sanitizeAliasText,
  type EmbedLayout,
} from "@myne/dialect/embedLayout";

const layout = (over: Partial<EmbedLayout> = {}): EmbedLayout => ({
  ...emptyEmbedLayout(),
  ...over,
});

describe("parseEmbedAlias: filename", () => {
  it("takes the whole alias when there are no segments", () => {
    const r = parseEmbedAlias("photo.png");
    expect(r.filename).toBe("photo.png");
    expect(r.layout).toEqual(emptyEmbedLayout());
    expect(r.dropped).toEqual([]);
  });

  it("keeps a pipe-bearing filename intact (the regression this grammar exists for)", () => {
    const r = parseEmbedAlias("re|port.png");
    expect(r.filename).toBe("re|port.png");
    expect(r.dropped).toEqual([]);
  });

  it("keeps a pipe-bearing filename intact ALONGSIDE a real key", () => {
    const r = parseEmbedAlias("re|port.png|w=300");
    expect(r.filename).toBe("re|port.png");
    expect(r.layout.widthPx).toBe(300);
    expect(r.dropped).toEqual([]);
  });

  it("keeps a filename that itself looks like a key, because segment 1 is positional", () => {
    const r = parseEmbedAlias("w=300.png");
    expect(r.filename).toBe("w=300.png");
    expect(r.layout.widthPx).toBeNull();
  });

  it("tolerates an empty alias", () => {
    const r = parseEmbedAlias("");
    expect(r.filename).toBe("");
    expect(r.layout).toEqual(emptyEmbedLayout());
  });
});

describe("parseEmbedAlias: valid values", () => {
  it("reads a pixel width", () => {
    expect(parseEmbedAlias("p.png|w=300").layout).toEqual(layout({ widthPx: 300 }));
  });

  it("reads a percentage width", () => {
    expect(parseEmbedAlias("p.png|w=100%").layout).toEqual(layout({ widthPercent: 100 }));
  });

  it("reads a height", () => {
    expect(parseEmbedAlias("p.png|h=200").layout).toEqual(layout({ heightPx: 200 }));
  });

  it("reads width and height together", () => {
    expect(parseEmbedAlias("p.png|w=300|h=200").layout).toEqual(
      layout({ widthPx: 300, heightPx: 200 }),
    );
  });

  it.each(["left", "center", "right"] as const)("reads align=%s", (a) => {
    expect(parseEmbedAlias(`p.png|align=${a}`).layout.align).toBe(a);
  });

  it("is order-free", () => {
    expect(parseEmbedAlias("p.png|align=center|w=300").layout).toEqual(
      layout({ widthPx: 300, align: "center" }),
    );
  });

  it("accepts the ceiling exactly", () => {
    expect(parseEmbedAlias(`p.png|w=${MAX_EMBED_DIMENSION_PX}`).layout.widthPx).toBe(
      MAX_EMBED_DIMENSION_PX,
    );
  });
});

describe("parseEmbedAlias: alt text is terminal", () => {
  it("reads alt text", () => {
    expect(parseEmbedAlias("p.png|alt=A sunset").layout.alt).toBe("A sunset");
  });

  it("swallows pipes, so alt prose is unconstrained", () => {
    expect(parseEmbedAlias("p.png|alt=A sunset | 2026").layout.alt).toBe("A sunset | 2026");
  });

  it("swallows anything that looks like a later key", () => {
    const r = parseEmbedAlias("p.png|alt=a|w=300");
    expect(r.layout.alt).toBe("a|w=300");
    expect(r.layout.widthPx).toBeNull();
  });

  it("distinguishes an authored-empty alt (decorative) from an absent one", () => {
    expect(parseEmbedAlias("p.png|alt=").layout.alt).toBe("");
    expect(parseEmbedAlias("p.png").layout.alt).toBeNull();
  });

  it("still reads keys written before it", () => {
    const r = parseEmbedAlias("p.png|w=300|align=right|alt=A | B");
    expect(r.layout).toEqual(layout({ widthPx: 300, align: "right", alt: "A | B" }));
  });
});

describe("parseEmbedAlias: invalid values are dropped AND reported", () => {
  it.each([
    ["w=abc", "non-numeric width"],
    ["w=0", "zero"],
    ["w=-5", "negative"],
    [`w=${MAX_EMBED_DIMENSION_PX + 1}`, "over the ceiling"],
    ["w=0300", "leading zero, non-canonical"],
    ["w=101%", "over 100 percent"],
    ["w=0%", "zero percent"],
    ["h=abc", "non-numeric height"],
    ["h=50%", "percent is width-only"],
    ["align=diagonal", "not in the closed set"],
    ["align=Center", "case-sensitive closed set"],
  ])("drops and reports %s (%s)", (segment) => {
    const r = parseEmbedAlias(`p.png|${segment}`);
    expect(r.layout).toEqual(emptyEmbedLayout());
    expect(r.dropped.map((d) => d.source)).toEqual([segment]);
    expect(r.filename).toBe("p.png");
  });

  it("reports a duplicate known key and keeps the first", () => {
    const r = parseEmbedAlias("p.png|w=300|w=400");
    expect(r.layout.widthPx).toBe(300);
    expect(r.dropped.map((d) => d.source)).toEqual(["w=400"]);
  });

  it("keeps the valid keys around an invalid one", () => {
    const r = parseEmbedAlias("p.png|w=abc|align=center");
    expect(r.layout.align).toBe("center");
    expect(r.layout.widthPx).toBeNull();
    expect(r.dropped.map((d) => d.source)).toEqual(["w=abc"]);
  });
});

describe("parseEmbedAlias: unrecognised keys are dropped SILENTLY", () => {
  it.each(["z=9", "future=x", "caption=hello", "W=300"])(
    "ignores %s without reporting it",
    (segment) => {
      const r = parseEmbedAlias(`p.png|${segment}`);
      expect(r.layout).toEqual(emptyEmbedLayout());
      expect(r.dropped).toEqual([]);
      expect(r.filename).toBe("p.png");
    },
  );

  it("does not fold an unrecognised key into the filename", () => {
    // Folding would corrupt the visible chip label on an older client reading a
    // newer client's note, which is the routine case across three independently
    // versioned clients against one synced vault.
    expect(parseEmbedAlias("p.png|align=center").filename).toBe("p.png");
  });
});

describe("emitEmbedAlias", () => {
  it("emits the filename alone when there is no layout", () => {
    expect(emitEmbedAlias("photo.png", emptyEmbedLayout())).toBe("photo.png");
  });

  it("emits keys in the canonical order with alt last", () => {
    expect(
      emitEmbedAlias("p.png", layout({ widthPx: 300, heightPx: 200, align: "center", alt: "x" })),
    ).toBe("p.png|w=300|h=200|align=center|alt=x");
  });

  it("emits a percentage width", () => {
    expect(emitEmbedAlias("p.png", layout({ widthPercent: 100 }))).toBe("p.png|w=100%");
  });

  it("emits an authored-empty alt and omits an absent one", () => {
    expect(emitEmbedAlias("p.png", layout({ alt: "" }))).toBe("p.png|alt=");
    expect(emitEmbedAlias("p.png", layout({ alt: null }))).toBe("p.png");
  });
});

describe("round trip", () => {
  it.each([
    ["photo.png", emptyEmbedLayout()],
    ["re|port.png", emptyEmbedLayout()],
    ["p.png", layout({ widthPx: 300 })],
    ["p.png", layout({ widthPercent: 55 })],
    ["p.png", layout({ widthPx: 300, heightPx: 200 })],
    ["p.png", layout({ align: "left" })],
    ["p.png", layout({ alt: "" })],
    ["p.png", layout({ alt: "A | B | C" })],
    ["re|port.png", layout({ widthPx: 300, align: "right", alt: "x | y" })],
  ])("parse(emit(%s)) is identity", (filename, l) => {
    const r = parseEmbedAlias(emitEmbedAlias(filename, l));
    expect(r.filename).toBe(filename);
    expect(r.layout).toEqual(l);
    expect(r.dropped).toEqual([]);
  });
});

// --- unknown segments survive a re-emit (pr-review, myne#409) --------------
//
// The parser was already silent about an unrecognised key, which is right. The
// EMITTER was the hole: it rebuilds the alias from `{filename, layout}`, so a
// segment absent from the parse was destroyed the next time an author touched
// the embed. Two different things land here and are indistinguishable by shape,
// which is why neither may be guessed at: a key a newer client wrote, and a
// fragment of a filename containing both a pipe and an equals sign.

describe("unknown keyed segments survive a round trip", () => {
  it("retains a key this version does not know", () => {
    const r = parseEmbedAlias("photo.png|future=keepme|w=300");
    expect(r.unknown).toEqual(["future=keepme"]);
    expect(r.dropped).toEqual([]); // still silent: nothing the reader can act on
    expect(emitEmbedAlias(r.filename, r.layout, r.unknown)).toBe(
      "photo.png|w=300|future=keepme",
    );
  });

  it("re-emits a pipe-and-equals filename byte-for-byte", () => {
    const r = parseEmbedAlias("re|port=v2.png");
    expect(r.unknown).toEqual(["port=v2.png"]);
    expect(emitEmbedAlias(r.filename, r.layout, r.unknown)).toBe("re|port=v2.png");
  });

  it("keeps unknown segments ahead of the terminal alt", () => {
    const r = parseEmbedAlias("photo.png|z=9|alt=A | B");
    expect(emitEmbedAlias(r.filename, r.layout, r.unknown)).toBe("photo.png|z=9|alt=A | B");
  });

  it("a non-canonical key shape is filename, not an unknown key", () => {
    // `2024=report.png` has no leading letter, so it never had key shape.
    const r = parseEmbedAlias("re|2024=report.png");
    expect(r.filename).toBe("re|2024=report.png");
    expect(r.unknown).toEqual([]);
  });

  // ── the round trip is total: NEITHER bucket may be destroyed ──────────────

  it("re-emits a dropped segment, so a bad value survives the next edit", () => {
    // The bug this pins: `dropped` was parsed, reported, and then left out of
    // the emitter, so one click on an alignment row deleted the author's bytes
    // AND the marker that was the only thing telling them to fix it. Three
    // statements on this feature's own branch say that does not happen
    // (`wikilink.md` §5.1, the glossary, this module's parse comment); all
    // three were true of the parser and false of the round trip.
    const r = parseEmbedAlias("photo.png|w=99999|align=center");
    expect(r.dropped.map((d) => d.source)).toEqual(["w=99999"]);
    expect(emitEmbedAlias(r.filename, r.layout, r.unknown, r.dropped)).toBe(
      "photo.png|align=center|w=99999",
    );
  });

  it("re-emits a dropped segment written by a NEWER client", () => {
    // The version-skew case the retain rule exists for, and the reason
    // `dropped` needs it as much as `unknown` does: a client that widens the
    // ceiling writes `w=12000`, and an older client reads that as a KNOWN key
    // with a bad value, so it lands in `dropped` rather than in `unknown`.
    const r = parseEmbedAlias("photo.png|w=12000");
    expect(r.dropped.map((d) => d.source)).toEqual(["w=12000"]);
    expect(emitEmbedAlias(r.filename, r.layout, r.unknown, r.dropped)).toBe(
      "photo.png|w=12000",
    );
  });

  it("keeps both retained buckets ahead of the terminal alt", () => {
    const r = parseEmbedAlias("photo.png|z=9|w=99999|alt=A | B");
    expect(emitEmbedAlias(r.filename, r.layout, r.unknown, r.dropped)).toBe(
      "photo.png|z=9|w=99999|alt=A | B",
    );
  });

  // ── what may be written into an alias ─────────────────────────────────────

  it("refuses a single `]`, not merely `]]`", () => {
    // A `]` splits the four form-C readers: the lezer scan looks for the first
    // `]]` PAIR and matches the embed whole, while `extractAttachmentRefs`,
    // mobile's markdown rule and mobile's attachmentRef all bound the alias
    // with `[^\]]` and match NOTHING. The note then leaves the attachment's
    // referencing set, the delete confirmation stops warning, and the user can
    // crypto-erase a blob that is still embedded in a note that still renders
    // it. The guard that checked `]]` let the worse of the two through.
    expect(isAliasSafeText("A sunset")).toBe(true);
    expect(isAliasSafeText("A sunset | 2026")).toBe(true);
    expect(isAliasSafeText("")).toBe(true);
    expect(isAliasSafeText("Figure [1]")).toBe(false);
    expect(isAliasSafeText("Figure [1] caption")).toBe(false);
    expect(isAliasSafeText("ends]]")).toBe(false);
    // A line break is refused for a second reason: a cover value is spliced
    // into a YAML frontmatter scalar, and `formatYamlScalar` quotes but does
    // not escape one, so a raw newline opens a second physical line that the
    // Rust line-scanning readers treat as a field of their own.
    expect(isAliasSafeText("two\nlines")).toBe(false);
    expect(isAliasSafeText("carriage\rreturn")).toBe(false);
  });

  it("sanitizes a filename the caller cannot fix, and only what breaks a reader", () => {
    // The catalog is not a trusted source of alias-safe text: nothing rejects a
    // `]` on attachment import or rename. An embed carrying one parses as ZERO
    // spans, and attachment liveness is derived from those spans, so a cover
    // whose filename has one makes its attachment read as unreferenced and
    // `attachment_clean_unused` erases a blob the note still names.
    expect(sanitizeAliasText("report[final].png")).toBe("report[final_.png");
    expect(sanitizeAliasText("a]b.png")).toBe("a_b.png");
    expect(sanitizeAliasText("photo\ntrashed: 2026-01-01T00:00:00Z")).toBe(
      "photo_trashed: 2026-01-01T00:00:00Z",
    );

    // NOT sanitized, and each for a stated reason. A `|` is legal because an
    // unkeyed segment rejoins the filename, which is what lets an attachment be
    // called `re|port.png`; a `[` is harmless inside an alias; ordinary
    // punctuation and non-ASCII are untouched.
    expect(sanitizeAliasText("re|port.png")).toBe("re|port.png");
    expect(sanitizeAliasText("写真 (1).png")).toBe("写真 (1).png");
    expect(sanitizeAliasText("plain.png")).toBe("plain.png");
  });

  it("emits an alias that reads back, for every name the catalog can hold", () => {
    // The round-trip property, asserted rather than documented. The spec used
    // to record this hole as "one-sided" and leave it: the emitter interpolated
    // a filename verbatim, so an attachment whose name contained a `]` could be
    // written as a cover and then read back as no cover at all.
    for (const name of ["a]b.png", "report[final].png", "re|port.png", "写真.png", "x\ny.png"]) {
      const alias = emitEmbedAlias(sanitizeAliasText(name), emptyEmbedLayout());
      expect(alias.includes("]"), `${name}: emitted alias must not contain ]`).toBe(false);
      expect(parseEmbedAlias(alias).filename).toBe(sanitizeAliasText(name));
    }
  });

  it("demonstrates the reader divergence a `]` causes", () => {
    // Not a mock: the two real shapes, side by side, on the same bytes. If
    // either ever agrees with the other on this input, the guard above can be
    // reconsidered; until then it is the only thing holding them together.
    const id = "a".repeat(64);
    const src = `![[att:${id}|photo.png|alt=Figure [1] caption]]`;
    // The extractor shape, verbatim from editor/src/host/notes/attachmentRef.ts.
    const extractor = /!\[\[att:([0-9a-f]{64})(?:\|([^\]]*))?\]\]/;
    expect(extractor.test(src)).toBe(false);
    // The tree scan stops at the first `]]` PAIR, which is the real one.
    expect(src.indexOf("]]")).toBe(src.length - 2);
  });
});
