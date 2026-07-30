// Frontmatter stripping for the clipboard copy (MYND-643).
//
// Copying a note puts its BODY on the clipboard, not the managed frontmatter
// block: pasting a raw `---` block into a chat message is noise, and it leaks
// the note's internal bookkeeping to wherever it lands. Exporting a FILE still
// keeps frontmatter, because there the round-trip back into a vault is the point
// — so this asymmetry is deliberate and worth pinning.

import { describe, expect, it } from "vitest";
import { bodyWithoutFrontmatter } from "../../src/notes/copyNoteMarkdown";

describe("bodyWithoutFrontmatter", () => {
  it("drops a managed frontmatter block and the blank line after it", () => {
    const note = "---\ntitle: Notes\nfolder: Work/\n---\n\n# Heading\n\nbody\n";
    expect(bodyWithoutFrontmatter(note)).toBe("# Heading\n\nbody\n");
  });

  it("returns a note with no frontmatter unchanged", () => {
    const note = "# Just a heading\n\nand a body\n";
    expect(bodyWithoutFrontmatter(note)).toBe(note);
  });

  it("does not mistake a horizontal rule mid-body for frontmatter", () => {
    // A `---` that is not at the top is a thematic break, not a block. Getting
    // this wrong would silently truncate the note at its first rule.
    const note = "intro\n\n---\n\nafter the rule\n";
    expect(bodyWithoutFrontmatter(note)).toBe(note);
  });

  it("yields an empty string for a note that is nothing but frontmatter", () => {
    expect(bodyWithoutFrontmatter("---\ntitle: Empty\n---\n")).toBe("");
  });

  it("keeps the body's own leading blank lines, dropping only the separator", () => {
    // The single blank line between the block and the body is a separator to
    // drop; blank lines the body itself opens with belong to the user's prose.
    const note = "---\ntitle: Poem\n---\n\n\nline after two blanks\n";
    expect(bodyWithoutFrontmatter(note)).toBe("\nline after two blanks\n");
  });
});
