// Dialect comment (`%%…%%`) strip on lossy projections (MYND-315, task 3).
//
// ONE canonical recognition point (the `DialectComment` / `DialectCommentBlock`
// parser nodes) consumed by every lossy projection: HTML/PDF (`emitNoteHtml`),
// stripped-TXT (`emitNoteText`), and document statistics (asserted in
// tests/notes/documentStats.test.ts). The `.md` export is byte-verbatim
// (SYNC-2) and never runs through these emitters — that contract is asserted
// here at the projection boundary (the emitters are PURE over their input).
// Spec: agent-tooling/docs/spec/markdown-dialect.md §6.

import { describe, expect, it } from "vitest";
import { emitNoteHtml } from "../../../src/dialect/html/emitNoteHtml";
import { emitNoteText } from "../../../src/dialect/text/emitNoteText";

describe("HTML projection strips `%%…%%`", () => {
  it("omits an inline comment but keeps surrounding text", async () => {
    const { html } = await emitNoteHtml("visible %%hidden%% text\n");
    expect(html).toContain("visible");
    expect(html).toContain("text");
    expect(html).not.toContain("hidden");
    expect(html).not.toContain("%%");
  });

  it("omits a multi-line block comment", async () => {
    const { html } = await emitNoteHtml(
      "before\n\n%% block\ncomment %%\n\nafter\n",
    );
    expect(html).toContain("<p>before</p>");
    expect(html).toContain("<p>after</p>");
    expect(html).not.toContain("comment");
    expect(html).not.toContain("%%");
  });

  it("an unterminated `%%` stays in the output (inert)", async () => {
    const { html } = await emitNoteHtml("a %% lone opener\n");
    expect(html).toContain("%% lone opener");
  });

  it("does NOT strip `%%` inside a code fence (exclusion zone)", async () => {
    const { html } = await emitNoteHtml("```\n%%kept%%\n```\n");
    expect(html).toContain("%%kept%%");
  });

  it("is pure — never mutates the input plaintext", async () => {
    const src = "x %%c%% y\n%% b %%\n";
    const before = src;
    await emitNoteHtml(src);
    expect(src).toBe(before);
  });
});

describe("TXT projection strips `%%…%%`", () => {
  it("omits an inline comment but keeps surrounding text", () => {
    const txt = emitNoteText("visible %%hidden%% text\n");
    expect(txt).toContain("visible");
    expect(txt).toContain("text");
    expect(txt).not.toContain("hidden");
    expect(txt).not.toContain("%%");
  });

  it("omits a multi-line block comment", () => {
    const txt = emitNoteText("before\n\n%% block\ncomment %%\n\nafter\n");
    expect(txt).toContain("before");
    expect(txt).toContain("after");
    expect(txt).not.toContain("comment");
    expect(txt).not.toContain("%%");
  });

  it("an unterminated `%%` stays in the output (inert)", () => {
    expect(emitNoteText("a %% lone opener\n")).toContain("%% lone opener");
  });
});
