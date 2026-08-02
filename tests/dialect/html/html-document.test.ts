// Standalone HTML-document assembler tests (note-export MYND-340 task 2).
//
// Wraps the emitNoteHtml body in a complete <html> document with the
// inline print stylesheet + @font-face, and KaTeX CSS only when the note
// contains math.

import { afterEach, describe, expect, it, vi } from "vitest";
import { emitStandaloneHtml } from "../../../src/dialect/html/htmlDocument";

describe("standalone document shell", () => {
  it("wraps the emitted body in a full <html>…</html> doc with inline <style>", async () => {
    const { document } = await emitStandaloneHtml("# Hello\n\nA body line.");
    expect(document.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(document).toContain("<html lang=\"en\">");
    expect(document).toContain("<head>");
    expect(document).toContain('<meta charset="utf-8">');
    expect(document).toContain("<style>");
    expect(document).toContain("</style>");
    // `dir="auto"` (RTL, #172): the body resolves direction from content.
    expect(document).toContain('<body dir="auto">');
    expect(document.trimEnd().endsWith("</html>")).toBe(true);
    // The emitted body is embedded.
    expect(document).toContain("<h1>Hello</h1>");
    expect(document).toContain("<p>A body line.</p>");
  });

  it("inlines the print stylesheet (note print CSS) and @font-face", async () => {
    const { document } = await emitStandaloneHtml("body");
    expect(document).toContain("Note print stylesheet");
    expect(document).toContain("@font-face");
    expect(document).toContain("InterVariable.woff2");
  });

  it("uses the frontmatter title as the document <title> (escaped)", async () => {
    const { document, title } = await emitStandaloneHtml(
      '---\ntitle: A & B <C>\n---\nbody',
    );
    expect(title).toBe("A & B <C>");
    expect(document).toContain("<title>A &amp; B &lt;C&gt;</title>");
    // The title also projects to the body's note-title heading.
    expect(document).toContain('<h1 class="note-title">A &amp; B &lt;C&gt;</h1>');
  });

  it("falls back to <title>Note</title> for an untitled note", async () => {
    const { document, title } = await emitStandaloneHtml("just a body");
    expect(title).toBeNull();
    expect(document).toContain("<title>Note</title>");
  });

  it("resolves @page Letter for a US locale and A4 otherwise", async () => {
    const us = await emitStandaloneHtml("x", { locale: "en-US" });
    expect(us.document).toContain("size: Letter");
    const de = await emitStandaloneHtml("x", { locale: "de-DE" });
    expect(de.document).toContain("size: A4");
  });
});

describe("KaTeX CSS gating", () => {
  // NOTE: Vitest does NOT run Vite's CSS-asset transform, so
  // `import("katex/dist/katex.min.css?inline")` resolves to an empty
  // string here (verified) — the PRODUCTION `pnpm build` inlines the real
  // CSS (build is green). These tests therefore pin the GATING decision
  // (does the assembler take the KaTeX-CSS branch?), observable via the
  // `.katex` body class the emitter produces, rather than the inlined CSS
  // bytes the test env can't materialize.
  it("a plain note does NOT render KaTeX (no .katex class, no math span)", async () => {
    const { document } = await emitStandaloneHtml("no math here");
    // No KaTeX root class anywhere (the print stylesheet's `.math-inline`
    // RULE is always present — assert the emitted SPAN class instead).
    expect(document).not.toContain('class="katex');
    expect(document).not.toContain('class="math math-inline"');
  });

  it("a math-bearing note renders KaTeX (gating branch taken)", async () => {
    // `mermaid:"off"` keeps the renderer path lean; math renders via the
    // jsdom KaTeX path that the emitter's golden tests exercise.
    const { document } = await emitStandaloneHtml("inline $x^2$ math", {
      mermaid: "off",
    });
    // KaTeX rendered → the body carries the `katex` class, which is the
    // exact condition that drives the assembler to inline KaTeX's CSS
    // (the production build then carries the real stylesheet bytes).
    expect(document).toContain('class="katex');
  });
});

describe("purity", () => {
  it("does not throw on note content and returns a string document", async () => {
    const { document } = await emitStandaloneHtml(
      "weird **content** with `code` and [[wiki]]",
    );
    expect(typeof document).toBe("string");
    expect(document.length).toBeGreaterThan(0);
  });
});

describe("attachment src pinning (MYND-519)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pins image srcs to the canonical attachment://<id> form even inside Tauri", async () => {
    // The export projection must be deterministic across platforms and match
    // the exact shape the Rust sidecar rewriter scans for
    // (`html_referenced_attachment_ids`) — never the platform-aware runtime
    // form `convertFileSrc` would emit.
    vi.stubGlobal("window", {
      __TAURI_INTERNALS__: {
        convertFileSrc: (path: string, protocol: string) =>
          `http://${protocol}.localhost/${path}`,
      },
    });
    const id = "a".repeat(64);
    const { document } = await emitStandaloneHtml(`![[att:${id}|pic.png]]\n`);
    expect(document).toContain(`src="attachment://${id}"`);
    expect(document).not.toContain("attachment.localhost");
  });
});
