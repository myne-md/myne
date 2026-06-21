// Clip serializer — task 4 (capture-extraction): the fidelity-floor code
// constructs (§5 "Code block: Fenced — indented form recognized for round-trip
// but never emitted"; PRD fidelity floor = faithful tables/code/math).
//
// A `FencedCode` node re-emits as a fenced block with its language info string
// preserved VERBATIM and the code text BYTE-EXACT (no escaping, no whitespace
// normalization of the code body). An indented `CodeBlock` is recognized on
// parse but NORMALIZED to fenced form on emit (§5). The fence length is chosen
// degrade-safe: longer than the longest backtick run inside the body, so code
// containing ``` ``` ``` re-parses as one block (no premature close). Inline
// `InlineCode` emits the canonical backtick span — a longer backtick run + a
// space pad (CommonMark canonical) when the content itself contains backticks.
//
// Round-trip target is the canonical equivalent: an already-fenced block holds
// `assertCanonicalD1`; an indented block normalizes to fenced (asserted via the
// rig's lower-level `shapeOf` + `serializeClipMarkdown`, since the source shape
// is `CodeBlock` and the emit shape is `FencedCode` — a deliberate normalize).

import { describe, expect, it } from "vitest";
import { parser } from "../../../src/dialect/lezer/parser";
import { serializeClipMarkdown } from "../../../src/dialect/clip";
import { assertCanonicalD1, assertIdempotent, shapeOf } from "./_rig";

/** Extract the single (or joined) `CodeText` body of the first block's code
 *  node, so a test can assert byte-exactness against the original code. */
function fencedBody(emitted: string): string {
  const tree = parser.parse(emitted);
  const fc = tree.topNode.getChild("FencedCode");
  if (fc === null) throw new Error("expected a FencedCode block");
  const text = fc.getChild("CodeText");
  return text === null ? "" : emitted.slice(text.from, text.to);
}

/** The info string (language hint) of the first FencedCode block, or "". */
function fencedInfo(emitted: string): string {
  const tree = parser.parse(emitted);
  const fc = tree.topNode.getChild("FencedCode");
  if (fc === null) throw new Error("expected a FencedCode block");
  const info = fc.getChild("CodeInfo");
  return info === null ? "" : emitted.slice(info.from, info.to);
}

describe("clip serializer — fenced code blocks", () => {
  it("round-trips a fenced block with its language hint and verbatim code text", () => {
    const input = ["```ts", "const x = 1;", "let y = x + 2;", "```", ""].join("\n");
    const emitted = assertCanonicalD1(input);
    expect(emitted).toBe(["```ts", "const x = 1;", "let y = x + 2;", "```"].join("\n"));
    expect(fencedInfo(emitted)).toBe("ts");
    expect(fencedBody(emitted)).toBe("const x = 1;\nlet y = x + 2;");
  });

  it("preserves the info string verbatim (extra tokens past the language)", () => {
    const input = ['```ts title="foo.ts"', "x", "```", ""].join("\n");
    const emitted = serializeClipMarkdown(input);
    expect(fencedInfo(emitted)).toBe('ts title="foo.ts"');
    expect(shapeOf(emitted)).toBe(shapeOf(input));
  });

  it("emits a fenced block with no language hint when none was present", () => {
    const input = ["```", "plain code", "```", ""].join("\n");
    const emitted = assertCanonicalD1(input);
    expect(emitted).toBe(["```", "plain code", "```"].join("\n"));
    expect(fencedInfo(emitted)).toBe("");
    expect(fencedBody(emitted)).toBe("plain code");
  });

  it("preserves the code body byte-exact (leading/inner whitespace untouched)", () => {
    // Significant indentation + a blank interior line must survive verbatim.
    const body = "def f():\n    if True:\n\n        return 1";
    const input = "```python\n" + body + "\n```\n";
    const emitted = serializeClipMarkdown(input);
    expect(fencedBody(emitted)).toBe(body);
    expect(shapeOf(emitted)).toBe(shapeOf(input));
  });

  it("emits an empty fenced block for empty code", () => {
    const input = ["```", "```", ""].join("\n");
    const emitted = serializeClipMarkdown(input);
    expect(emitted).toBe(["```", "```"].join("\n"));
    expect(shapeOf(emitted)).toBe(shapeOf(input));
  });

  it("normalizes a `~~~`-fenced block to a ```-fenced block", () => {
    const input = ["~~~", "tilde fenced", "~~~", ""].join("\n");
    const emitted = serializeClipMarkdown(input);
    expect(emitted).toBe(["```", "tilde fenced", "```"].join("\n"));
    expect(fencedBody(emitted)).toBe("tilde fenced");
  });

  it("is idempotent through fenced-code emission", () => {
    const input = ["```rust", "fn main() {}", "```", ""].join("\n");
    const emitted = assertIdempotent(input);
    expect(emitted).toBe(["```rust", "fn main() {}", "```"].join("\n"));
  });
});

describe("clip serializer — indented code normalizes to fenced", () => {
  it("normalizes an indented code block to a fenced block on emit", () => {
    const input = ["    line A", "    line B", ""].join("\n");
    const emitted = serializeClipMarkdown(input);
    expect(emitted).toBe(["```", "line A", "line B", "```"].join("\n"));
    // The source parses as CodeBlock; the emit parses as FencedCode — a
    // deliberate §5 normalize (indented recognized, never emitted).
    expect(shapeOf(input)).toContain("CodeBlock");
    expect(shapeOf(emitted)).toContain("FencedCode");
  });

  it("de-indents and preserves deeper-than-4-space indentation byte-exact", () => {
    const input = ["    outer", "      inner more indented", ""].join("\n");
    const emitted = serializeClipMarkdown(input);
    // 4-space code indent stripped; the extra 2 spaces of `inner` are body.
    expect(fencedBody(emitted)).toBe("outer\n  inner more indented");
  });

  it("re-parses the normalized indented block as one fenced code block", () => {
    const input = ["    a()", "    b()", ""].join("\n");
    const emitted = serializeClipMarkdown(input);
    const tree = parser.parse(emitted);
    expect(tree.topNode.getChild("FencedCode")).not.toBeNull();
    expect(fencedBody(emitted)).toBe("a()\nb()");
  });
});

describe("clip serializer — degrade-safe fencing vs inner backtick runs", () => {
  it("uses a 4-backtick fence when the code contains a ``` run", () => {
    const body = "here is a triple ``` inside the code";
    const input = "````\n" + body + "\n````\n";
    const emitted = serializeClipMarkdown(input);
    // The fence must be longer than the longest inner backtick run (3) → 4.
    expect(emitted.startsWith("````")).toBe(true);
    expect(emitted).toBe("````\n" + body + "\n````");
    // It re-parses as ONE fenced block (no premature close at the inner ```).
    const tree = parser.parse(emitted);
    const fc = tree.topNode.getChild("FencedCode");
    expect(fc).not.toBeNull();
    expect(fencedBody(emitted)).toBe(body);
  });

  it("escalates the fence length past the longest inner run (a 4-run → 5 fence)", () => {
    const body = "four ```` then text";
    const input = "`````\n" + body + "\n`````\n";
    const emitted = serializeClipMarkdown(input);
    expect(emitted.startsWith("`````")).toBe(true);
    expect(fencedBody(emitted)).toBe(body);
    expect(shapeOf(emitted)).toBe(shapeOf(input));
  });

  it("keeps the minimal 3-backtick fence when no run is long enough to collide", () => {
    const body = "single ` and double `` but no triple";
    const input = "```\n" + body + "\n```\n";
    const emitted = serializeClipMarkdown(input);
    expect(emitted).toBe("```\n" + body + "\n```");
    expect(fencedBody(emitted)).toBe(body);
  });

  it("re-fences a captured block whose body would collide with its source fence", () => {
    // A 3-backtick block whose body somehow carries a ``` run (degrade input):
    // emit must pick a 4+ fence so it round-trips as one block, not two.
    const input = "```text\ncontains ``` triple\n```\n";
    const emitted = serializeClipMarkdown(input);
    const tree = parser.parse(emitted);
    const fc = tree.topNode.getChild("FencedCode");
    expect(fc).not.toBeNull();
    // Body survives byte-exact and the info string is preserved.
    expect(fencedBody(emitted)).toBe("contains ``` triple");
    expect(fencedInfo(emitted)).toBe("text");
  });
});

describe("clip serializer — inline code spans", () => {
  /** The LOGICAL text content of the first InlineCode in a paragraph: the
   *  mark-to-mark window with the CommonMark single-space pad stripped (a code
   *  span surrounded by — but not entirely composed of — spaces drops one
   *  leading and one trailing space). */
  function inlineCodeText(emitted: string): string {
    const tree = parser.parse(emitted);
    let found: string | null = null;
    tree.topNode.cursor().iterate((node) => {
      if (node.name === "InlineCode" && found === null) {
        const marks = node.node.getChildren("CodeMark");
        const from = marks[0] !== undefined ? marks[0].to : node.from;
        const last = marks[marks.length - 1];
        const to = last !== undefined && last.from > from ? last.from : node.to;
        let raw = emitted.slice(from, to);
        if (raw.length >= 2 && raw.startsWith(" ") && raw.endsWith(" ") && raw.trim() !== "") {
          raw = raw.slice(1, -1);
        }
        found = raw;
        return false;
      }
      return undefined;
    });
    if (found === null) throw new Error("expected an InlineCode node");
    return found;
  }

  it("emits inline code canonically and round-trips", () => {
    const input = "Use `npm install` to begin.\n";
    const emitted = assertCanonicalD1(input);
    expect(emitted).toContain("`npm install`");
    expect(inlineCodeText(emitted)).toBe("npm install");
  });

  it("uses a longer backtick run + space pad when the content contains a backtick", () => {
    const input = "The span ``a ` b`` holds a backtick.\n";
    const emitted = serializeClipMarkdown(input);
    // CommonMark canonical: a content backtick forces a 2-backtick delimiter
    // and a single-space pad on each side so the inner ` is not a delimiter.
    expect(emitted).toContain("`` a ` b ``");
    expect(inlineCodeText(emitted)).toBe("a ` b");
    expect(shapeOf(emitted)).toBe(shapeOf(input));
  });

  it("escalates the delimiter past the longest inner backtick run", () => {
    const input = "Edge ```a `` b``` case.\n";
    const emitted = serializeClipMarkdown(input);
    // Inner run is 2 backticks → delimiter must be 3, space-padded.
    expect(emitted).toContain("``` a `` b ```");
    expect(inlineCodeText(emitted)).toBe("a `` b");
    expect(shapeOf(emitted)).toBe(shapeOf(input));
  });

  it("preserves the inline-code content byte-exact (no whitespace collapse)", () => {
    // Inline code is a code zone: internal double spaces are content, not
    // collapsible paragraph whitespace.
    const input = "Spaces `a  b   c` stay.\n";
    const emitted = serializeClipMarkdown(input);
    expect(inlineCodeText(emitted)).toBe("a  b   c");
  });

  it("is idempotent through inline-code emission", () => {
    const input = "Call `fn()` then ``x ` y`` here.\n";
    const emitted = assertIdempotent(input);
    expect(emitted).toContain("`fn()`");
    expect(emitted).toContain("`` x ` y ``");
  });
});
