// @vitest-environment jsdom
//
// Hand-built inline-markdown subset renderer for table cells (MYND-162, task 3).

import { describe, expect, it } from "vitest";
import {
  renderInlineCell,
  tableLinkHref,
} from "../../src/editor/decorations/table-inline";

function render(source: string): HTMLElement {
  const host = document.createElement("td");
  renderInlineCell(host, source);
  return host;
}

describe("renderInlineCell — supported subset", () => {
  it("renders bold via <strong>", () => {
    const el = render("a **b** c");
    expect(el.querySelector("strong")?.textContent).toBe("b");
    expect(el.textContent).toBe("a b c");
  });

  it("renders italic via <em> (both * and _)", () => {
    expect(render("*x*").querySelector("em")?.textContent).toBe("x");
    expect(render("_y_").querySelector("em")?.textContent).toBe("y");
  });

  it("renders inline code via <code> with literal inner content", () => {
    const el = render("`**not bold**`");
    const code = el.querySelector("code");
    expect(code?.textContent).toBe("**not bold**");
    expect(el.querySelector("strong")).toBeNull(); // code content is not parsed
  });

  it("renders a http/https link as a cm-link with data-cm-url (no navigable href)", () => {
    const el = render("[site](https://example.com)");
    const a = el.querySelector("a.cm-link") as HTMLAnchorElement | null;
    expect(a).not.toBeNull();
    expect(a!.getAttribute("data-cm-url")).toBe("https://example.com");
    expect(a!.hasAttribute("href")).toBe(false); // never a navigable href
    expect(a!.textContent).toBe("site");
  });

  it("renders nested marks inside a link's text", () => {
    const el = render("[**bold**](https://x.com)");
    expect(el.querySelector("a.cm-link strong")?.textContent).toBe("bold");
  });
});

describe("renderInlineCell — safety (TB2) + scheme allowlist", () => {
  it("never produces a DOM element from raw HTML in a cell", () => {
    const el = render("<b>x</b> & <img src=q onerror=alert(1)>");
    expect(el.querySelector("b")).toBeNull();
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toBe("<b>x</b> & <img src=q onerror=alert(1)>");
  });

  it("renders a javascript: link as inert text — no anchor, no href", () => {
    const el = render("[click](javascript:bad)");
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toBe("click");
  });

  it("treats a relative / schemeless link target as inert", () => {
    const el = render("[rel](/local/path)");
    expect(el.querySelector("a")).toBeNull();
    expect(el.textContent).toBe("rel");
  });

  it("honors backslash escapes (\\* stays literal, not italic)", () => {
    const el = render("a \\* b \\* c");
    expect(el.querySelector("em")).toBeNull();
    expect(el.textContent).toBe("a * b * c");
  });
});

describe("renderInlineCell — out-of-subset constructs render literal", () => {
  it.each([
    ["wikilink", "[[Note Title]]"],
    ["math", "$x^2$"],
    ["footnote ref", "see[^1]"],
    ["emoji shortcode", ":smile:"],
  ])("%s stays literal text", (_label, src) => {
    const el = render(src);
    expect(el.children.length).toBe(0); // no elements — pure text
    expect(el.textContent).toBe(src);
  });
});

describe("tableLinkHref", () => {
  it("allows http / https / mailto", () => {
    expect(tableLinkHref("https://a.com")).toBe("https://a.com");
    expect(tableLinkHref("http://a.com")).toBe("http://a.com");
    expect(tableLinkHref("mailto:a@b.com")).toBe("mailto:a@b.com");
  });
  it("rejects javascript:, data:, and schemeless", () => {
    expect(tableLinkHref("javascript:alert(1)")).toBeNull();
    expect(tableLinkHref("data:text/html,x")).toBeNull();
    expect(tableLinkHref("/relative")).toBeNull();
  });
});
