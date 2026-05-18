// Comprehensive markdown editor edge-case test suite.
//
// Per the 2026-05-17 deep-research catalog
// (`agent-tooling/researches/2026-05-17-markdown-toggle-edge-cases.md`),
// this file pins ~60 cases across 15 categories that a CommonMark-compliant
// editor must handle correctly under toggle / wrap / cursor-aware reveal
// pressure. Each test maps to a (category, case-id) tuple from the catalog
// so failures can be triaged against the canonical CommonMark / @lezer/
// markdown / Obsidian-equivalent expected behavior.
//
// Categories:
//   A — Basic toggle (no overlap)                 — A1-A8
//   B — Marker straddling                          — B1-B6
//   C — Empty selection / collapsed cursor         — C1-C5
//   D — Word boundaries / flank rules              — D1-D6
//   E — Adjacent / nested emphasis                 — E1-E6
//   F — Mod-3 ambiguity (CommonMark Rule 9)        — F1-F3
//   G — Code / link precedence (Rule 17)           — G1-G5
//   H — Lists / blockquotes / headings             — H1-H6
//   I — Frontmatter region                         — I1-I3
//   J — Wikilink / atomic-range                    — J1-J4
//   K — GFM strikethrough                          — K1-K4
//   L — Multi-paragraph / multi-line               — L1-L3
//   M — Escape sequences                           — M1-M4
//   N — Smart-toggle cursor behavior (Obsidian)    — N1-N5
//   O — Repeated / progressive toggle              — O1-O4
//
// TDD discipline: tests document EXPECTED behavior. Some cases will fail
// against the current `wrap-toggle.ts` implementation — those are the
// tier-1/2/3 fixes flagged in the research report. Skip-marked tests
// (`.skip(...)`) are catalog cases where the expected behavior is
// inherently ambiguous OR where Myne explicitly defers to a future PRD
// (e.g. AST-aware inside-code refuse).

import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { toggleWrap } from "../../src/editor/wrap-toggle";

type ToggleResult = { doc: string; selection: { from: number; to: number } };

function applyToggle(
  open: string,
  close: string,
  doc: string,
  selectionFrom: number,
  selectionTo: number,
): ToggleResult {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(selectionFrom, selectionTo),
  });
  let nextState = state;
  const cmd = toggleWrap(open, close);
  cmd({
    state,
    dispatch: (tr) => {
      nextState = tr.state;
    },
  });
  const sel = nextState.selection.main;
  return {
    doc: nextState.doc.toString(),
    selection: { from: sel.from, to: sel.to },
  };
}

/** AST-aware variant: includes the @codemirror/lang-markdown extension
 * so `syntaxTree(state)` returns the real parse tree (otherwise empty).
 * Required for tests that exercise toggleWrap's CommonMark Rule 17
 * inside-code refusal path. */
function applyToggleMd(
  open: string,
  close: string,
  doc: string,
  selectionFrom: number,
  selectionTo: number,
): ToggleResult {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(selectionFrom, selectionTo),
    extensions: [markdown({ base: markdownLanguage })],
  });
  let nextState = state;
  const cmd = toggleWrap(open, close);
  cmd({
    state,
    dispatch: (tr) => {
      nextState = tr.state;
    },
  });
  const sel = nextState.selection.main;
  return {
    doc: nextState.doc.toString(),
    selection: { from: sel.from, to: sel.to },
  };
}

/** Parse `doc` through @codemirror/lang-markdown and return the list of
 * non-trivial syntax tree node names with their byte ranges. Used to pin
 * CommonMark parse expectations (mod-3 ambiguity, GFM strike, escapes,
 * link/code precedence). */
type ParsedNode = { name: string; from: number; to: number; text: string };
function parseNodes(doc: string): ParsedNode[] {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
  });
  const tree = syntaxTree(state);
  const nodes: ParsedNode[] = [];
  tree.iterate({
    from: 0,
    to: doc.length,
    enter: (node) => {
      if (node.name === "Document" || node.name === "Paragraph") return;
      nodes.push({
        name: node.name,
        from: node.from,
        to: node.to,
        text: doc.slice(node.from, node.to),
      });
    },
  });
  return nodes;
}

// =============================================================================
// Category A — Basic toggle (no overlap)
// =============================================================================

describe("A. Basic toggle on plain text (no existing markers)", () => {
  it("A1: bold wraps plain text", () => {
    expect(applyToggle("**", "**", "foo", 0, 3).doc).toBe("**foo**");
  });
  it("A2: italic wraps plain text", () => {
    expect(applyToggle("*", "*", "foo", 0, 3).doc).toBe("*foo*");
  });
  it("A3: strike wraps plain text", () => {
    expect(applyToggle("~~", "~~", "foo", 0, 3).doc).toBe("~~foo~~");
  });
  it("A4: inline-code wraps plain text", () => {
    expect(applyToggle("`", "`", "foo", 0, 3).doc).toBe("`foo`");
  });
  it("A5: bold unwraps when markers surround selection", () => {
    expect(applyToggle("**", "**", "**foo**", 2, 5).doc).toBe("foo");
  });
  it("A6: italic unwraps when markers surround selection", () => {
    expect(applyToggle("*", "*", "*foo*", 1, 4).doc).toBe("foo");
  });
  it("A7: strike unwraps when markers surround selection", () => {
    expect(applyToggle("~~", "~~", "~~foo~~", 2, 5).doc).toBe("foo");
  });
  it("A8: code unwraps when markers surround selection", () => {
    expect(applyToggle("`", "`", "`foo`", 1, 4).doc).toBe("foo");
  });
});

// =============================================================================
// Category B — Marker straddling
// =============================================================================

describe("B. Marker straddling (existing emphasis inside selection)", () => {
  it("B1: italic toggle on `b**c` (straddle bold close) → `*b****c*`", () => {
    // From `test**ab**cdefg`, selecting `bc` in rendered view = source 7..11
    // covering `b**c`. CommonMark mod-3: result `test**a*b****c*defg`
    // parses as Strong(a + Emphasis(b)) + Emphasis(c).
    expect(applyToggle("*", "*", "test**ab**cdefg", 7, 11).doc).toBe(
      "test**a*b****c*defg",
    );
  });
  it("B2: italic toggle on `**ab**c` (selection starts at bold open)", () => {
    // parts = ['', 'ab', 'c'] — empty leading chunk produces no wrap.
    expect(applyToggle("*", "*", "**ab**c", 0, 7).doc).toBe("***ab****c*");
  });
  it("B3: italic toggle wrapping entire `x**ab**y`", () => {
    expect(applyToggle("*", "*", "x**ab**y", 0, 8).doc).toBe("*x****ab****y*");
  });
  it.skip("B4: bold toggle on `*ab*c` straddling italic close — needs AST awareness", () => {
    // Selecting `b*c` (positions 1..5) in `*ab*c` and applying bold.
    // Expected (Obsidian): preserve italic structure, e.g.
    // `*a*b****c**` analog for the italic case. Currently falls through
    // to plain wrap → `**ab*c**` which breaks the italic.
    // Tier-1 fix candidate: extend split-rewrap heuristic to bold + `*`.
    const r = applyToggle("**", "**", "*ab*c", 1, 5);
    expect(r.doc).toBe("*a**b****c***"); // placeholder; refine when fix lands
  });
  it.skip("B5: italic toggle on space between two bold spans", () => {
    // `**foo** **bar**` — selecting just the middle space + adjacent
    // markers. Expected (Obsidian): refuse OR insert markers without
    // breaking bold parsing.
    expect(applyToggle("*", "*", "**foo** **bar**", 7, 8).doc).toBe(
      "**foo** **bar**", // refuse: cursor in marker-adjacent whitespace
    );
  });
  it.skip("B6: underscore-italic toggle on text with `__` bold", () => {
    // Underscore italic has different flank rules — intraword `_` forbidden.
    // Naive wrap might produce parser-rejected output.
    expect(applyToggle("_", "_", "__ab__c", 0, 7).doc).toBe(
      "___ab____c_", // analog of B2 — verify parses correctly
    );
  });
});

// =============================================================================
// Category C — Empty selection / collapsed cursor
// =============================================================================

describe("C. Empty selection (collapsed cursor)", () => {
  it("C1: bold on empty selection inserts `**|**` with caret between", () => {
    const r = applyToggle("**", "**", "hello ", 6, 6);
    expect(r.doc).toBe("hello ****");
    expect(r.selection).toEqual({ from: 8, to: 8 });
  });
  it("C2: italic on empty selection inserts `*|*`", () => {
    const r = applyToggle("*", "*", "hello ", 6, 6);
    expect(r.doc).toBe("hello **");
    expect(r.selection).toEqual({ from: 7, to: 7 });
  });
  it("C3: cursor at `*foo|*` + italic → jumps past closer (Obsidian smart-toggle)", () => {
    // Source `*foo*`, cursor at position 4 (just before closing `*`).
    // Expected: doc unchanged, cursor at 5 (after closer).
    const r = applyToggle("*", "*", "*foo*", 4, 4);
    expect(r.doc).toBe("*foo*");
    expect(r.selection).toEqual({ from: 5, to: 5 });
  });
  it("C4: cursor at `**foo|**` + bold → jumps past closer", () => {
    const r = applyToggle("**", "**", "**foo**", 5, 5);
    expect(r.doc).toBe("**foo**");
    expect(r.selection).toEqual({ from: 7, to: 7 });
  });
  it("C5: cursor at `*|foo*` + italic (Obsidian: jump past opener; Typora: strip)", () => {
    // Myne hedef: Obsidian semantics (jump past opener).
    const r = applyToggle("*", "*", "*foo*", 1, 1);
    expect(r.doc).toBe("*foo*");
    expect(r.selection).toEqual({ from: 0, to: 0 });
  });
});

// =============================================================================
// Category D — Word boundaries / flank rules
// =============================================================================

describe("D. Word boundaries + CommonMark flank rules", () => {
  it("D1: italic toggle on intraword `bar` of `foobar` → `foo*bar*` (asterisk OK)", () => {
    expect(applyToggle("*", "*", "foobar", 3, 6).doc).toBe("foo*bar*");
  });
  it.skip("D2: underscore-italic on intraword `bar` → refuse OR escape (CommonMark Rule 6 forbids)", () => {
    // Naive wrap produces `foo_bar_` which @lezer/markdown parses as
    // literal (no emphasis). Either refuse the toggle or insert
    // a fallback (`\_bar\_` escapes don't help here — `*` is the safe
    // fallback). Myne policy: prefer `*` over `_` for italic anyway.
    expect(applyToggle("_", "_", "foobar", 3, 6).doc).not.toBe("foo_bar_");
  });
  it("D3: bold on whole word with surrounding spaces", () => {
    expect(applyToggle("**", "**", "abc def ghi", 4, 7).doc).toBe(
      "abc **def** ghi",
    );
  });
  it("D4: bold on word followed by punctuation", () => {
    expect(applyToggle("**", "**", "abc.def", 0, 3).doc).toBe("**abc**.def");
  });
  it("D5: italic on `foo` in `foo* *bar` (adjacent existing marker)", () => {
    // The existing `*` characters are not part of an emphasis run yet
    // (single `*` left-flanking, single `*` right-flanking, gap-separated).
    // Naive wrap produces `*foo** *bar` — parser may misinterpret.
    expect(applyToggle("*", "*", "foo* *bar", 0, 3).doc).toBe(
      "*foo** *bar", // OR cleaner alternative
    );
  });
  it("D6: italic with selection ending at end-of-line punctuation", () => {
    expect(applyToggle("*", "*", "foo.", 0, 4).doc).toBe("*foo.*");
  });
});

// =============================================================================
// Category E — Adjacent / nested emphasis
// =============================================================================

describe("E. Adjacent / nested emphasis", () => {
  it("E1: bold-toggle on `***foo***` strips outer `**`, leaves `*foo*`", () => {
    // `***foo***` is StrongEmphasis(Emphasis(foo)). Toggling bold off
    // should remove the strong layer, leaving italic.
    expect(applyToggle("**", "**", "***foo***", 3, 6).doc).toBe("*foo*");
  });
  it("E2: italic-toggle on `***foo***` strips inner `*`, leaves `**foo**`", () => {
    expect(applyToggle("*", "*", "***foo***", 3, 6).doc).toBe("**foo**");
  });
  it("E3: italic-toggle on `b` in `**a**b**c**` (adjacent bold spans)", () => {
    // Naive wrap: `**a***b***c**` — parses as Strong + literal `*` + b + ...
    // Better: preserve the two bold spans, italic just the b.
    const before = "**a**b**c**";
    const r = applyToggle("*", "*", before, 5, 6);
    expect(r.doc).toBe("**a***b***c**"); // verify what @lezer/markdown does
  });
  it.skip("E4: italic-toggle on space between `**foo** **bar**`", () => {
    expect(applyToggle("*", "*", "**foo** **bar**", 7, 8).doc).toBe(
      "**foo***** ****bar**", // unclear; verify Obsidian
    );
  });
  it("E5: parse-only assertion — `*foo**bar**baz*`", () => {
    // CommonMark mod-3: italic outer containing strong inner.
    // Toggle italic on this entire selection should unwrap to
    // `foo**bar**baz`.
    expect(applyToggle("*", "*", "*foo**bar**baz*", 1, 14).doc).toBe(
      "foo**bar**baz",
    );
  });
  it("E6: bold + italic sequential toggle on plain text", () => {
    // foo → bold → **foo** → italic on `foo` → **|*foo*|** ?
    // First bold:
    const after1 = applyToggle("**", "**", "foo", 0, 3);
    expect(after1.doc).toBe("**foo**");
    // Then italic on the inner foo (2..5):
    const after2 = applyToggle("*", "*", after1.doc, 2, 5);
    expect(after2.doc).toBe("***foo***");
  });
});

// =============================================================================
// Category F — Mod-3 ambiguity (CommonMark Rule 9) — parse-level expectations
// =============================================================================

describe("F. CommonMark Rule 9 mod-3 ambiguity (parse-level pins)", () => {
  // These tests don't exercise toggleWrap; they document expected
  // @lezer/markdown parses that future AST-aware toggles should respect.
  it("F1: `*foo**bar*` parses as Emphasis (rule 9 mod-3 rejects `**`)", () => {
    const nodes = parseNodes("*foo**bar*");
    const emphasis = nodes.find((n) => n.name === "Emphasis");
    expect(emphasis).toBeDefined();
    expect(emphasis!.text).toBe("*foo**bar*");
    // No StrongEmphasis node — the `**` is consumed as literal inside.
    expect(nodes.find((n) => n.name === "StrongEmphasis")).toBeUndefined();
  });
  it("F2: `**foo*bar**` parses as StrongEmphasis (inner `*` literal)", () => {
    const nodes = parseNodes("**foo*bar**");
    const strong = nodes.find((n) => n.name === "StrongEmphasis");
    expect(strong).toBeDefined();
    // Lezer's StrongEmphasis node spans the full `**...**` including the
    // marker bytes (per resolveMarkers `start = open.to - size`,
    // `end = close.from + size`).
    expect(strong!.text).toBe("**foo*bar**");
    expect(nodes.find((n) => n.name === "Emphasis")).toBeUndefined();
  });
  it("F3: `foo***bar***baz` — Emphasis outer, StrongEmphasis inner (CommonMark Rule 14)", () => {
    const nodes = parseNodes("foo***bar***baz");
    const emphasis = nodes.find((n) => n.name === "Emphasis");
    const strong = nodes.find((n) => n.name === "StrongEmphasis");
    expect(emphasis).toBeDefined();
    expect(strong).toBeDefined();
    // Per CommonMark Rule 14, `<em><strong>...` is preferred over
    // `<strong><em>...` — so StrongEmphasis sits INSIDE Emphasis.
    expect(strong!.from).toBeGreaterThanOrEqual(emphasis!.from);
    expect(strong!.to).toBeLessThanOrEqual(emphasis!.to);
  });
});

// =============================================================================
// Category G — Code / link / image precedence (CommonMark Rule 17)
// =============================================================================

describe("G. Code / link / image precedence (Rule 17)", () => {
  it("G1: bold toggle inside `` `code` `` refuses (Rule 17, AST-aware)", () => {
    // Inside-InlineCode toggle is a no-op via the syntax-tree refuse
    // path in `toggleWrap`. Needs the markdown extension in state.
    const r = applyToggleMd("**", "**", "`code`", 1, 5);
    expect(r.doc).toBe("`code`");
  });
  it("G2: bold toggle on link text → nested emphasis OK", () => {
    expect(applyToggle("**", "**", "[foo](url)", 1, 4).doc).toBe(
      "[**foo**](url)",
    );
  });
  it("G3: italic toggle straddling link boundary refuses (AST-aware)", () => {
    // Selection from `f` (in `[foo](url)`) to inside the URL.
    // toggleWrap refuses via the URL-straddle AST check; doc unchanged.
    const r = applyToggleMd("*", "*", "[foo](url)", 1, 8);
    expect(r.doc).toBe("[foo](url)");
  });
  it("G4: parse pin — `*[foo*](bar)` is link with literal `*` (Rule 17)", () => {
    const nodes = parseNodes("*[foo*](bar)");
    const link = nodes.find((n) => n.name === "Link");
    expect(link).toBeDefined();
    // No Emphasis node should be formed — the `*`s straddle a link
    // boundary, link wins per Rule 17.
    expect(nodes.find((n) => n.name === "Emphasis")).toBeUndefined();
  });
  it("G5: bold on image alt text", () => {
    expect(applyToggle("**", "**", "![alt](src)", 2, 5).doc).toBe(
      "![**alt**](src)",
    );
  });
});

// =============================================================================
// Category H — Lists / blockquotes / headings
// =============================================================================

describe("H. List / blockquote / heading prefixes preserved", () => {
  it("H1: bold on list item content preserves `- ` marker", () => {
    expect(applyToggle("**", "**", "- foo", 2, 5).doc).toBe("- **foo**");
  });
  it("H2: bold on blockquote line preserves `> `", () => {
    expect(applyToggle("**", "**", "> foo", 2, 5).doc).toBe("> **foo**");
  });
  it("H3: bold on ATX heading content preserves `# `", () => {
    expect(applyToggle("**", "**", "# heading text", 2, 14).doc).toBe(
      "# **heading text**",
    );
  });
  it("H4: italic on numbered-list item content", () => {
    expect(applyToggle("*", "*", "1. item", 3, 7).doc).toBe("1. *item*");
  });
  it("H5: bold on task-list content preserves `- [ ] `", () => {
    expect(applyToggle("**", "**", "- [ ] task", 6, 10).doc).toBe(
      "- [ ] **task**",
    );
  });
  it("H6: bold on setext-heading first line preserves underline (line 2 untouched)", () => {
    // Selection covers only `foo`; toggle should not touch the `===` line.
    expect(applyToggle("**", "**", "foo\n===", 0, 3).doc).toBe(
      "**foo**\n===",
    );
  });
});

// =============================================================================
// Category I — Frontmatter region
// =============================================================================

describe("I. Frontmatter region (toggle policy)", () => {
  it("I1: italic toggle inside YAML frontmatter body refuses (no source mutation)", () => {
    // toggleWrap refuses when range falls inside the frontmatter body
    // range (via `cachedLocateFrontmatter`). The decoration layer
    // already renders the body as a Properties widget; the source is
    // left byte-stable.
    const doc = "---\nkey: value\n---\nbody";
    // Selection inside `value` — positions 9..14.
    const r = applyToggle("*", "*", doc, 9, 14);
    expect(r.doc).toBe(doc);
  });
  it("I2: bold toggle inside frontmatter body refuses", () => {
    const doc = "---\ntitle: My Note\n---\n";
    const r = applyToggle("**", "**", doc, 11, 18);
    expect(r.doc).toBe(doc);
  });
  it.skip("I3: `---` line in body parses as HorizontalRule, not closing frontmatter", () => {
    // Covered by tests/editor/hr-frontmatter.test.ts. Kept here as a
    // catalog cross-reference (no separate assertion).
    expect("covered-elsewhere").toBe("covered-elsewhere");
  });
});

// =============================================================================
// Category J — Wikilink / atomic-range
// =============================================================================

describe("J. Wikilink atomic-range edge cases (catalog cross-ref)", () => {
  it.skip("J1: bold toggle inside `[[Note]]` chip — atomic, selection snaps", () => {
    // Already partially covered by atomic-range.test.ts A4. Kept here
    // as a toggle-specific cross-reference.
    expect("placeholder").toBe("placeholder");
  });
  it.skip("J2: italic toggle across `text [[Note]] more` chip boundary", () => {
    expect("placeholder").toBe("placeholder");
  });
  it.skip("J3: toggle between adjacent chips `[[A]][[B]]`", () => {
    expect("placeholder").toBe("placeholder");
  });
  it.skip("J4: `![[Embed]]` chip atomic interaction with bold-toggle", () => {
    expect("placeholder").toBe("placeholder");
  });
});

// =============================================================================
// Category K — GFM strikethrough
// =============================================================================

describe("K. GFM strikethrough", () => {
  it("K1: strike toggle on `~~strike~~` unwraps", () => {
    expect(applyToggle("~~", "~~", "~~strike~~", 2, 8).doc).toBe("strike");
  });
  it("K2: single-tilde `~strike~` parses as plain text (lezer requires `~~`)", () => {
    const nodes = parseNodes("~strike~");
    // No Strikethrough node — lezer's GFM strikethrough needs exactly `~~`.
    expect(nodes.find((n) => n.name === "Strikethrough")).toBeUndefined();
  });
  it("K3: three tildes `~~~strike~~~` not strikethrough (GFM Ex 493)", () => {
    const nodes = parseNodes("~~~strike~~~");
    expect(nodes.find((n) => n.name === "Strikethrough")).toBeUndefined();
  });
  it("K4: strike toggle on text containing single `~` inside (`strike~stuff`)", () => {
    // `~~strike~stuff~~` — the interior single `~` is fine, not a marker.
    expect(applyToggle("~~", "~~", "strike~stuff", 0, 12).doc).toBe(
      "~~strike~stuff~~",
    );
  });
});

// =============================================================================
// Category L — Multi-paragraph / multi-line
// =============================================================================

describe("L. Multi-paragraph / multi-line selections", () => {
  it("L1: bold across paragraph break wraps per-paragraph (Obsidian 1.5.2)", () => {
    // `foo\n\nbar` selecting 0..7 — naive wrap produces `**foo\n\nbar**`
    // which only bolds the first paragraph (CommonMark: emphasis can't
    // span blank lines). Obsidian splits into `**foo**\n\n**bar**`.
    expect(applyToggle("**", "**", "foo\n\nbar", 0, 8).doc).toBe(
      "**foo**\n\n**bar**",
    );
  });
  it("L2: bold within same paragraph (single newline) wraps as one span", () => {
    expect(applyToggle("**", "**", "foo\nbar", 0, 7).doc).toBe("**foo\nbar**");
  });
  it("L3: selection ending with trailing newline trims before wrap", () => {
    // `foo\n` selecting 0..4 (includes trailing \n) — wrap should not
    // include the newline.
    expect(applyToggle("**", "**", "foo\n", 0, 4).doc).toBe("**foo**\n");
  });
});

// =============================================================================
// Category M — Escape sequences
// =============================================================================

describe("M. Escape sequences", () => {
  it("M1: parse pin — `\\*foo\\*` is literal, not italic", () => {
    const nodes = parseNodes("\\*foo\\*");
    // No Emphasis — both `*`s are backslash-escaped.
    expect(nodes.find((n) => n.name === "Emphasis")).toBeUndefined();
    // The backslash escapes themselves should be recognized as Escape
    // nodes by lezer.
    const escapes = nodes.filter((n) => n.name === "Escape");
    expect(escapes.length).toBe(2);
  });
  it.skip("M2: italic toggle on already-escaped `\\*foo\\*` strips escapes", () => {
    // Toggle on `\*foo\*` should produce `*foo*` (italic) — i.e.,
    // recognize the escapes were preventing emphasis and now we want it.
    expect(applyToggle("*", "*", "\\*foo\\*", 2, 5).doc).toBe("*foo*");
  });
  it("M3: parse pin — `**foo\\*\\***` is StrongEmphasis containing escaped `**`", () => {
    const nodes = parseNodes("**foo\\*\\***");
    const strong = nodes.find((n) => n.name === "StrongEmphasis");
    expect(strong).toBeDefined();
    expect(strong!.text).toBe("**foo\\*\\***");
    // Escaped `\*` inside should be Escape nodes, not Emphasis markers.
    const escapes = nodes.filter((n) => n.name === "Escape");
    expect(escapes.length).toBe(2);
  });
  it("M4: backslash-escape inside selection preserved literally", () => {
    expect(applyToggle("**", "**", "foo\\bar", 0, 7).doc).toBe("**foo\\bar**");
  });
});

// =============================================================================
// Category N — Smart-toggle cursor behavior (Obsidian model)
// =============================================================================

describe("N. Smart-toggle cursor behavior (Obsidian 0.14.4+ model)", () => {
  it("N1: cursor before closer of `*foo*` + italic → cursor jumps past closer", () => {
    const r = applyToggle("*", "*", "*foo*", 4, 4);
    expect(r.doc).toBe("*foo*");
    expect(r.selection).toEqual({ from: 5, to: 5 });
  });
  it("N2: cursor before closer of `**foo**` + bold → cursor jumps past closer", () => {
    const r = applyToggle("**", "**", "**foo**", 5, 5);
    expect(r.doc).toBe("**foo**");
    expect(r.selection).toEqual({ from: 7, to: 7 });
  });
  it("N3: cursor after opener of `*foo*` + italic → cursor jumps past opener", () => {
    const r = applyToggle("*", "*", "*foo*", 1, 1);
    expect(r.doc).toBe("*foo*");
    expect(r.selection).toEqual({ from: 0, to: 0 });
  });
  it("N4: cursor mid-span of `*foo*bar` + italic → moves to right edge of span", () => {
    const r = applyToggle("*", "*", "*foo*bar", 3, 3);
    expect(r.doc).toBe("*foo*bar");
    expect(r.selection).toEqual({ from: 5, to: 5 });
  });
  it("N5: second italic toggle at the same cursor inserts new `*|*` pair", () => {
    // First toggle: cursor at 5 (past closer) — handled by N1.
    // Second toggle: now cursor is OUTSIDE any emphasis → insert new pair.
    // Sequence:
    // Start: doc=`*foo*`, cursor=4
    // After N1: doc=`*foo*`, cursor=5
    // After N5: doc=`*foo***`, cursor=6
    const after1 = applyToggle("*", "*", "*foo*", 4, 4);
    const after2 = applyToggle(
      "*",
      "*",
      after1.doc,
      after1.selection.from,
      after1.selection.to,
    );
    expect(after2.doc).toBe("*foo***");
  });
});

// =============================================================================
// Category O — Repeated / progressive toggle
// =============================================================================

describe("O. Repeated / progressive toggle (idempotency, layering)", () => {
  it("O1: bold toggle twice on plain text is identity", () => {
    const after1 = applyToggle("**", "**", "foo", 0, 3);
    expect(after1.doc).toBe("**foo**");
    const after2 = applyToggle(
      "**",
      "**",
      after1.doc,
      after1.selection.from,
      after1.selection.to,
    );
    expect(after2.doc).toBe("foo");
  });
  it("O2: bold then italic layers correctly", () => {
    const after1 = applyToggle("**", "**", "foo", 0, 3);
    // Selection after wrap covers the inner `foo`.
    const after2 = applyToggle(
      "*",
      "*",
      after1.doc,
      after1.selection.from,
      after1.selection.to,
    );
    expect(after2.doc).toBe("***foo***");
  });
  it("O3: `***foo***` + bold-toggle leaves italic", () => {
    expect(applyToggle("**", "**", "***foo***", 3, 6).doc).toBe("*foo*");
  });
  it("O4: `***foo***` + italic-toggle leaves bold", () => {
    expect(applyToggle("*", "*", "***foo***", 3, 6).doc).toBe("**foo**");
  });
});
