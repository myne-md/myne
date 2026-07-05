// Derive a note's list title + snippet from its raw plaintext. Prefers the
// managed frontmatter `title:`; otherwise the body's first non-empty line. The
// snippet is the next non-empty body line. Pure + defensive — must never throw
// (one bad note would otherwise break the whole list / an editor render).

import { frontmatterTitle, bodyAfterFrontmatter } from "./note-organize";

export function deriveTitleSnippet(text: string): { title: string; snippet: string } {
  try {
    const fmTitle = frontmatterTitle(text);
    const lines = bodyAfterFrontmatter(text).split("\n");
    let firstIdx = -1;
    let first = "";
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].replace(/^#{1,6}\s*/, "").trim();
      if (t) {
        first = t;
        firstIdx = i;
        break;
      }
    }
    // Snippet source: the line after the title when the title came from the
    // body's first line; otherwise the body's first line itself. When the body
    // has NO non-empty line (firstIdx === -1) — e.g. a daily note with only a
    // frontmatter title and an empty body — start past the end so the loop is
    // skipped (a `-1` start would evaluate `lines[-1].replace` and throw).
    const snippetStart = firstIdx < 0 ? lines.length : fmTitle ? firstIdx : firstIdx + 1;
    let snippet = "";
    for (let i = snippetStart; i < lines.length; i++) {
      const s = lines[i].replace(/^#{1,6}\s*/, "").trim();
      if (s) {
        snippet = s;
        break;
      }
    }
    return { title: fmTitle ?? first, snippet };
  } catch {
    return { title: "", snippet: "" };
  }
}
