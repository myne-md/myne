// Note mentions in an answer (myne-md/myne#867).
//
// The boundary rules ARE the feature. A matcher that links too eagerly puts the
// wrong note one click away, which is worse than no link at all, so every case
// below is one that a looser matcher gets wrong. The reported case is here too,
// with the sentence it was reported in.

import { describe, expect, it } from "vitest";

import {
  buildMentionTargets,
  linkifyMentions,
  type MentionSegment,
} from "../../src/notes/ai/noteMentions";
import type { ResolverNote } from "../../src/notes/resolveWikilink";

const NOTES: ResolverNote[] = [
  {
    noteUuid: "n-pixel",
    title: "Pixel 10 Graphene OS",
    folder: "Personal/Things I have/",
  },
  { noteUuid: "n-notes", title: "Notes", folder: null },
  { noteUuid: "n-notes-q3", title: "Notes on Q3", folder: null },
  { noteUuid: "n-rust", title: "Rust", folder: "Study/" },
];

const targets = buildMentionTargets(NOTES);

const split = (text: string): MentionSegment[] => linkifyMentions(text, targets);
const mentions = (text: string): MentionSegment[] =>
  split(text).filter((seg) => seg.noteUuid !== undefined);

describe("buildMentionTargets", () => {
  it("offers the path, the path without .md, and the bare title", () => {
    const forPixel = targets.filter((t) => t.noteUuid === "n-pixel").map((t) => t.text);
    expect(forPixel).toContain("Personal/Things I have/Pixel 10 Graphene OS.md");
    expect(forPixel).toContain("Personal/Things I have/Pixel 10 Graphene OS");
    expect(forPixel).toContain("Pixel 10 Graphene OS");
  });

  it("orders longest first, which is what makes the longest-match rule work", () => {
    const lengths = targets.map((t) => t.text.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
  });
});

describe("linkifyMentions: what becomes a link", () => {
  it("links the mention inside the sentence this was reported with", () => {
    const text =
      "Notunuz Personal/Things I have/Pixel 10 Graphene OS başlığı altında duruyor.";
    const hits = mentions(text);
    expect(hits).toHaveLength(1);
    expect(hits[0].noteUuid).toBe("n-pixel");
    expect(hits[0].text).toBe("Personal/Things I have/Pixel 10 Graphene OS");
    // …and the sentence survives intact: the segments are the whole text.
    expect(split(text).map((seg) => seg.text).join("")).toBe(text);
  });

  it("links a bare title, and a path written with its .md", () => {
    expect(mentions("see Rust for that")[0]?.noteUuid).toBe("n-rust");
    expect(mentions("Study/Rust.md")[0]?.noteUuid).toBe("n-rust");
  });

  it("still links a mention the sentence ends on", () => {
    // `.` is deliberately not a name character. A full stop after a mention is
    // the ordinary case, and treating it as name-continuation would drop the
    // most common mention there is.
    expect(mentions("it is under Personal/Things I have/Pixel 10 Graphene OS."))
      .toHaveLength(1);
  });

  it("takes the LONGEST name at a position", () => {
    // Both `Notes` and `Notes on Q3` are notes. The sentence names the longer
    // one, and a first-match-wins scan would link the shorter.
    const hits = mentions("open Notes on Q3");
    expect(hits).toHaveLength(1);
    expect(hits[0].noteUuid).toBe("n-notes-q3");
  });
});

describe("linkifyMentions: what stays prose", () => {
  it("a name that is only a prefix of a real title", () => {
    // `Pixel 10` is not a note. `Pixel 10 Graphene OS` is. Linking the prefix
    // would open a note the model never named.
    expect(mentions("about Pixel 10 today")).toHaveLength(0);
  });

  it("a path missing a segment", () => {
    expect(mentions("Personal/Pixel 10 Graphene OS")).toHaveLength(0);
  });

  it("a name that runs on into a longer word", () => {
    // The right boundary. Without it `NotesX` links the note `Notes` and leaves
    // the `X` dangling outside the link.
    expect(mentions("NotesX")).toHaveLength(0);
  });

  it("a bare title sitting inside a path", () => {
    // The left boundary. `Rust` here is preceded by `/`, so it is a path
    // fragment rather than a mention of the note.
    expect(mentions("elsewhere/Rust")).toHaveLength(0);
  });

  it("leaves prose with no mention as one plain segment", () => {
    expect(split("nothing to see here")).toEqual([{ text: "nothing to see here" }]);
  });
});

describe("a refused longer name does not hand the position to a shorter one (myne-md/myne#867 review)", () => {
  it("leaves `Notes on Q3X` as plain text rather than linking `Notes`", () => {
    // `targets` is longest-first, so `Notes on Q3` is tried at position 0 and
    // refused because `X` continues a name. The bug the review found was that
    // the scan then continued to the next candidate and linked `Notes`, which
    // opens a note the text did not name. Rule 1 says a shorter title must not
    // claim a position a longer one was refused at.
    const targets = buildMentionTargets([
      { noteUuid: "short", title: "Notes", folder: null },
      { noteUuid: "long", title: "Notes on Q3", folder: null },
    ]);
    expect(linkifyMentions("Notes on Q3X is the file", targets)).toEqual([
      { text: "Notes on Q3X is the file" },
    ]);
    // The control: the longer name DOES link where the next character ends it.
    expect(linkifyMentions("Notes on Q3 is the file", targets)).toEqual([
      { text: "Notes on Q3", noteUuid: "long" },
      { text: " is the file" },
    ]);
  });
});

describe("a title two notes share links neither (myne-md/myne#867 review, D7)", () => {
  const shared: ResolverNote[] = [
    { noteUuid: "n-a", title: "Meeting", folder: "A/" },
    { noteUuid: "n-b", title: "Meeting", folder: "B/" },
  ];
  const sharedTargets = buildMentionTargets(shared);

  it("leaves the shared bare title plain, rather than opening the first note listed", () => {
    expect(
      linkifyMentions("see Meeting today", sharedTargets).filter((s) => s.noteUuid !== undefined),
    ).toEqual([]);
  });

  it("still links each note by its full path, which only one of them can have", () => {
    const linked = linkifyMentions("see A/Meeting and B/Meeting", sharedTargets).filter(
      (s) => s.noteUuid !== undefined,
    );
    expect(linked.map((s) => s.noteUuid)).toEqual(["n-a", "n-b"]);
  });
});
