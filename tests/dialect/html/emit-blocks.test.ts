// HTML projection emitter — block constructs (MYND-255 task 1).
//
// Golden assertions per §3.1 / §3.3 block construct: headings (ATX + Setext),
// paragraphs, lists (bullet / ordered / task / nested), blockquotes, callouts,
// tables, horizontal rules, definition lists, indented code.

import { describe, expect, it } from "vitest";
import i18n from "../../../src/i18n";
import { emitNoteHtml } from "../../../src/dialect/html/emitNoteHtml";
import { CALLOUT_HTML_TYPES } from "../../../src/dialect/html/callout-types";

async function emit(src: string): Promise<string> {
  return (await emitNoteHtml(src)).html;
}

describe("headings", () => {
  it("renders ATX h1–h6", async () => {
    const html = await emit("# A\n\n## B\n\n### C\n\n#### D\n\n##### E\n\n###### F\n");
    expect(html).toContain("<h1>A</h1>");
    expect(html).toContain("<h2>B</h2>");
    expect(html).toContain("<h3>C</h3>");
    expect(html).toContain("<h4>D</h4>");
    expect(html).toContain("<h5>E</h5>");
    expect(html).toContain("<h6>F</h6>");
  });

  it("strips a trailing closing sequence and renders inline children", async () => {
    const html = await emit("## Head *em* ##\n");
    expect(html).toContain("<h2>Head <em>em</em></h2>");
  });

  it("renders Setext h1/h2", async () => {
    const html = await emit("Title\n=====\n\nSub\n-----\n");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<h2>Sub</h2>");
    expect(html).not.toContain("=====");
  });
});

describe("paragraphs", () => {
  it("wraps text in <p> and keeps soft breaks as text", async () => {
    const html = await emit("one\ntwo\n\nthree\n");
    expect(html).toContain("<p>one\ntwo</p>");
    expect(html).toContain("<p>three</p>");
  });

  it("escapes HTML-significant text", async () => {
    const html = await emit("a < b & c > d\n");
    expect(html).toContain("<p>a &lt; b &amp; c &gt; d</p>");
  });
});

describe("lists", () => {
  it("renders bullet lists incl. nesting", async () => {
    const html = await emit("- a\n- b\n  - nested\n");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>a</li>");
    expect(html).toMatch(/<li>b\n<ul>\n<li>nested<\/li>\n<\/ul><\/li>/);
  });

  it("renders ordered lists with a non-1 start", async () => {
    const html = await emit("3. a\n4. b\n");
    expect(html).toContain('<ol start="3">');
    expect(html).toContain("<li>a</li>");
  });

  it("omits start for 1-based and accepts the `1)` form", async () => {
    expect(await emit("1. a\n")).toContain("<ol>");
    expect(await emit("1) a\n")).toContain("<ol>");
  });

  it("wraps multi-paragraph (loose) items in <p>", async () => {
    const html = await emit("- a\n\n  second para\n");
    expect(html).toContain("<li><p>a</p>\n<p>second para</p></li>");
  });

  it("renders task lists with unicode checkbox glyphs", async () => {
    const html = await emit("- [ ] open\n- [x] done\n- [X] also done\n");
    expect(html).toContain(
      '<li class="task-list-item" data-checked="false"><span class="task-checkbox" aria-hidden="true">☐</span> open</li>',
    );
    expect(html).toContain(
      '<li class="task-list-item" data-checked="true"><span class="task-checkbox" aria-hidden="true">☑</span> done</li>',
    );
    expect(html).toContain("☑</span> also done");
  });
});

describe("blockquotes + callouts", () => {
  it("renders a plain blockquote", async () => {
    const html = await emit("> quoted text\n");
    expect(html).toContain("<blockquote>\n<p>quoted text</p>\n</blockquote>");
  });

  it("renders nested blockquotes", async () => {
    const html = await emit("> outer\n> > inner\n");
    expect(html).toMatch(
      /<blockquote>\n<p>outer<\/p>\n<blockquote>\n<p>inner<\/p>\n<\/blockquote>\n<\/blockquote>/,
    );
  });

  it("promotes a known callout type to a typed container with classes only", async () => {
    const html = await emit("> [!note]\n> body text\n");
    expect(html).toContain(
      '<div class="callout callout-note callout-tone-accent">',
    );
    expect(html).toContain('<p class="callout-title">Note</p>');
    expect(html).toContain("<p>body text</p>");
    expect(html).not.toContain("[!note]");
    expect(html).not.toContain("style="); // colors come from print CSS, not inline
  });

  it("uses the custom title when present (case-insensitive type)", async () => {
    const html = await emit("> [!WARNING] Mind the gap\n> body\n");
    expect(html).toContain(
      '<div class="callout callout-warning callout-tone-warning">',
    );
    expect(html).toContain('<p class="callout-title">Mind the gap</p>');
  });

  it("maps every Obsidian callout type to its tone class", async () => {
    for (const [type, def] of Object.entries(CALLOUT_HTML_TYPES)) {
      const html = await emit(`> [!${type}]\n> x\n`);
      expect(html).toContain(
        `<div class="callout callout-${type} callout-tone-${def.tone}">`,
      );
      expect(html).toContain(
        `<p class="callout-title">${i18n.t(def.labelKey)}</p>`,
      );
    }
  });

  it("leaves an unknown type as a plain blockquote", async () => {
    const html = await emit("> [!florble] nope\n> body\n");
    expect(html).toContain("<blockquote>");
    expect(html).not.toContain("callout");
    expect(html).toContain("[!florble]");
  });

  it("renders the fold marker form without leaking the marker", async () => {
    const html = await emit("> [!tip]- Folded\n> body\n");
    expect(html).toContain('<p class="callout-title">Folded</p>');
    expect(html).not.toContain("]-");
  });
});

describe("tables", () => {
  it("renders thead/tbody with per-column alignment", async () => {
    const html = await emit(
      "| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n",
    );
    expect(html).toContain("<table>");
    expect(html).toContain(
      '<thead><tr><th style="text-align:left">a</th><th style="text-align:center">b</th><th style="text-align:right">c</th></tr></thead>',
    );
    expect(html).toContain(
      '<tbody><tr><td style="text-align:left">1</td><td style="text-align:center">2</td><td style="text-align:right">3</td></tr></tbody>',
    );
  });

  it("renders unaligned columns without a style attribute", async () => {
    const html = await emit("| a |\n|---|\n| 1 |\n");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>1</td>");
  });

  it("renders inline markup inside cells", async () => {
    const html = await emit("| **b** |\n|---|\n| `c` |\n");
    expect(html).toContain("<th><strong>b</strong></th>");
    expect(html).toContain("<td><code>c</code></td>");
  });
});

describe("horizontal rules", () => {
  it("renders --- / *** / ___ as <hr>", async () => {
    const html = await emit("a\n\n---\n\nb\n\n***\n\nc\n\n___\n");
    expect(html.match(/<hr>/g)).toHaveLength(3);
  });
});

describe("definition lists (tight subset)", () => {
  it("renders term + definitions as dl/dt/dd", async () => {
    const html = await emit("Term\n: def one\n: def two\n");
    expect(html).toContain("<dl>");
    expect(html).toContain("<dt>Term</dt>");
    expect(html).toContain("<dd>def one</dd>");
    expect(html).toContain("<dd>def two</dd>");
  });

  it("leaves the loose form as paragraphs (not in the subset)", async () => {
    const html = await emit("Term\n\n: not a definition\n");
    expect(html).not.toContain("<dl>");
    expect(html).toContain("<p>Term</p>");
  });
});

describe("indented code blocks", () => {
  it("renders as an escaped code card (recognized, never emitted form)", async () => {
    const html = await emit("para\n\n    indented <code>\n");
    expect(html).toContain(
      '<pre class="code-card"><code>indented &lt;code&gt;</code></pre>',
    );
  });
});
