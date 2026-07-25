// @vitest-environment jsdom
//
// HTML→markdown converter (MYND-580) — per-construct emit + the two invariants.
//
// jsdom is required: the converter uses `DOMParser` and DOMPurify, both of which
// need a window.

import { describe, expect, it, afterEach } from "vitest";
import {
  MarkupParseError,
  htmlToMarkdown,
  parseMarkup,
} from "../../../src/notes/import/html";

async function md(html: string): Promise<string> {
  return (await htmlToMarkdown(html)).markdown;
}
async function lossyOf(html: string): Promise<readonly string[]> {
  return (await htmlToMarkdown(html)).lossy;
}

describe("block constructs", () => {
  it("converts headings h1–h6", async () => {
    expect(await md("<h1>One</h1>")).toBe("# One");
    expect(await md("<h3>Three</h3>")).toBe("### Three");
    expect(await md("<h6>Six</h6>")).toBe("###### Six");
  });

  it("converts paragraphs and separates blocks with a blank line", async () => {
    expect(await md("<p>first</p><p>second</p>")).toBe("first\n\nsecond");
  });

  it("converts an unordered list", async () => {
    expect(await md("<ul><li>a</li><li>b</li></ul>")).toBe("- a\n- b");
  });

  it("converts an ordered list with incrementing markers", async () => {
    expect(await md("<ol><li>a</li><li>b</li><li>c</li></ol>")).toBe("1. a\n2. b\n3. c");
  });

  it("indents a nested list by two spaces per level", async () => {
    const out = await md("<ul><li>top<ul><li>mid<ul><li>deep</li></ul></li></ul></li></ul>");
    expect(out).toBe("- top\n  - mid\n    - deep");
  });

  it("converts a blockquote", async () => {
    expect(await md("<blockquote><p>quoted</p></blockquote>")).toBe("> quoted");
  });

  it("converts a pre block to a fence, verbatim", async () => {
    const out = await md("<pre>let x = 1;\nlet y = *2*;</pre>");
    expect(out).toBe("```\nlet x = 1;\nlet y = *2*;\n```");
  });

  it("converts hr", async () => {
    expect(await md("<p>a</p><hr><p>b</p>")).toBe("a\n\n---\n\nb");
  });

  it("treats div/section/article as transparent", async () => {
    expect(await md("<div><section><p>deep</p></section></div>")).toBe("deep");
  });
});

describe("tables", () => {
  it("converts a th-headed table to a GFM pipe table", async () => {
    const out = await md(
      "<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
    );
    expect(out).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |");
  });

  it("synthesizes a header row for a header-less table", async () => {
    // A pipe table with no delimiter row does not parse as a table at all, so the
    // first data row is promoted rather than emitting something inert.
    const out = await md("<table><tr><td>x</td><td>y</td></tr><tr><td>z</td><td>w</td></tr></table>");
    expect(out).toBe("| x | y |\n| --- | --- |\n| z | w |");
  });

  it("pads a short row so the pipe grid stays rectangular", async () => {
    const out = await md("<table><tr><th>A</th><th>B</th></tr><tr><td>1</td></tr></table>");
    expect(out).toBe("| A | B |\n| --- | --- |\n| 1 |  |");
  });

  it("escapes a pipe inside a cell", async () => {
    const out = await md("<table><tr><th>a|b</th></tr><tr><td>c</td></tr></table>");
    expect(out).toContain("a\\|b");
  });
});

describe("inline constructs", () => {
  it("converts strong/em/del", async () => {
    expect(await md("<p><strong>b</strong> <em>i</em> <del>d</del></p>")).toBe(
      "**b** *i* ~~d~~",
    );
  });

  it("treats b/i/s as their semantic equivalents", async () => {
    expect(await md("<p><b>b</b> <i>i</i> <s>s</s></p>")).toBe("**b** *i* ~~s~~");
  });

  it("converts inline code verbatim without markdown escaping", async () => {
    expect(await md("<p>use <code>a_b_c *x*</code> here</p>")).toBe(
      "use `a_b_c *x*` here",
    );
  });

  it("converts a link", async () => {
    expect(await md('<p><a href="https://e.test/x">text</a></p>')).toBe(
      "[text](https://e.test/x)",
    );
  });

  it("keeps a relative link (Notion internal-link shape)", async () => {
    expect(await md('<p><a href="Page%20Title%201a2b.md">Child</a></p>')).toBe(
      "[Child](Page%20Title%201a2b.md)",
    );
  });

  it("converts an image with alt", async () => {
    expect(await md('<p><img src="img/a.png" alt="cap"></p>')).toBe("![cap](img/a.png)");
  });

  it("converts mark to the highlight form", async () => {
    expect(await md("<p><mark>hl</mark></p>")).toBe("==hl==");
  });

  it("converts br to a hard break", async () => {
    expect(await md("<p>a<br>b</p>")).toBe("a  \nb");
  });

  it("escapes markdown-significant characters in text", async () => {
    expect(await md("<p>2 * 3 _x_ [y]</p>")).toBe("2 \\* 3 \\_x\\_ \\[y\\]");
  });
});

describe("lossy reporting — never silent", () => {
  it("reports an unsafe URL scheme and keeps the link text", async () => {
    const r = await htmlToMarkdown('<p><a href="javascript:alert(1)">click</a></p>');
    // The sanitizer already stripped the attribute, so the walker sees a bare <a>
    // and emits its text. Either way the URL never reaches the note.
    expect(r.markdown).toBe("click");
    expect(r.markdown).not.toContain("javascript");
  });

  it("reports underline, which has no dialect form", async () => {
    const r = await htmlToMarkdown("<p><u>under</u></p>");
    expect(r.lossy).toContain("underline");
    expect(r.markdown).toBe("under");
  });

  it("returns an empty lossy list for fully representable markup", async () => {
    expect(await lossyOf("<h1>t</h1><p><strong>b</strong></p><ul><li>a</li></ul>")).toEqual(
      [],
    );
  });

  it("de-duplicates and sorts the lossy list", async () => {
    const r = await htmlToMarkdown("<p><u>a</u></p><p><u>b</u></p>");
    expect(r.lossy).toEqual(["underline"]);
  });
});

describe("XML / ENML parsing", () => {
  it("parses a well-formed ENML-shaped document", () => {
    const doc = parseMarkup(
      '<?xml version="1.0"?><en-note><div>body</div></en-note>',
      "xml",
    );
    expect(doc.documentElement.tagName).toBe("en-note");
  });

  it("throws MarkupParseError on malformed XML rather than importing garbage", () => {
    expect(() => parseMarkup("<en-note><unclosed></en-note>", "xml")).toThrow(
      MarkupParseError,
    );
  });

  it("does not fetch or resolve the .enex external DTD", () => {
    // Every real .enex carries this doctype. If it were resolved it would be both a
    // remote fetch (breaking the no-remote-fetch anti-feature) and an XXE vector.
    // DOMParser loads no external DTD, so the document parses with the entity
    // simply undefined — no network, no file read.
    const doc = parseMarkup(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export3.dtd">' +
        "<en-export><note><title>t</title></note></en-export>",
      "xml",
    );
    expect(doc.querySelector("title")?.textContent).toBe("t");
  });

  it("does not expand a declared external entity", () => {
    const doc = parseMarkup(
      '<?xml version="1.0"?>' +
        '<!DOCTYPE r [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
        "<r>safe</r>",
      "xml",
    );
    expect(doc.documentElement.textContent).toBe("safe");
    expect(doc.documentElement.textContent).not.toContain("root:");
  });
});

describe("regressions caught by the /simplify review", () => {
  it("preserves blank lines inside a code fence", async () => {
    // A global `\n{3,}` → `\n\n` cleanup pass used to run over the joined output,
    // which reached INSIDE a fence and silently deleted the user's blank lines.
    const out = await md("<pre>a\n\n\nb</pre>");
    expect(out).toBe("```\na\n\n\nb\n```");
  });

  it("coalesces inline runs inside a blockquote, not just a transparent div", async () => {
    // The first fix only covered transparent containers, so a blockquote of mixed
    // inline content still shredded into one block per run.
    expect(await md("<blockquote>text <b>bold</b> tail</blockquote>")).toBe(
      "> text **bold** tail",
    );
  });

  it("coalesces inline runs inside an off-allowlist block", async () => {
    const r = await htmlToMarkdown("<fieldset>a <b>b</b> c</fieldset>");
    expect(r.markdown).toBe("a **b** c");
    // KNOWN GAP, pinned deliberately: an off-allowlist element is removed by the
    // SANITIZER before the walker sees it, so it is NOT reported through `lossy`.
    // The walker's own lossy channel therefore covers only allowlisted-but-
    // unhandled constructs. Closing this needs DOMPurify's `removed` array to feed
    // the channel — deferred to the import-report consumer (MYND-585), where the
    // report is actually rendered. See the note in the PRD.
    expect(r.lossy).toEqual([]);
  });

  it.each([
    "javascript:alert(1)",
    "java\nscript:alert(1)",
    "java\tscript:alert(1)",
    "jav ascript:alert(1)",
    "data:text/html,x",
  ])("never emits an obfuscated unsafe scheme: %j", async (href) => {
    // DOMPurify strips these upstream, so this pins the WALKER's own backstop:
    // whitespace and control characters inside a scheme must not smuggle it past
    // the check. Asserted on the walker directly, since the sanitizer would
    // otherwise mask a regression here.
    const { domToMarkdown } = await import(
      "../../../src/notes/import/html/toMarkdown"
    );
    const doc = parseMarkup("<p></p>", "html");
    const a = doc.createElement("a");
    a.setAttribute("href", href);
    a.textContent = "text";
    const p = doc.createElement("p");
    p.appendChild(a);
    const { markdown } = domToMarkdown(p);
    expect(markdown).toBe("text"); // link dropped, text kept
    expect(markdown.toLowerCase()).not.toContain("script");
    expect(markdown.toLowerCase()).not.toContain("data:");
  });

  it("emits a destination that survives re-parsing when the URL has spaces", async () => {
    // `[x](my file.html)` is not a link; the canonical formatter wraps it.
    expect(await md('<p><a href="my file.html">x</a></p>')).toBe("[x](<my file.html>)");
  });
});

describe("markdown-structure injection (adversarial battery, MYND-580 review)", () => {
  // Untrusted HTML must not be able to inject markdown STRUCTURE into the note.
  // The sanitizer stops script/handler vectors; these are the ones that survive
  // sanitization as legitimate text and attack the markdown layer instead.

  it("contains a code fence that carries its own backticks", async () => {
    // A fixed ``` fence would let the content close it and inject real markdown —
    // headings, links, even ![[att:<id>]] attachment refs.
    const out = await md("<pre>```\n\n# INJECTED\n\n```</pre>");
    const lines = out.split("\n");
    const opener = lines[0]!;
    expect(opener).toBe("````");
    expect(lines.at(-1)).toBe("````");
    // The heading is still PRESENT (nothing was destroyed) but stays enclosed:
    // no interior line is a fence long enough to close the opener, so everything
    // between the delimiters is code, not markdown structure.
    expect(out).toContain("# INJECTED");
    const interior = lines.slice(1, -1);
    expect(interior.some((l) => /^`{4,}\s*$/.test(l))).toBe(false);
  });

  it("widens the fence past the longest internal backtick run", async () => {
    const out = await md("<pre>a ```` b</pre>");
    expect(out.startsWith("`````")).toBe(true);
  });

  it("escapes a leading ATX heading marker in paragraph text", async () => {
    expect(await md("<p># not a heading</p>")).toBe("\\# not a heading");
  });

  it("preserves an inline tag, which is not a heading marker", async () => {
    // `#tag` (no space) is the dialect's inline-tag form (§3.7) — must survive.
    expect(await md("<p>#tag stays</p>")).toBe("#tag stays");
  });

  it.each([
    ["- item", "\\- item"],
    ["+ item", "\\+ item"],
    ["1. item", "1\\. item"],
    ["---", "\\---"],
  ])("escapes a leading block marker %j", async (input, expected) => {
    expect(await md(`<p>${input}</p>`)).toBe(expected);
  });

  it("escapes brackets so a link cannot be forged from text", async () => {
    const out = await md('<a href="https://ok.test">te]xt(evil)</a>');
    expect(out).toBe("[te\\]xt(evil)](https://ok.test)");
  });

  it("escapes a forged attachment wikilink in text", async () => {
    const out = await md("<p>[[att:deadbeef|evil.png]]</p>");
    expect(out).not.toContain("[[att:");
  });

  it("rejects a scheme obfuscated past scheme-detection (fails closed)", async () => {
    // A NUL becomes U+FFFD during HTML parsing, which is not a control character —
    // the earlier "no scheme → allow" default let this through into note text.
    const out = await md('<a href="jav ascript:alert(1)">l</a>');
    expect(out).toBe("l");
    expect(out).not.toContain("ascript:");
  });
});

describe("INVARIANT — nothing is attached to the live DOM", () => {
  const originalChildCount = document.body.childNodes.length;

  afterEach(() => {
    expect(document.body.childNodes.length).toBe(originalChildCount);
  });

  it("leaves document.body untouched across a conversion", async () => {
    const before = document.body.innerHTML;
    await htmlToMarkdown(
      '<h1>t</h1><p><a href="https://e.test">l</a></p><table><tr><td>c</td></tr></table>',
    );
    expect(document.body.innerHTML).toBe(before);
  });

  it("does not adopt nodes even when the markup contains removed elements", async () => {
    const before = document.body.innerHTML;
    await htmlToMarkdown('<script>x()</script><iframe src="https://e.test"></iframe><p>t</p>');
    expect(document.body.innerHTML).toBe(before);
  });

  it("parseMarkup produces a document detached from the live one", () => {
    const doc = parseMarkup("<p>x</p>", "html");
    expect(doc).not.toBe(document);
    expect(document.contains(doc.body)).toBe(false);
  });
});
