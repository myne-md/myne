// HTML projection emitter — inline constructs (MYND-255 task 1).
//
// Golden assertions per §3.2 / §3.3 / §3.5 / §3.7 inline construct: emphasis
// family, inline code, links (inline / reference / autolink), hard breaks,
// escapes, entities, wikilinks, inline typography, emoji shortcodes, inline
// tags (SYNC-17 plain text), and the escape-by-default posture for raw HTML.

import { describe, expect, it } from "vitest";
import { emitNoteHtml } from "../../../src/dialect/html/emitNoteHtml";

async function emit(src: string): Promise<string> {
  return (await emitNoteHtml(src)).html;
}

describe("emphasis family", () => {
  it("renders em / strong / strikethrough (both delimiter families)", async () => {
    const html = await emit("*i* _i2_ **b** __b2__ ~~s~~\n");
    expect(html).toContain("<em>i</em>");
    expect(html).toContain("<em>i2</em>");
    expect(html).toContain("<strong>b</strong>");
    expect(html).toContain("<strong>b2</strong>");
    expect(html).toContain("<del>s</del>");
  });

  it("nests inline markup", async () => {
    const html = await emit("**bold *and italic***\n");
    expect(html).toContain("<strong>bold <em>and italic</em></strong>");
  });
});

describe("inline code", () => {
  it("escapes the code body and drops the backticks", async () => {
    const html = await emit("`a < b & c`\n");
    expect(html).toContain("<code>a &lt; b &amp; c</code>");
  });

  it("keeps markdown inert inside code", async () => {
    const html = await emit("`**not bold**`\n");
    expect(html).toContain("<code>**not bold**</code>");
  });
});

describe("hard breaks + escapes + entities", () => {
  it("renders both hard-break forms as <br>", async () => {
    const html = await emit("one  \ntwo\\\nthree\n");
    expect(html.match(/<br>/g)).toHaveLength(2);
  });

  it("renders the escaped character for backslash escapes", async () => {
    const html = await emit("a\\*b and \\#notag and \\\\\n");
    expect(html).toContain("a*b");
    expect(html).toContain("#notag");
    expect(html).toContain("\\");
    expect(html).not.toContain("\\*");
  });

  it("passes HTML entities through", async () => {
    const html = await emit("x &amp; y &copy;\n");
    expect(html).toContain("&amp;");
    expect(html).toContain("&copy;");
  });
});

describe("links", () => {
  it("strips a CommonMark angle-bracketed destination `[t](<url>)` to a clean href", async () => {
    const html = await emit("[label](<https://a.example>)\n");
    // Without stripping the `<>` the URL reads as non-scheme → relative → the
    // href is emitted as a broken `&lt;https://a.example&gt;`.
    expect(html).toContain('<a href="https://a.example">label</a>');
    expect(html).not.toContain("&lt;https");
  });

  it("renders inline links with optional title", async () => {
    const html = await emit('[text](https://example.com "Hi")\n');
    expect(html).toContain(
      '<a href="https://example.com" title="Hi">text</a>',
    );
  });

  it("resolves reference links (full / collapsed / shortcut) by CommonMark rules", async () => {
    const html = await emit(
      "[full][Ref One]\n\n[Ref One][]\n\n[ref one]\n\n[ref   ONE]: https://r.example\n",
    );
    expect(html.match(/href="https:\/\/r\.example"/g)).toHaveLength(3);
    expect(html).toContain(">full</a>");
    // The definition line itself never renders.
    expect(html).not.toContain("[ref   ONE]:");
  });

  it("leaves a dangling reference as literal text", async () => {
    const html = await emit("[nope][missing]\n");
    expect(html).toContain("[nope][missing]");
    expect(html).not.toContain("<a ");
  });

  it("renders angle autolinks and bare GFM autolinks", async () => {
    const html = await emit("<https://a.example>\n\nbare https://b.example ok\n");
    expect(html).toContain('<a href="https://a.example">https://a.example</a>');
    expect(html).toContain('<a href="https://b.example">https://b.example</a>');
  });

  it("prefixes scheme-less www autolinks", async () => {
    const html = await emit("visit www.example.com now\n");
    expect(html).toContain('<a href="http://www.example.com">www.example.com</a>');
  });

  it("refuses unsafe link schemes (renders plain text)", async () => {
    const html = await emit("[x](javascript:alert(1))\n");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("x");
  });

  // A filter that strips only a LEADING C0 run tests a different string from
  // the one emitted: the WHATWG URL parser removes ASCII tab, LF and CR from
  // ANY position before resolving, so `jav<TAB>ascript:` is a `javascript:` URL
  // to the browser while looking scheme-less to an anchored `^[a-z]+:` probe.
  // The angle-bracket destination is the construct that admits the tab at all
  // (the bare form breaks on it as whitespace), which is why every payload here
  // uses `<...>`.
  //
  // The reference-definition payload is the same parser, so it is the vector
  // that survives a reader who "fixes" only the inline form.
  it("refuses a scheme obfuscated with an interior tab", async () => {
    const payloads = [
      "[x](<jav\tascript:alert(1)>)",
      "[x](</\t/evil.example>)",
      "[x][r]\n\n[r]: <jav\tascript:alert(1)>\n",
    ];
    for (const payload of payloads) {
      const html = await emit(payload);
      expect(html, `payload: ${JSON.stringify(payload)}`).not.toContain("<a ");
    }
  });

  // The other half of the fix. Normalising only the PROBE and still emitting the
  // original string would leave the checked value and the emitted value
  // different, which is the defect class itself, and every payload in the case
  // above is a REFUSAL, so a suite made only of them passes either way. This
  // asserts the ACCEPT path emits the normalised value: a legitimate
  // destination that carries a control character, where the parser does hand a
  // link node to `safeHref`. Reverting either `return probe` turns this red.
  //
  // Every payload is measured to reach `safeHref` rather than assumed to. A
  // trailing newline changes how the GFM autolink extension splits a tab inside
  // a destination, so the newline-free forms are the ones that survive, and
  // adding one here silently converts the case back into a vacuous pass.
  it("emits the normalised href, not the original string", async () => {
    const accept: [string, string][] = [
      ["[x](<https://a.exa\tmple/p>)", '<a href="https://a.example/p">'],
      ["[x](<\thttps://a.example/p>)", '<a href="https://a.example/p">'],
      ["[x](<\t/a.example/p>)", '<a href="/a.example/p">'],
    ];
    for (const [src, expected] of accept) {
      const html = await emit(src);
      expect(html, `payload: ${JSON.stringify(src)}`).toContain(expected);
    }
  });
});

describe("wikilinks (§3.5)", () => {
  it("renders the target as a plain styled span with no href", async () => {
    const html = await emit("[[Some Note]]\n");
    expect(html).toContain('<span class="wikilink">Some Note</span>');
    expect(html).not.toContain("<a ");
  });

  it("renders the alias when present", async () => {
    const html = await emit("[[Some Note|Display]]\n");
    expect(html).toContain('<span class="wikilink">Display</span>');
    expect(html).not.toContain("Some Note");
  });

  it("renders heading anchors in the display text", async () => {
    const html = await emit("[[Note#Section]]\n");
    expect(html).toContain('<span class="wikilink">Note#Section</span>');
  });

  it("renders a non-attachment embed as a quiet placeholder", async () => {
    const html = await emit("![[Other Note]]\n");
    expect(html).toContain('<span class="embed-placeholder">Other Note</span>');
  });
});

describe("markdown images", () => {
  it("never fetches — projects a placeholder with the alt text", async () => {
    const html = await emit("![my alt](https://example.com/pic.png)\n");
    expect(html).toContain('<span class="embed-placeholder">my alt</span>');
    expect(html).not.toContain("<img");
  });
});

describe("inline typography (MYND-156)", () => {
  it("renders ==highlight== as <mark>", async () => {
    const html = await emit("==important==\n");
    expect(html).toContain('<mark class="highlight">important</mark>');
  });

  it("renders ~sub~ and ^sup^", async () => {
    const html = await emit("H~2~O and x^2^\n");
    expect(html).toContain("H<sub>2</sub>O");
    expect(html).toContain("x<sup>2</sup>");
  });

  it("maps known emoji shortcodes to glyphs (lazy map)", async () => {
    const html = await emit("ship it :rocket:\n");
    expect(html).toContain("🚀");
    expect(html).not.toContain(":rocket:");
  });

  it("leaves unmapped shortcodes literal", async () => {
    const html = await emit("odd :florble: stays\n");
    expect(html).toContain(":florble:");
  });
});

describe("inline tags (SYNC-17 wall)", () => {
  it("renders #tags as plain text — no chip, no wrapper", async () => {
    const html = await emit("work on #project/alpha today\n");
    expect(html).toContain("<p>work on #project/alpha today</p>");
  });
});

describe("raw HTML escape-by-default", () => {
  it("escapes off-allowlist inline HTML as text", async () => {
    const html = await emit('inline <span class="x">y</span> stays\n');
    expect(html).toContain("&lt;span");
    expect(html).not.toContain('<span class="x">');
  });

  it("escapes script tags everywhere", async () => {
    const html = await emit("evil <script>alert(1)</script> text\n");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
