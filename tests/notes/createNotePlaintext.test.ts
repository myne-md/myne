// myne-md/myne#653, the bytes a brand-new note is created with.
//
// A root note used to be created with EMPTY plaintext, deferring frontmatter to
// the autosave path, while a note created inside a FOLDER got create-time
// frontmatter. Two paths, two answers, and the root one produced a note with
// nowhere to put its name: no frontmatter block, so no `title:` line to type
// into, on a client where the title is frontmatter-only (`decisions.md`
// 2026-05-28, no first-`# H1` fallback). Combined with the sidebar taking focus
// on create, a freshly made note could not be titled at all.
//
// These assert the BYTES rather than a call count, because that is the shape of
// what went wrong: the write happened, with the wrong payload. No IPC here ,
// `initialNotePlaintext` is pure, which is why it is exported.

import { describe, expect, it } from "vitest";
import { initialNotePlaintext } from "../../src/notes/createNote";
import { buildInitialPlaintext } from "../../dialect/src/surgery";

describe("initialNotePlaintext", () => {
  it("gives a root note a frontmatter block with an empty title", () => {
    expect(initialNotePlaintext(null)).toBe('---\ntitle: ""\n---\n\n');
  });

  it("gives a foldered note both fields, through the same writer", () => {
    expect(initialNotePlaintext("Projects/")).toBe(
      '---\nfolder: Projects/\ntitle: ""\n---\n\n',
    );
  });

  it("normalizes the folder before writing it", () => {
    expect(initialNotePlaintext("Projects/Myne")).toBe(
      '---\nfolder: Projects/Myne/\ntitle: ""\n---\n\n',
    );
  });

  it("treats an empty folder string as the root", () => {
    expect(initialNotePlaintext("")).toBe(initialNotePlaintext(null));
  });

  // The layering, asserted rather than described. The title is patched on TOP of
  // the dialect primitive at the action layer, and not inside it, because
  // `buildInitialPlaintext(null) === ""` is load-bearing: `surgery.ts`'s state-D
  // folder delete collapses an emptied block wholesale so the result is
  // byte-identical to an FM-less root note, and cites that equality as its
  // reason. If this fails, the fix moved into the wrong layer.
  it("leaves the dialect primitive's empty-root identity alone", () => {
    expect(buildInitialPlaintext(null)).toBe("");
    expect(buildInitialPlaintext("")).toBe("");
  });

  // Non-vacuity: the title line must be a real, parseable empty value, not the
  // literal characters `""` sitting in a body. An empty YAML string is quoted,
  // which is what `formatYamlStringScalar("")` produces.
  it("emits a quoted empty scalar, so the field parses as a string", () => {
    const out = initialNotePlaintext(null);
    expect(out).toContain('title: ""');
    expect(out.startsWith("---\n")).toBe(true);
    expect(out.endsWith("---\n\n")).toBe(true);
  });
});
