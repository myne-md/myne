// @vitest-environment jsdom
//
// Per-construct render conformance (MYND-208, task 3). Targeted DOM + cursor-
// reveal assertions for every already-rendering construct that hides or
// transforms ranges, driven through the full editor via the shared harness.
// Out-of-scope constructs (owned by sibling sub-features #2-#6) are asserted as
// plain-text + byte-stable today, tagged @scope:deferred-<sibling> so the owning
// sibling can re-point them to rich-render assertions when it lands.

import { afterEach, describe, expect, it } from "vitest";
import {
  type Mounted,
  focusAt,
  mount,
  query,
  renderedText,
  roundTripBytes,
  teardown,
} from "./_conformance";

let m: Mounted | null = null;
afterEach(() => {
  if (m !== null) teardown(m);
  m = null;
});

describe("headings", () => {
  it("renders ATX h1-h6 line classes", () => {
    for (let level = 1; level <= 6; level++) {
      const sub = mount(`${"#".repeat(level)} Heading\n`);
      expect(query(sub, `.cm-h${level}`)).not.toBeNull();
      teardown(sub);
    }
  });

  it("renders a Setext h1 (=== underline) as h1 typography", () => {
    m = mount("Title\n=====\n");
    expect(query(m, ".cm-h1")).not.toBeNull();
  });

  it("renders a Setext h2 (--- underline) as h2 typography", () => {
    m = mount("Title\n-----\n");
    expect(query(m, ".cm-h2")).not.toBeNull();
  });
});

describe("inline emphasis", () => {
  it("renders bold / italic / strikethrough / inline code", () => {
    m = mount("**b** *i* ~~s~~ `c`\n");
    expect(query(m, ".cm-bold")).not.toBeNull();
    expect(query(m, ".cm-italic")).not.toBeNull();
    expect(query(m, ".cm-strike")).not.toBeNull();
    expect(query(m, ".cm-inline-code")).not.toBeNull();
  });

  it("hides bold markers off-cursor and reveals them on-cursor", () => {
    m = mount("**bold** trailing\n");
    expect(renderedText(m)).not.toContain("**");
    focusAt(m, 3); // inside **bold**
    expect(renderedText(m)).toContain("**bold**");
  });
});

describe("links", () => {
  it("renders an inline link with the url markup hidden", () => {
    m = mount("[text](https://myne.md) after\n");
    expect(query(m, ".cm-link")).not.toBeNull();
    expect(renderedText(m)).not.toContain("https://myne.md");
    expect(renderedText(m)).toContain("text");
  });

  it("renders an autolink and a reference link", () => {
    const auto = mount("<https://myne.md>\n");
    expect(query(auto, ".cm-link")).not.toBeNull();
    teardown(auto);
    m = mount("[ref text][r] x\n\n[r]: https://myne.md\n");
    expect(query(m, ".cm-link")).not.toBeNull();
  });
});

describe("blockquotes", () => {
  it("renders a blockquote line class", () => {
    m = mount("> quoted\n");
    expect(query(m, ".cm-blockquote")).not.toBeNull();
  });
});

describe("fenced code", () => {
  it("renders a closed fenced block as a code card", () => {
    m = mount("```js\nconst x = 1;\n```\n");
    expect(query(m, ".cm-code-card-body")).not.toBeNull();
    expect(query(m, ".cm-code-badge")).not.toBeNull();
  });
});

describe("tables", () => {
  it("renders a pipe table as a real <table>", () => {
    m = mount("| a | b |\n|---|---|\n| 1 | 2 |\n");
    expect(query(m, "table")).not.toBeNull();
  });
});

describe("horizontal rule", () => {
  it("renders --- as an hr widget off-cursor", () => {
    m = mount("above\n\n---\n\nbelow\n", 0); // cursor at start, off the rule
    expect(query(m, ".cm-hr")).not.toBeNull();
  });
});

describe("definition lists", () => {
  it("renders a tight definition list with term + description", () => {
    m = mount("Term\n: Definition\n");
    expect(query(m, ".cm-def-term")).not.toBeNull();
    expect(query(m, ".cm-def-desc")).not.toBeNull();
  });
});

describe("footnotes", () => {
  it("renders a footnote reference as a superscript marker", () => {
    m = mount("see [^1] here\n\n[^1]: note\n");
    expect(query(m, ".cm-footnote-ref")).not.toBeNull();
  });
});

describe("task lists", () => {
  it("renders open and completed task checkboxes", () => {
    const open = mount("- [ ] open\n");
    expect(query(open, ".cm-task-checkbox")).not.toBeNull();
    teardown(open);
    m = mount("- [x] done\n");
    expect(query(m, ".cm-task-checkbox-checked")).not.toBeNull();
  });
});

// Out-of-scope today — owned by sibling sub-features. Asserted as plain-text +
// byte-stable now; the owning sibling re-points these to rich-render assertions.
describe("deferred constructs (plain-text + byte-stable)", () => {
  it("inline-typography — ==/~/^ now render (markers hidden); :emoji: still plain pending task 3", () => {
    // MYND-156 task 2 landed: highlight/sub/sup render. Emoji shortcode glyph
    // substitution is task 3, so `:smile:` stays literal for now.
    const doc = "==hi== H~2~O X^2^ :smile:\n";
    m = mount(doc);
    const text = renderedText(m);
    expect(text).not.toContain("==hi=="); // highlight markers hidden
    expect(text).toContain(":smile:"); // emoji shortcode still literal (task 3)
    expect(roundTripBytes(doc)).toBe(doc);
  });

  it("@scope:deferred-embedded-html — raw HTML renders as plain text", () => {
    const doc = "<kbd>Ctrl</kbd> and <mark>hi</mark>\n";
    m = mount(doc);
    expect(renderedText(m)).toContain("<kbd>");
    expect(roundTripBytes(doc)).toBe(doc);
  });

  it("@scope:deferred-math-katex — $…$ renders as plain text", () => {
    const doc = "inline $E = mc^2$ math\n";
    m = mount(doc);
    expect(renderedText(m)).toContain("$E = mc^2$");
    expect(roundTripBytes(doc)).toBe(doc);
  });
});
