// Clip serializer — task 6 (capture-extraction): the remaining §5 emit set —
// callouts, task lists, footnotes, highlights.
//
// Canonical forms (docs/spec/markdown-dialect.md §5 + §3):
//   - Callout: a `Blockquote` whose first line standardizes to `[!type]` emits
//     as `> [!note] ` (and other recognized types), round-tripping as a callout
//     blockquote. A plain blockquote stays a plain `> ` quote.
//   - Task list: `- [ ]` / `- [x]` (lowercase `x` is the canonical emit; an
//     uppercase `[X]` source normalizes to lowercase `[x]`).
//   - Footnote: `[^N]` reference + `[^N]: def` definition emit canonically.
//   - Highlight (default): `==text==` (the Myne inline extension).
//   - Highlight (color): the closed embedded form
//     `<mark class="hl-green|hl-blue|hl-pink|hl-purple">text</mark>`
//     (+ `hl-yellow`). The class vocabulary is CLOSED at the sanitizer
//     (`src/editor/html/sanitize.ts` HIGHLIGHT_CLASSES, decisions.md 2026-06-15);
//     an out-of-set color is NEVER emitted as an arbitrary class — it degrades
//     to a bare `<mark>` (the sanitizer's own default-yellow fallback).

import { describe, expect, it } from "vitest";
import { parser } from "../../../src/dialect/lezer/parser";
import { serializeClipMarkdown } from "../../../src/dialect/clip";
import { HIGHLIGHT_CLASSES } from "../../../src/editor/html/sanitize";
import { assertCanonicalD1, assertIdempotent, shapeOf } from "./_rig";

/** True when a parse of `emitted` contains at least one `Blockquote` whose first
 *  line carries a `[!type]` callout header (a recognized callout). */
function hasCalloutBlockquote(emitted: string): boolean {
  const tree = parser.parse(emitted);
  let found = false;
  tree.topNode.cursor().iterate((node) => {
    if (node.name !== "Blockquote") return undefined;
    const nl = emitted.indexOf("\n", node.from);
    const end = nl === -1 || nl > node.to ? node.to : nl;
    if (/^\s*>\s*\[!\w+\]/u.test(emitted.slice(node.from, end))) found = true;
    return undefined;
  });
  return found;
}

/** The TaskMarker source bytes (`[ ]` / `[x]`) of every Task node, in order. */
function taskMarkers(emitted: string): string[] {
  const tree = parser.parse(emitted);
  const out: string[] = [];
  tree.topNode.cursor().iterate((node) => {
    if (node.name === "TaskMarker") out.push(emitted.slice(node.from, node.to));
    return undefined;
  });
  return out;
}

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

describe("clip serializer — callouts", () => {
  it("emits a standardized admonition as `> [!note] ` and round-trips as a callout", () => {
    const input = "> [!note] Title\n> body line\n";
    const emitted = assertCanonicalD1(input);
    expect(emitted).toContain("> [!note]");
    expect(hasCalloutBlockquote(emitted)).toBe(true);
  });

  it("preserves the callout type and a custom title", () => {
    const input = "> [!warning] Heads up\n> mind the gap\n";
    const emitted = assertCanonicalD1(input);
    expect(emitted).toContain("> [!warning] Heads up");
    expect(hasCalloutBlockquote(emitted)).toBe(true);
  });

  it("round-trips a bare callout with no custom title", () => {
    const input = "> [!note]\n> body\n";
    const emitted = assertCanonicalD1(input);
    expect(emitted).toContain("> [!note]");
    expect(hasCalloutBlockquote(emitted)).toBe(true);
  });

  it("leaves a plain blockquote as a plain `> ` quote (no callout header)", () => {
    const input = "> just a quote\n> second line\n";
    const emitted = assertCanonicalD1(input);
    expect(emitted.startsWith(">")).toBe(true);
    expect(hasCalloutBlockquote(emitted)).toBe(false);
    expect(countNodes(emitted, "Blockquote")).toBe(1);
  });
});

describe("clip serializer — task lists", () => {
  it("emits an unchecked item as `- [ ]` and round-trips", () => {
    const input = "- [ ] do thing\n";
    const emitted = assertCanonicalD1(input);
    expect(emitted).toContain("- [ ] do thing");
    expect(taskMarkers(emitted)).toEqual(["[ ]"]);
  });

  it("emits a checked item as lowercase `- [x]` and round-trips", () => {
    const input = "- [x] done thing\n";
    const emitted = assertCanonicalD1(input);
    expect(emitted).toContain("- [x] done thing");
    expect(taskMarkers(emitted)).toEqual(["[x]"]);
  });

  it("normalizes an uppercase `[X]` source to canonical lowercase `[x]`", () => {
    const input = "- [X] done upper\n";
    const emitted = assertCanonicalD1(input);
    expect(emitted).toContain("- [x] done upper");
    expect(emitted).not.toContain("[X]");
    expect(taskMarkers(emitted)).toEqual(["[x]"]);
  });

  it("round-trips a mixed task list", () => {
    const input = "- [ ] a\n- [x] b\n- [X] c\n";
    const emitted = assertCanonicalD1(input);
    expect(taskMarkers(emitted)).toEqual(["[ ]", "[x]", "[x]"]);
    expect(emitted).toBe("- [ ] a\n- [x] b\n- [x] c");
  });

  it("renders inline content inside a task item (emphasis canonicalizes)", () => {
    const input = "- [x] read _the_ note\n";
    const emitted = assertCanonicalD1(input);
    expect(emitted).toContain("- [x] read *the* note");
  });
});

describe("clip serializer — footnotes", () => {
  it("emits a footnote reference + definition canonically and round-trips", () => {
    const input = "See[^1] this.\n\n[^1]: the definition\n";
    const emitted = assertCanonicalD1(input);
    expect(emitted).toContain("[^1]");
    expect(emitted).toContain("[^1]: the definition");
    expect(countNodes(emitted, "FootnoteReference")).toBe(1);
    expect(countNodes(emitted, "FootnoteDefinition")).toBe(1);
  });

  it("preserves a non-integer footnote identifier", () => {
    const input = "Note[^alpha] here.\n\n[^alpha]: text\n";
    const emitted = assertCanonicalD1(input);
    expect(emitted).toContain("[^alpha]");
    expect(emitted).toContain("[^alpha]: text");
  });

  it("round-trips multiple references and definitions", () => {
    const input = "A[^1] and B[^2].\n\n[^1]: first\n\n[^2]: second\n";
    const emitted = assertCanonicalD1(input);
    expect(countNodes(emitted, "FootnoteReference")).toBe(2);
    expect(countNodes(emitted, "FootnoteDefinition")).toBe(2);
  });

  it("emits a reference inline within prose, not stripped to bare text", () => {
    const input = "A claim[^src] stands.\n\n[^src]: source\n";
    const emitted = assertCanonicalD1(input);
    // The `[^src]` survives as a real reference node (not collapsed to `src`).
    expect(emitted).toContain("claim[^src] stands");
  });

  it("round-trips a multi-paragraph footnote body (4-space continuation)", () => {
    const input = "[^1]: first para\n\n    second indented para\n";
    const emitted = assertCanonicalD1(input);
    // The 2nd paragraph stays INSIDE the FootnoteDefinition (not escaped).
    expect(countNodes(emitted, "FootnoteDefinition")).toBe(1);
    expect(countNodes(emitted, "Paragraph")).toBe(2);
  });
});

describe("clip serializer — highlights", () => {
  it("emits a default highlight as `==text==` and round-trips", () => {
    const input = "Some ==highlighted== text.\n";
    const emitted = assertCanonicalD1(input);
    expect(emitted).toContain("==highlighted==");
    expect(countNodes(emitted, "Highlight")).toBe(1);
  });

  it("round-trips a default highlight inside emphasis", () => {
    const input = "Bold **==hot==** word.\n";
    const emitted = assertCanonicalD1(input);
    expect(emitted).toContain("==hot==");
    expect(countNodes(emitted, "Highlight")).toBe(1);
  });

  for (const cls of HIGHLIGHT_CLASSES) {
    it(`emits a \`${cls}\` color highlight as a closed-set <mark> and round-trips`, () => {
      const input = `A <mark class="${cls}">colored</mark> word.\n`;
      const emitted = assertCanonicalD1(input);
      expect(emitted).toContain(`<mark class="${cls}">colored</mark>`);
    });
  }

  it("canonicalizes single-quoted / extra-spaced mark attributes to the closed form", () => {
    const input = "A <mark  class='hl-blue'  >x</mark> word.\n";
    const emitted = serializeClipMarkdown(input);
    expect(emitted).toContain('<mark class="hl-blue">x</mark>');
    expect(shapeOf(emitted)).toBe(shapeOf(input));
    // idempotent on the canonical form
    expect(serializeClipMarkdown(emitted)).toBe(emitted);
  });

  it("degrades an OUT-OF-SET color to a bare <mark>, never an arbitrary class", () => {
    const input = 'A <mark class="hl-chartreuse">x</mark> word.\n';
    const emitted = serializeClipMarkdown(input);
    expect(emitted).not.toContain("hl-chartreuse");
    expect(emitted).not.toContain("class=");
    expect(emitted).toContain("<mark>x</mark>");
    expect(shapeOf(emitted)).toBe(shapeOf(input));
  });

  it("degrades a multi-token class to a bare <mark> (closed-set is single-token)", () => {
    const input = 'A <mark class="hl-green hl-blue">x</mark> word.\n';
    const emitted = serializeClipMarkdown(input);
    expect(emitted).not.toContain("class=");
    expect(emitted).toContain("<mark>x</mark>");
    expect(shapeOf(emitted)).toBe(shapeOf(input));
  });

  it("drops a non-class attribute (e.g. data-*) on a mark, keeping only a closed class", () => {
    const input = 'A <mark data-x="1" class="hl-purple">x</mark> word.\n';
    const emitted = serializeClipMarkdown(input);
    expect(emitted).not.toContain("data-x");
    expect(emitted).toContain('<mark class="hl-purple">x</mark>');
    expect(shapeOf(emitted)).toBe(shapeOf(input));
  });

  it("keeps a bare <mark> bare and round-trips", () => {
    const input = "A <mark>plain</mark> word.\n";
    const emitted = serializeClipMarkdown(input);
    expect(emitted).toContain("<mark>plain</mark>");
    expect(shapeOf(emitted)).toBe(shapeOf(input));
    expect(serializeClipMarkdown(emitted)).toBe(emitted);
  });
});

describe("clip serializer — task 6 combined idempotency", () => {
  it("is idempotent across a callout + task + footnote + both highlights document", () => {
    const input = [
      "> [!note] Heads up",
      "> remember[^1] this",
      "",
      "- [ ] todo a",
      "- [x] done b",
      "",
      'Mark ==yellow== and <mark class="hl-green">green</mark>.',
      "",
      "[^1]: a footnote",
      "",
    ].join("\n");
    const emitted = assertIdempotent(input);
    expect(shapeOf(emitted)).toBe(shapeOf(input));
  });
});
