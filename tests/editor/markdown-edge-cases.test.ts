// Comprehensive markdown editor edge-case test suite.
//
// Per the 2026-05-17 deep-research catalog
// (`myne-agents/researches/2026-05-17-markdown-toggle-edge-cases.md`),
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
// myne-md/myne#802 trimmed this file: categories F and J were removed, along
// with the parser-only pins G4 and the exact duplicates I3, K2, K3, M1, M3 and
// O3-O4. The category list above is the catalog's original roster, not a claim
// about which cases still run; the `it(...)` bodies below are the source of
// truth for surviving coverage.
//
// TDD discipline: tests document EXPECTED behavior. Some cases will fail
// against the current `wrap-toggle.ts` implementation — those are the
// tier-1/2/3 fixes flagged in the research report. Skip-marked tests
// (`.skip(...)`) are catalog cases where the expected behavior is
// inherently ambiguous OR where Myne explicitly defers to a future PRD
// (e.g. AST-aware inside-code refuse).

import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { toggleWrap } from "../../src/editor/wrap-toggle";
import { completeState } from "./_parse-budget";

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
  const state = completeState(
    EditorState.create({
      doc,
      selection: EditorSelection.single(selectionFrom, selectionTo),
      extensions: [markdown({ base: markdownLanguage })],
    }),
  );
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
  // Selecting `b*c` (positions 1..5) in `*ab*c` and applying bold. Expected
  // (Obsidian): preserve italic structure, e.g. the `*a*b****c**` analog for the
  // italic case. Currently falls through to plain wrap → `**ab*c**`, which breaks
  // the italic. Tier-1 fix candidate: extend the split-rewrap heuristic to bold + `*`.
  it.todo("B4: bold toggle on `*ab*c` straddling italic close — needs AST awareness");
  // `**foo** **bar**` — selecting just the middle space + adjacent markers.
  // Expected (Obsidian): refuse, or insert markers without breaking bold parsing.
  it.todo("B5: italic toggle on space between two bold spans");
  // Underscore italic has different flank rules — intraword `_` is forbidden, so a
  // naive wrap can produce parser-rejected output.
  it.todo("B6: underscore-italic toggle on text with `__` bold");
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
  // A naive wrap produces `foo_bar_`, which @lezer/markdown parses as literal (no
  // emphasis). Either refuse the toggle or insert a fallback (`\_bar\_` escapes do not
  // help here; `*` is the safe fallback). Myne policy: prefer `*` over `_` anyway.
  it.todo("D2: underscore-italic on intraword `bar` → refuse OR escape (CommonMark Rule 6 forbids)");
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
  // Same subject as B5, on the adjacent-span shape; the expected output is unresolved.
  it.todo("E4: italic-toggle on space between `**foo** **bar**`");
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
});

// =============================================================================
// Category K — GFM strikethrough
// =============================================================================

describe("K. GFM strikethrough", () => {
  it("K1: strike toggle on `~~strike~~` unwraps", () => {
    expect(applyToggle("~~", "~~", "~~strike~~", 2, 8).doc).toBe("strike");
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
  // Toggle on `\*foo\*` should produce `*foo*` (italic): recognize that the escapes
  // were preventing emphasis and now we want it.
  it.todo("M2: italic toggle on already-escaped `\\*foo\\*` strips escapes");
  it("M4: backslash-escape inside selection preserved literally", () => {
    expect(applyToggle("**", "**", "foo\\bar", 0, 7).doc).toBe("**foo\\bar**");
  });
});

// =============================================================================
// Category N — Smart-toggle cursor behavior (Obsidian model)
// =============================================================================

describe("N. Smart-toggle cursor behavior (Obsidian 0.14.4+ model)", () => {
  // N1-N3 of the catalog (cursor before the closer / after the opener) are the
  // exact shapes already pinned by C3-C5, so they are not repeated here. The two
  // cases below are the ones C does not cover.
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
  // O3/O4 (the nested-layer toggles) are the same shapes already pinned by
  // E1/E2, so they are not repeated here.
});
