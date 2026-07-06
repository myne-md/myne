import { describe, it, expect } from "vitest";
import { deriveTitleSnippet } from "../src/lib/note-title";

describe("deriveTitleSnippet", () => {
  it("uses the frontmatter title + first body line as snippet", () => {
    const t = "---\ntitle: Hello\n---\n\nFirst line\nSecond line";
    expect(deriveTitleSnippet(t)).toEqual({ title: "Hello", snippet: "First line" });
  });

  it("falls back to the body's first line when there is no fm title", () => {
    expect(deriveTitleSnippet("# My Note\n\nbody here")).toEqual({ title: "My Note", snippet: "body here" });
  });

  it("does NOT throw on a frontmatter-title note with an EMPTY body (the daily-note regression)", () => {
    // A daily note: only a managed title + folder, empty body → firstIdx === -1.
    // The old code set snippetStart to -1 and evaluated lines[-1].replace → crash.
    const daily = '---\ntitle: "2026-07-04"\nfolder: Daily/\n---\n\n';
    expect(() => deriveTitleSnippet(daily)).not.toThrow();
    expect(deriveTitleSnippet(daily)).toEqual({ title: "2026-07-04", snippet: "" });
  });

  it("handles a fully empty note", () => {
    expect(deriveTitleSnippet("")).toEqual({ title: "", snippet: "" });
  });

  it("handles a note that is only a title line (no snippet)", () => {
    expect(deriveTitleSnippet("# Only a heading")).toEqual({ title: "Only a heading", snippet: "" });
  });
});
