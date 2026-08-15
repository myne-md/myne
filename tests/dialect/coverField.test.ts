// `cover:` value-strict read (myne-md/myne#410).
//
// The accept table is the point of this file. `cover:` is the first managed
// canonical field whose value can legitimately contain a `#` or a `"`, because
// a filename can, and both of those are exactly what a hand-rolled reader gets
// wrong: `#` looks like a YAML comment and `"` is escaped on disk. The reader
// under test goes through the shared scalar extractor for that reason, so these
// cases are the evidence that it actually does.
//
// The reject table is the other half. Every entry is a value a user can end up
// with, and each one must leave the note WITHOUT a cover rather than half-way
// into one, because a value the grammar accepts but the renderer cannot draw is
// the failure mode the strictness exists to prevent.

import { describe, expect, it } from "vitest";
import { readCoverFromFmBody, readCoverValue } from "@myne/dialect";
import { MANAGED_FRONTMATTER_FIELDS } from "../../src/dialect/managedFields";

const ID = "a".repeat(64);
const ID2 = "0123456789abcdef".repeat(4);

describe("readCoverValue — accepted forms", () => {
  it("reads the quoted on-disk form Myne writes", () => {
    expect(readCoverValue(`"![[att:${ID}|photo.png]]"`)).toEqual({
      id: ID,
      filename: "photo.png",
    });
  });

  it("reads the quoted form with a trailing YAML comment", () => {
    // `patchFrontmatterField` state C preserves a trailing comment, so the
    // writer itself can produce this. It must not cost the user their cover.
    expect(readCoverValue(`"![[att:${ID}|photo.png]]" # chosen 2026-08`)).toEqual({
      id: ID,
      filename: "photo.png",
    });
  });

  it("reads a filename containing a hash", () => {
    // The bare-scalar comment rule would cut this at the ` #`. The quoted
    // branch must win.
    expect(readCoverValue(`"![[att:${ID}|holiday #2.png]]"`)).toEqual({
      id: ID,
      filename: "holiday #2.png",
    });
  });

  it("reads a filename containing an escaped double quote", () => {
    expect(readCoverValue(`"![[att:${ID}|o\\"nemli.png]]"`)).toEqual({
      id: ID,
      filename: 'o"nemli.png',
    });
  });

  it("reads a filename carrying BOTH an escaped quote and a later hash", () => {
    // The combination, not either alone. The shared scalar extractor has no
    // notion of `\"`, so its non-greedy group closes on the ESCAPED quote and
    // the remaining ` #2.png]]"` satisfies its optional-comment tail, which
    // silently produced no cover at all. `cover:` is the first managed field
    // whose value can carry a filename, so it is the first that can hit this.
    expect(readCoverValue(`"![[att:${ID}|o\\" #2.png]]"`)).toEqual({
      id: ID,
      filename: 'o" #2.png',
    });
  });

  it("reads a filename carrying a backslash", () => {
    expect(readCoverValue(`"![[att:${ID}|a\\\\b.png]]"`)).toEqual({
      id: ID,
      filename: "a\\b.png",
    });
  });

  it("reads a hand-written unquoted embed", () => {
    expect(readCoverValue(`![[att:${ID}|photo.png]]`)).toEqual({
      id: ID,
      filename: "photo.png",
    });
  });

  it("reads an empty alias", () => {
    expect(readCoverValue(`"![[att:${ID}|]]"`)).toEqual({ id: ID, filename: "" });
  });
});

describe("readCoverValue — rejected forms", () => {
  const rejected: ReadonlyArray<readonly [string, string]> = [
    ["a boolean", "true"],
    ["a quoted boolean", '"true"'],
    ["a plain filename", "photo.png"],
    ["a bare attachment id", ID],
    ["a quoted bare attachment id", `"${ID}"`],
    ["a wikilink missing the embed bang", `"[[att:${ID}|photo.png]]"`],
    ["a note wikilink rather than an attachment", '"![[Some note]]"'],
    ["an embed with no alias divider", `"![[att:${ID}]]"`],
    ["two embeds", `"![[att:${ID}|a.png]] ![[att:${ID2}|b.png]]"`],
    ["an embed with leading prose", `"see ![[att:${ID}|a.png]]"`],
    ["an embed with trailing prose", `"![[att:${ID}|a.png]] (cover)"`],
    ["an uppercase-hex id", `"![[att:${"A".repeat(64)}|a.png]]"`],
    ["a short id", `"![[att:${"a".repeat(63)}|a.png]]"`],
    ["a long id", `"![[att:${"a".repeat(65)}|a.png]]"`],
    ["a non-hex id", `"![[att:${"g".repeat(64)}|a.png]]"`],
    ["an empty value", ""],
    ["whitespace only", "   "],
    ["a block scalar", "|"],
  ];

  for (const [label, value] of rejected) {
    it(`rejects ${label}`, () => {
      expect(readCoverValue(value)).toBeNull();
    });
  }
});

describe("readCoverFromFmBody", () => {
  it("finds the field among other managed fields", () => {
    const body = [
      "title: Roadmap",
      "folder: Projects/",
      `cover: "![[att:${ID}|photo.png]]"`,
      "updated: 2026-08-15T10:00:00Z",
    ].join("\n");
    expect(readCoverFromFmBody(body)).toEqual({ id: ID, filename: "photo.png" });
  });

  it("returns null when the field is absent", () => {
    expect(readCoverFromFmBody("title: Roadmap\nfolder: Projects/")).toBeNull();
  });

  it("returns null for a present but invalid value, rather than falling through to a later line", () => {
    // First-line-wins: a second, valid `cover:` must NOT rescue an invalid
    // first one, or the field's value depends on read order.
    const body = ["cover: true", `cover: "![[att:${ID}|photo.png]]"`].join("\n");
    expect(readCoverFromFmBody(body)).toBeNull();
  });

  it("does not match a key that merely starts with cover", () => {
    expect(readCoverFromFmBody(`cover_note: "![[att:${ID}|a.png]]"`)).toBeNull();
  });
});

describe("importer reject list", () => {
  it("carries cover, so an imported note cannot forge Myne's cover state", () => {
    expect(MANAGED_FRONTMATTER_FIELDS).toContain("cover");
  });
});
