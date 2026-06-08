// "Link this mention" write (MYND-196 task 4, SYNC-15 invariant). The pure
// insertion transform + the open-dirty routing guard. The actual disk write
// (`saveNote`) is integration; the guard branch throws before any IPC and is
// unit-covered here.

import { describe, expect, it } from "vitest";

import {
  decideLinkWriteRoute,
  insertWikilink,
  linkMention,
  OpenDirtyGuardError,
} from "../../src/notes/linkMention";

describe("insertWikilink", () => {
  it("wraps the first whole-word occurrence as a wikilink", () => {
    expect(insertWikilink("I read Project Apollo today", "Project Apollo")).toBe(
      "I read [[Project Apollo]] today",
    );
  });

  it("preserves the original casing via an alias when it differs", () => {
    expect(insertWikilink("see istanbul notes", "Istanbul")).toBe(
      "see [[Istanbul|istanbul]] notes",
    );
  });

  it("does NOT match a substring — word boundary ('Index' ⊄ 'reindex')", () => {
    expect(insertWikilink("a reindex pass", "Index")).toBe("a reindex pass");
  });

  it("replaces only the FIRST occurrence", () => {
    expect(insertWikilink("Apollo and Apollo", "Apollo")).toBe(
      "[[Apollo]] and Apollo",
    );
  });

  it("skips the frontmatter block — only the body is linked", () => {
    const src = "---\ntitle: Apollo\n---\nThe Apollo mission";
    expect(insertWikilink(src, "Apollo")).toBe(
      "---\ntitle: Apollo\n---\nThe [[Apollo]] mission",
    );
  });

  it("matches a multi-word title only as a CONTIGUOUS phrase", () => {
    expect(insertWikilink("Project then Apollo", "Project Apollo")).toBe(
      "Project then Apollo",
    );
  });

  it("returns the body unchanged when the title does not occur", () => {
    expect(insertWikilink("nothing relevant here", "Apollo")).toBe(
      "nothing relevant here",
    );
  });

  it("returns the body unchanged for an empty title", () => {
    expect(insertWikilink("anything", "")).toBe("anything");
  });

  it("does NOT wrap a match inside an existing wikilink (no nested ]])", () => {
    // "Apollo" occurs only inside [[Apollo project]] (a link to a DIFFERENT
    // note) — wrapping it would yield [[[[Apollo]] project]]. Leave it alone.
    expect(insertWikilink("see [[Apollo project]] here", "Apollo")).toBe(
      "see [[Apollo project]] here",
    );
  });

  it("links the FIRST occurrence outside any existing wikilink", () => {
    expect(
      insertWikilink("[[Apollo project]] and Apollo again", "Apollo"),
    ).toBe("[[Apollo project]] and [[Apollo]] again");
  });

  it("drops the alias when the matched span carries wikilink metacharacters", () => {
    // A table-ish "a | b" matches the title "a b" (contiguous tokens) but the
    // raw span contains a pipe — emitting [[a b|a | b]] would be malformed.
    expect(insertWikilink("row a | b end", "a b")).toBe("row [[a b]] end");
  });
});

describe("decideLinkWriteRoute (SYNC-15)", () => {
  it("guards an open+dirty target (never disk last-writes-win)", () => {
    expect(decideLinkWriteRoute("n1", "n1", true)).toBe("guard");
  });

  it("writes to disk when the target is open but clean", () => {
    expect(decideLinkWriteRoute("n1", "n1", false)).toBe("disk");
  });

  it("writes to disk when the target is not the open note", () => {
    expect(decideLinkWriteRoute("n2", "n1", true)).toBe("disk");
  });

  it("writes to disk when no note is open", () => {
    expect(decideLinkWriteRoute("n2", null, false)).toBe("disk");
  });
});

describe("linkMention guard", () => {
  it("throws OpenDirtyGuardError before any write when the target is open+dirty", async () => {
    await expect(
      linkMention("n1", "Apollo", { openNoteId: "n1", openNoteDirty: true }),
    ).rejects.toBeInstanceOf(OpenDirtyGuardError);
  });
});
