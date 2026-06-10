// @vitest-environment jsdom
//
// Embedded-HTML sanitizer (MYND-209, task 1). The ultra-tight allowlist is the
// XSS boundary — these tests prove it strips every dangerous vector and keeps
// only the 8 allowlisted elements + `title` on <abbr>.

import { describe, expect, it } from "vitest";
import { sanitizeEmbeddedHtml } from "../../src/editor/html/sanitize";

describe("sanitizeEmbeddedHtml — allowlist (keeps)", () => {
  it("keeps the allowlisted inline + block elements", async () => {
    expect(await sanitizeEmbeddedHtml("<kbd>Ctrl</kbd>")).toBe("<kbd>Ctrl</kbd>");
    expect(await sanitizeEmbeddedHtml("<mark>hi</mark>")).toBe("<mark>hi</mark>");
    expect(await sanitizeEmbeddedHtml("<sub>2</sub>")).toBe("<sub>2</sub>");
    expect(await sanitizeEmbeddedHtml("<sup>2</sup>")).toBe("<sup>2</sup>");
    expect(await sanitizeEmbeddedHtml("<p>para</p>")).toBe("<p>para</p>");
  });

  it("keeps title on <abbr> (the only allowed attribute)", async () => {
    const out = await sanitizeEmbeddedHtml('<abbr title="HyperText">HTML</abbr>');
    expect(out).toContain("<abbr");
    expect(out).toContain('title="HyperText"');
    expect(out).toContain("HTML</abbr>");
  });

  it("keeps <details>/<summary>", async () => {
    const out = await sanitizeEmbeddedHtml(
      "<details><summary>more</summary>body</details>",
    );
    expect(out).toContain("<details>");
    expect(out).toContain("<summary>more</summary>");
  });
});

describe("sanitizeEmbeddedHtml — XSS boundary (strips)", () => {
  it("strips <script> entirely", async () => {
    expect(await sanitizeEmbeddedHtml("<script>alert(1)</script>")).toBe("");
  });

  it("strips on* event handlers", async () => {
    const out = await sanitizeEmbeddedHtml('<mark onclick="evil()">x</mark>');
    expect(out).not.toContain("onclick");
    expect(out).toContain("x");
  });

  it("strips a remote <img src> (no resource load)", async () => {
    const out = await sanitizeEmbeddedHtml('<img src="https://evil/x.png">');
    expect(out).not.toContain("<img");
    expect(out).not.toContain("src");
  });

  it("strips javascript: and href on a non-allowed <a>, keeps its text", async () => {
    const out = await sanitizeEmbeddedHtml('<a href="javascript:evil()">link</a>');
    expect(out).not.toContain("href");
    expect(out).not.toContain("javascript:");
    expect(out).toContain("link");
  });

  it("strips <iframe> (out of the allowlist)", async () => {
    const out = await sanitizeEmbeddedHtml('<iframe src="https://evil"></iframe>');
    expect(out).not.toContain("<iframe");
  });

  it("strips style/class/id attributes off allowlisted tags", async () => {
    const out = await sanitizeEmbeddedHtml(
      '<kbd style="x" class="y" id="z">K</kbd>',
    );
    expect(out).toBe("<kbd>K</kbd>");
  });
});
