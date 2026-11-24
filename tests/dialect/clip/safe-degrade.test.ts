// Clip serializer — task 7 (capture-extraction): safe-degrade for
// un-representable structure + drop constructs that have no Myne emit form.
//
// The never-broken-markdown guarantee (docs/spec/markdown-dialect.md §3 / §5 /
// §6). Two distinct behaviors, both folded into the walker's default /
// fallthrough arms:
//
//   1. SAFE-DEGRADE (un-representable structure). A construct the canonical
//      walk cannot model emits VALID markdown — its readable text (inline) or a
//      fenced code block / paragraph (block) — NEVER broken markdown that would
//      corrupt the always-canonical editor. The default arms are the deliberate
//      safety net.
//   2. DROP (no emit form). Constructs §3/§5 mark "recognize-and-render-only,
//      never emitted" — subscript `~x~`, superscript `^x^`, emoji `:name:`,
//      `%%comment%%` (inline + block), and Pandoc definition lists — are
//      DROPPED, not emitted, and never throw:
//        - Subscript / superscript: drop the MARKUP, keep the wrapped readable
//          text (`H~2~O` → `H2O`) — §3.2 sub/sup are render-only with no emit
//          form, but the text content is meaningful prose.
//        - Emoji `:name:`: a LEAF node with no readable text distinct from its
//          markup → FULL-DROP (§3.2: "the `:` autocomplete inserts the unicode
//          glyph directly … the `:name:` source is render-only, never emitted").
//          Crucially it must NOT survive as literal `:name:` (which re-parses as
//          an Emoji node — that is preservation, not a drop).
//        - `%%comment%%` (inline + block): an editor-only note-to-self that §6
//          STRIPS from every lossy projection (HTML / PDF / stripped-TXT). A
//          clip is an authored canonical-D1 projection, so the comment + its
//          content are FULL-DROPPED. An UNTERMINATED `%%` is inert (not a
//          comment, §6) → it stays literal text.
//        - Definition list: degrade to plain text lines (term + definitions),
//          dropping the `:` markers — §3.1 marks it never-emitted (no authoring
//          affordance), but the term/definition text is meaningful content.
//
// After any degrade the output is still valid canonical D1: it re-parses to a
// clean tree carrying NONE of the dropped-construct nodes, and a second
// serialize pass is a fixed point (idempotent). The rig's `assertRoundTrip`
// (shape-equality with the ORIGINAL input) deliberately does NOT apply to a
// DROP — the whole point is that the emit's shape differs from the input's
// (the wrapper is gone) — so these tests assert the weaker-but-correct
// post-degrade invariant directly: idempotent + clean re-parse + no-throw.

import { describe, expect, it } from "vitest";
import { parser } from "../../../src/dialect/lezer/parser";
import { serializeClipMarkdown } from "../../../src/dialect/clip";
import { shapeOf } from "./_rig";

/** Count of nodes of a given name in a parse of `emitted`. */
function countNodes(emitted: string, name: string): number {
  const tree = parser.parse(emitted);
  let n = 0;
  tree.topNode.cursor().iterate((node) => {
    if (node.name === name) n++;
    return undefined;
  });
  return n;
}

/**
 * True if a parse of `emitted` contains any parser ERROR node — the structural
 * definition of "broken markdown". Valid canonical-D1 output never re-parses
 * with an error node. (Lezer surfaces errors as nodes whose `type.isError` is
 * set, named `⚠`.)
 */
function hasParseError(emitted: string): boolean {
  const tree = parser.parse(emitted);
  let bad = false;
  tree.topNode.cursor().iterate((node) => {
    if (node.type.isError) bad = true;
    return undefined;
  });
  return bad;
}

/**
 * The post-degrade invariant a DROP / safe-degrade output must hold (since the
 * original-input shape equality deliberately does NOT hold for a drop): the emit
 * is a fixed point (idempotent) AND it re-parses with no error nodes — i.e. it
 * is valid, never-broken markdown. Returns the emitted bytes.
 */
function assertDegradedValid(input: string): string {
  const emitted = serializeClipMarkdown(input);
  // Idempotent: a second pass over a non-empty emit is a fixed point. (An emit
  // that degraded to "" can't be re-fed — serialize throws on empty by design,
  // task 1 — so the fixed-point check is scoped to non-empty output.)
  if (emitted.trim().length > 0) {
    expect(serializeClipMarkdown(emitted)).toBe(emitted);
  }
  // Valid markdown: no parser error node in the re-parse.
  expect(hasParseError(emitted)).toBe(false);
  return emitted;
}

describe("clip serializer — drop sub/superscript (keep text, no markup)", () => {
  it("drops subscript markup, keeps the wrapped text", () => {
    const input = "H~2~O is water.\n";
    const emitted = assertDegradedValid(input);
    expect(emitted).toBe("H2O is water.");
    // The Subscript wrapper is GONE on re-parse (markup not emitted).
    expect(countNodes(emitted, "Subscript")).toBe(0);
    expect(countNodes(emitted, "SubscriptMark")).toBe(0);
  });

  it("drops superscript markup, keeps the wrapped text", () => {
    const input = "E = mc^2^ exactly.\n";
    const emitted = assertDegradedValid(input);
    expect(emitted).toBe("E = mc2 exactly.");
    expect(countNodes(emitted, "Superscript")).toBe(0);
  });

  it("keeps GFM strikethrough `~~…~~` (a real emit form) while dropping `~sub~`", () => {
    // Disjoint constructs: strikethrough survives canonically, sub drops.
    const input = "A ~~strike~~ vs ~sub~ here.\n";
    const emitted = assertDegradedValid(input);
    expect(emitted).toContain("~~strike~~");
    expect(countNodes(emitted, "Strikethrough")).toBe(1);
    expect(countNodes(emitted, "Subscript")).toBe(0);
    expect(emitted).toContain("vs sub here");
  });

  it("re-canonicalizes emphasis wrapped around a dropped subscript", () => {
    const input = "x **a~1~b** y\n";
    const emitted = assertDegradedValid(input);
    expect(emitted).toContain("**a1b**");
    expect(countNodes(emitted, "StrongEmphasis")).toBe(1);
    expect(countNodes(emitted, "Subscript")).toBe(0);
  });
});

describe("clip serializer — drop emoji shortcodes (full drop)", () => {
  it("fully drops an emoji shortcode (does NOT survive as literal `:name:`)", () => {
    const input = "I :smile: you.\n";
    const emitted = assertDegradedValid(input);
    // The `:smile:` markup is gone — and crucially it does NOT re-parse as Emoji.
    expect(countNodes(emitted, "Emoji")).toBe(0);
    expect(emitted).not.toContain(":smile:");
    expect(emitted).toContain("I");
    expect(emitted).toContain("you");
  });

  it("drops multiple emoji shortcodes, leaving valid prose", () => {
    const input = "Party :tada: time :rocket: now.\n";
    const emitted = assertDegradedValid(input);
    expect(countNodes(emitted, "Emoji")).toBe(0);
    expect(emitted).not.toContain(":tada:");
    expect(emitted).not.toContain(":rocket:");
    expect(emitted).toContain("Party");
    expect(emitted).toContain("now");
  });
});

describe("clip serializer — drop `%%comments%%` (full drop, content + markup)", () => {
  it("fully drops an inline comment including its content (§6 lossy strip)", () => {
    const input = "Visible %%hidden note%% text.\n";
    const emitted = assertDegradedValid(input);
    expect(countNodes(emitted, "DialectComment")).toBe(0);
    expect(emitted).not.toContain("hidden note");
    expect(emitted).not.toContain("%%");
    expect(emitted).toContain("Visible");
    expect(emitted).toContain("text");
  });

  it("fully drops a single-line block comment", () => {
    const input = "%% a block comment %%\n";
    const emitted = serializeClipMarkdown(input);
    expect(countNodes(emitted, "DialectCommentBlock")).toBe(0);
    expect(emitted).not.toContain("a block comment");
    expect(emitted).not.toContain("%%");
  });

  it("fully drops a multi-line block comment", () => {
    const input = "%% multi\nline comment %%\n";
    const emitted = serializeClipMarkdown(input);
    expect(countNodes(emitted, "DialectCommentBlock")).toBe(0);
    expect(emitted).not.toContain("multi");
    expect(emitted).not.toContain("%%");
  });

  it("drops a block comment but keeps the surrounding prose blocks", () => {
    const input = "Above para.\n\n%% drop me %%\n\nBelow para.\n";
    const emitted = assertDegradedValid(input);
    expect(emitted).toContain("Above para.");
    expect(emitted).toContain("Below para.");
    expect(emitted).not.toContain("drop me");
    expect(countNodes(emitted, "DialectCommentBlock")).toBe(0);
    // Two surviving paragraphs, cleanly separated.
    expect(countNodes(emitted, "Paragraph")).toBe(2);
  });

  it("leaves an UNTERMINATED `%%` inert (literal text, not a comment)", () => {
    // §6: an unterminated `%%` is NOT a comment — it stays literal and is not
    // stripped. The parser leaves it as a plain Paragraph (no DialectComment).
    const input = "before %%unterminated note\n";
    const emitted = serializeClipMarkdown(input);
    expect(emitted).toContain("%%unterminated note");
    expect(countNodes(emitted, "DialectComment")).toBe(0);
    expect(countNodes(emitted, "DialectCommentBlock")).toBe(0);
  });
});

describe("clip serializer — degrade definition lists (plain text, drop `:`)", () => {
  it("degrades a definition list to plain text, dropping the `:` markers", () => {
    const input = "Term\n: Definition one\n: Definition two\n";
    const emitted = assertDegradedValid(input);
    expect(countNodes(emitted, "DefinitionList")).toBe(0);
    expect(countNodes(emitted, "DefinitionMarker")).toBe(0);
    // The term + definition TEXT is meaningful content — kept as readable prose.
    expect(emitted).toContain("Term");
    expect(emitted).toContain("Definition one");
    expect(emitted).toContain("Definition two");
    // No stray leading-`:` line that would re-parse as a definition marker.
    expect(emitted).not.toMatch(/^:/mu);
  });

  it("re-canonicalizes inline emphasis inside a degraded definition list", () => {
    const input = "Word\n: a _slanted_ definition\n";
    const emitted = assertDegradedValid(input);
    expect(countNodes(emitted, "DefinitionList")).toBe(0);
    expect(emitted).toContain("*slanted*");
  });
});

describe("clip serializer — safe-degrade never produces broken markdown", () => {
  it("keeps a recognized HTML embed verbatim (inert bytes, round-trip-safe)", () => {
    const input = "A <div>block</div> embed.\n";
    const emitted = serializeClipMarkdown(input);
    expect(hasParseError(emitted)).toBe(false);
    // An unknown HTML embed is inert source bytes — preserved, not broken, and
    // it re-parses to the same shape (the round-trip invariant for a kept node).
    expect(emitted).toContain("<div>block</div>");
    expect(shapeOf(emitted)).toBe(shapeOf(input));
  });

  it("a document that is ONLY droppable constructs degrades without throwing", () => {
    const input = "%% only a comment %%\n";
    expect(() => serializeClipMarkdown(input)).not.toThrow();
    const emitted = serializeClipMarkdown(input);
    // Whatever it degrades to must be valid (no error node).
    expect(hasParseError(emitted)).toBe(false);
  });

  it("mixed drop + keep in one paragraph stays valid and re-canonicalizes", () => {
    const input = "Mix ~s~ and ^p^ and :emoji: and %%c%% with *kept*.\n";
    const emitted = assertDegradedValid(input);
    expect(countNodes(emitted, "Subscript")).toBe(0);
    expect(countNodes(emitted, "Superscript")).toBe(0);
    expect(countNodes(emitted, "Emoji")).toBe(0);
    expect(countNodes(emitted, "DialectComment")).toBe(0);
    // The real emphasis survives canonically.
    expect(emitted).toContain("*kept*");
    expect(countNodes(emitted, "Emphasis")).toBe(1);
  });
});

describe("clip serializer — fuzz / garbage input never throws, always valid", () => {
  // A tiny deterministic LCG so the fuzz corpus is reproducible (no new dep).
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  // A character soup heavy on markdown-significant bytes so the fuzz actually
  // exercises unbalanced markers, deep nesting, and the drop constructs.
  const ALPHABET = [
    ..."abc 123\n",
    "~",
    "^",
    "%%",
    ":x:",
    "*",
    "**",
    "_",
    "`",
    "```",
    "#",
    ">",
    "- ",
    "1. ",
    "[",
    "]",
    "(",
    ")",
    "|",
    "$",
    "$$",
    "==",
    "[[",
    "]]",
    "<div>",
    "[^1]",
    ":",
    "\t",
  ];

  function randomDoc(rng: () => number, len: number): string {
    let out = "";
    for (let i = 0; i < len; i++) {
      out += ALPHABET[Math.floor(rng() * ALPHABET.length)]!;
    }
    return out;
  }

  it("produces well-formed output without throwing across a fuzz corpus", () => {
    const rng = lcg(0xc0ffee);
    for (let n = 0; n < 2000; n++) {
      const doc = randomDoc(rng, 1 + Math.floor(rng() * 100));
      // The only documented throw is the no-content guard (task 1). A fuzz doc
      // that is all-whitespace legitimately throws; everything else must not.
      if (doc.trim().length === 0) {
        expect(() => serializeClipMarkdown(doc)).toThrow();
        continue;
      }
      let emitted: string;
      expect(() => {
        emitted = serializeClipMarkdown(doc);
      }).not.toThrow();
      // The never-broken-markdown contract: the emit re-parses with NO error
      // node (valid markdown). Two-pass byte-idempotency on adversarial garbage
      // is NOT part of the contract — it is guaranteed on well-formed input
      // (pinned by the per-construct slices), but a half-parseable garbage doc
      // may re-canonicalize across a second pass (e.g. a collapsing code fence).
      // What MUST hold on garbage is no-throw + valid output, asserted here.
      if (emitted!.trim().length > 0) {
        expect(hasParseError(emitted!)).toBe(false);
      }
    }
  });

  it("survives deeply-nested unbalanced markers without throwing", () => {
    const inputs = [
      "*".repeat(200),
      "~".repeat(200),
      "^".repeat(200),
      "%%".repeat(120),
      "[".repeat(150),
      "> ".repeat(120) + "deep",
      "```".repeat(50),
      ":x:".repeat(120),
      "$".repeat(200),
      "#".repeat(120) + " heading",
    ];
    for (const input of inputs) {
      let emitted: string;
      expect(() => {
        emitted = serializeClipMarkdown(input);
      }).not.toThrow();
      if (emitted!.trim().length > 0) {
        expect(hasParseError(emitted!)).toBe(false);
      }
    }
  });

  it("a structured nested table-like blob degrades to valid markdown", () => {
    // A gnarly almost-table the parser may not model cleanly — must still emit
    // valid markdown, never a broken half-table.
    const input = "| a | b |\n| - |\n| 1 | 2 | 3 | 4 |\n";
    let emitted: string;
    expect(() => {
      emitted = serializeClipMarkdown(input);
    }).not.toThrow();
    expect(hasParseError(emitted!)).toBe(false);
  });
});
