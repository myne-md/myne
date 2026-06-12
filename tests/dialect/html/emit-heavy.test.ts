// @vitest-environment jsdom
//
// HTML projection emitter — heavy renderers (MYND-255 task 2).
//
// Fenced-code highlighting (`@lezer/highlight` classHighlighter `tok-*`
// spans), KaTeX math (real lazy import — works in tests), mermaid (jsdom can
// NOT render SVG → the fallback code card is asserted; real-SVG rendering is
// exercised in the app/capture path), and the embedded-HTML DOMPurify 8-tag
// allowlist with sanitizer controls.

import { describe, expect, it } from "vitest";
import { emitNoteHtml } from "../../../src/dialect/html/emitNoteHtml";
import { setMermaidLoader } from "../../../src/editor/mermaid/render-mermaid";

async function emit(src: string): Promise<string> {
  return (await emitNoteHtml(src)).html;
}

describe("fenced code highlighting", () => {
  it("emits class-tagged tok-* spans for a known language", async () => {
    const html = await emit("```ts\nconst x = 1; // hi\n```\n");
    expect(html).toContain('<pre class="code-card" data-lang="ts"><code>');
    expect(html).toContain('<span class="tok-keyword">const</span>');
    expect(html).toContain('<span class="tok-number">1</span>');
    expect(html).toContain('<span class="tok-comment">// hi</span>');
  });

  it("renders an unknown language as escaped plain text", async () => {
    const html = await emit("```florbscript\na < b\n```\n");
    expect(html).toContain(
      '<pre class="code-card" data-lang="florbscript"><code>a &lt; b</code></pre>',
    );
    expect(html).not.toContain("tok-");
  });

  it("renders an untagged fence without a data-lang attribute", async () => {
    const html = await emit("```\nplain\n```\n");
    expect(html).toContain('<pre class="code-card"><code>plain</code></pre>');
  });

  it("escapes code content inside highlighted spans", async () => {
    const html = await emit('```ts\nconst s = "<script>";\n```\n');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("math (KaTeX, lazy)", () => {
  it("renders inline $…$ via KaTeX html output", async () => {
    const html = await emit("Euler: $e^{i\\pi}$ wow\n");
    expect(html).toContain('<span class="math math-inline">');
    expect(html).toContain("katex");
  });

  it("renders block $$…$$ as a math block", async () => {
    const html = await emit("$$\nE = mc^2\n$$\n");
    expect(html).toContain('<div class="math math-block">');
    expect(html).toContain("katex");
    expect(html).not.toContain("$$");
  });

  it("falls back to raw source for invalid LaTeX (never KaTeX's error node)", async () => {
    const html = await emit("bad $\\florb{x}$ math\n");
    expect(html).toContain('<span class="math math-error">$\\florb{x}$</span>');
    expect(html).not.toContain("katex-error");
  });

  it("leaves currency dollars alone (§3.2 disambiguation)", async () => {
    const html = await emit("Costs $5 and $ 10 today\n");
    expect(html).not.toContain("math");
    expect(html).toContain("$5");
  });

  it("keeps $$ inside fenced code literal", async () => {
    const html = await emit("```\n$$ not math $$\n```\n");
    expect(html).not.toContain("math-block");
    expect(html).toContain("$$ not math $$");
  });
});

describe("mermaid", () => {
  it("falls back to a monospace code card in jsdom (no real SVG layout)", async () => {
    const html = await emit("```mermaid\ngraph TD; A-->B;\n```\n");
    expect(html).toContain(
      '<pre class="code-card mermaid-fallback"><code>graph TD; A--&gt;B;</code></pre>',
    );
    expect(html).not.toContain("<figure");
  });

  it("renders the diagram when forced with an injected renderer", async () => {
    const restore = setMermaidLoader(async () => async (_id, code) => ({
      svg: `<svg data-code="${code.length}"></svg>`,
      error: null,
    }));
    try {
      const html = (
        await emitNoteHtml("```mermaid\ngraph TD; A-->B;\n```\n", {
          mermaid: "force",
        })
      ).html;
      expect(html).toContain('<figure class="mermaid-diagram"><svg');
      expect(html).not.toContain("mermaid-fallback");
    } finally {
      restore();
    }
  });

  it("falls back to the code card when the renderer reports an error", async () => {
    const restore = setMermaidLoader(async () => async () => ({
      svg: "",
      error: "parse error",
    }));
    try {
      const html = (
        await emitNoteHtml("```mermaid\nnot a diagram\n```\n", {
          mermaid: "force",
        })
      ).html;
      expect(html).toContain("mermaid-fallback");
      expect(html).toContain("not a diagram");
    } finally {
      restore();
    }
  });

  it("never highlights a mermaid fence as code", async () => {
    const html = await emit("```mermaid\ngraph TD;\n```\n");
    expect(html).not.toContain("tok-");
    expect(html).not.toContain('data-lang="mermaid"');
  });
});

describe("embedded HTML (DOMPurify 8-tag allowlist)", () => {
  it("passes sanitized allowlisted inline spans through", async () => {
    const html = await emit("press <kbd>Cmd</kbd> now\n");
    expect(html).toContain('<span class="embedded-html"><kbd>Cmd</kbd></span>');
  });

  it("keeps the title attribute on <abbr>", async () => {
    const html = await emit('the <abbr title="HyperText">HT</abbr> part\n');
    expect(html).toContain('<abbr title="HyperText">HT</abbr>');
  });

  it("strips on* event handlers (sanitizer control)", async () => {
    const html = await emit('<kbd onclick="evil()">K</kbd>\n');
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("evil");
    expect(html).toContain("<kbd>K</kbd>");
  });

  it("strips class/id/style attributes off allowlisted tags", async () => {
    const html = await emit('<mark class="x" style="color:red" id="y">m</mark>\n');
    expect(html).toContain("<mark>m</mark>");
    expect(html).not.toContain("color:red");
  });

  it("renders allowlisted block HTML (<p>, <details>/<summary>) sanitized", async () => {
    const html = await emit(
      "<details><summary>More</summary>hidden body</details>\n",
    );
    expect(html).toContain('<div class="embedded-html-block">');
    expect(html).toContain("<summary>More</summary>");
    expect(html).toContain("hidden body");
  });

  it("escapes off-allowlist block HTML as plain text", async () => {
    const html = await emit('<iframe src="https://evil.example"></iframe>\n');
    expect(html).not.toContain("<iframe");
    expect(html).toContain("&lt;iframe");
  });

  it("escapes <script> blocks — content never executes", async () => {
    const html = await emit("<script>alert(1)</script>\n");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("keeps nested off-allowlist content out even inside allowlisted spans", async () => {
    const html = await emit("<kbd><img src=x onerror=evil()>K</kbd>\n");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
    expect(html).toContain("K");
  });
});
