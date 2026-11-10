// Derive a note's list title + snippet from its raw plaintext.
//
// **The TITLE is the managed frontmatter `title:` and nothing else** (owner,
// 2026-11-08: "on mobile, if a file has no title, the first line inside shows as
// the title, I don't want that; make it like desktop"). Desktop settled this on
// 2026-05-28: the title is frontmatter-only, with no first-`# H1` fallback, so a
// note without one reads as "Untitled" until the user names it. Mobile kept its
// own derivation and drifted, which is why the same vault listed the same note
// under two different names on two devices.
//
// The snippet still comes from the body's first non-empty line, and it is a
// SNIPPET: list rows draw it as the second line, never as the name. Pure +
// defensive, must never throw (one bad note would otherwise break the whole list
// / an editor render).

import { frontmatterTitle, bodyAfterFrontmatter } from "./note-organize";

export function deriveTitleSnippet(text: string): { title: string; snippet: string } {
  try {
    const fmTitle = frontmatterTitle(text);
    const lines = bodyAfterFrontmatter(text).split("\n");
    // Snippet source: the body's first non-empty line, and only that, the title
    // never comes from the body any more, so there is one line to find rather than
    // two indices to keep in step.
    let snippet = "";
    for (let i = 0; i < lines.length; i++) {
      const s = lines[i].replace(/^#{1,6}\s*/, "").trim();
      if (s) {
        snippet = s;
        break;
      }
    }
    return { title: fmTitle ?? "", snippet };
  } catch {
    return { title: "", snippet: "" };
  }
}
