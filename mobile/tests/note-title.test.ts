import { describe, it, expect } from "vitest";
import { deriveTitleSnippet } from "../src/lib/note-title";

describe("deriveTitleSnippet", () => {
  it("uses the frontmatter title + first body line as snippet", () => {
    const t = "---\ntitle: Hello\n---\n\nFirst line\nSecond line";
    expect(deriveTitleSnippet(t)).toEqual({ title: "Hello", snippet: "First line" });
  });

  it("does NOT fall back to the body's first line (desktop parity, owner 2026-11-08)", () => {
    // The body's first line is a SNIPPET, never the name: desktop settled that on
    // 2026-05-28 (`title:` is frontmatter-only, no first-H1 fallback), and mobile
    // drifting from it is why one vault listed one note under two names.
    expect(deriveTitleSnippet("# My Note\n\nbody here")).toEqual({ title: "", snippet: "My Note" });
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
    // The single line is the snippet and there is nothing after it, so the note
    // reads as untitled with its first line as the second line — which is what
    // desktop shows for the same bytes.
    expect(deriveTitleSnippet("# Only a heading")).toEqual({ title: "", snippet: "Only a heading" });
  });
});
