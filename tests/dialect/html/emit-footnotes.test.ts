// HTML projection emitter — footnotes (MYND-255 task 1).
//
// §3.4: references render as superscript numbered links; definitions collect
// into an end-of-document section (the editor's derived end-list view —
// ordering parity with footnote-collector.ts: first-reference order, then
// unreferenced definitions in source order).

import { describe, expect, it } from "vitest";
import { emitNoteHtml } from "../../../src/dialect/html/emitNoteHtml";

async function emit(src: string): Promise<string> {
  return (await emitNoteHtml(src)).html;
}

describe("footnotes", () => {
  it("renders references as superscript numbered links", async () => {
    const html = await emit("first[^a] then[^b]\n\n[^a]: A def\n[^b]: B def\n");
    expect(html).toContain(
      '<sup class="footnote-ref"><a id="fnref-1" href="#fn-1">1</a></sup>',
    );
    expect(html).toContain(
      '<sup class="footnote-ref"><a id="fnref-2" href="#fn-2">2</a></sup>',
    );
  });

  it("numbers by first-reference order, not definition order", async () => {
    const html = await emit("uses[^z] and[^a]\n\n[^a]: a-def\n[^z]: z-def\n");
    const list = html.slice(html.indexOf('<section class="footnotes">'));
    expect(list.indexOf("z-def")).toBeLessThan(list.indexOf("a-def"));
    expect(list).toContain('<li class="footnote-item" id="fn-1"><p>z-def</p></li>');
    expect(list).toContain('<li class="footnote-item" id="fn-2"><p>a-def</p></li>');
  });

  it("collects definitions into an end-of-document section and hides them in place", async () => {
    const html = await emit("x[^1]\n\n[^1]: the note\n\nafter\n");
    const section = html.indexOf('<section class="footnotes">');
    expect(section).toBeGreaterThan(-1);
    expect(html.indexOf("<p>after</p>")).toBeLessThan(section);
    expect(html).not.toContain("[^1]:");
    expect(html).toContain('<ol class="footnote-list">');
  });

  it("renders multi-line definition bodies (continuation rule)", async () => {
    const html = await emit("x[^1]\n\n[^1]: line one\n    line two\n");
    expect(html).toContain("line one\n    line two");
  });

  it("repeated references share one number; only the first carries the backref id", async () => {
    const html = await emit("a[^n] b[^n]\n\n[^n]: def\n");
    expect(html.match(/href="#fn-1"/g)).toHaveLength(2);
    expect(html.match(/id="fnref-1"/g)).toHaveLength(1);
  });

  it("leaves an orphan reference as literal text", async () => {
    const html = await emit("dangling[^ghost]\n");
    expect(html).toContain("[^ghost]");
    expect(html).not.toContain("footnote-ref");
    expect(html).not.toContain('<section class="footnotes">');
  });

  it("appends unreferenced definitions after the referenced ones", async () => {
    const html = await emit("x[^used]\n\n[^used]: u-def\n[^lone]: l-def\n");
    const list = html.slice(html.indexOf('<section class="footnotes">'));
    expect(list.indexOf("u-def")).toBeLessThan(list.indexOf("l-def"));
    expect(list).toContain('id="fn-2"><p>l-def</p>');
  });

  it("emits no section when the note has no footnotes", async () => {
    const html = await emit("plain paragraph\n");
    expect(html).not.toContain("footnotes");
  });
});
