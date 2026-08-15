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
import { patchFrontmatterField, readCoverFromFmBody, readCoverValue } from "@myne/dialect";
import { locateFrontmatter } from "../../src/dialect/lezer/frontmatter";
import { MANAGED_FRONTMATTER_FIELDS } from "../../src/dialect/managedFields";

const ID = "a".repeat(64);
const ID2 = "0123456789abcdef".repeat(4);


const encode = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);
/** The frontmatter BODY of a note, which is what `readCoverFromFmBody` takes. */
function fmBodyOf(source: string): string {
  const fm = locateFrontmatter(source);
  if (fm === null) return "";
  return source.slice(fm.bodyStart, fm.bodyEnd);
}

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

describe("a managed key is anchored to column zero, so a nested one is untouched", () => {
  // myne#321's bug class, on the one managed key most likely to be nested. The
  // twelve existing managed fields have anchored READERS, and `cover:` rides
  // the GENERIC writer, whose matcher was indent-tolerant. On the ordinary
  // Jekyll / Hugo / Obsidian-SEO shape below, "Add cover" rewrote the user's
  // nested value while the anchored reader still reported no cover: the banner
  // never appeared, the offer stayed, and every retry destroyed the value
  // again. "Remove cover" deleted their line outright.
  const NESTED = ["---", "title: Post", "seo:", "  cover: hero.jpg", "---", "", "body"].join("\n");

  it("writes a new top-level cover instead of editing the nested one", () => {
    const out = decode(
      patchFrontmatterField(encode(NESTED), "cover", '![[att:' + "a".repeat(64) + '|photo.png]]'),
    );
    expect(out).toContain("  cover: hero.jpg");
    expect(out).toContain('cover: "![[att:');
    // And the reader now sees the one the writer wrote.
    expect(readCoverFromFmBody(fmBodyOf(out))).not.toBeNull();
  });

  it("does not delete a nested cover when the note has none of its own", () => {
    const out = decode(patchFrontmatterField(encode(NESTED), "cover", null));
    expect(out).toContain("  cover: hero.jpg");
  });

  it("still edits an indented value for an UNMANAGED key, which is the tolerant case", () => {
    // The tolerance is right for an arbitrary user property, and narrowing it
    // for every key would be a different bug. Only managed keys are anchored.
    const src = ["---", "seo:", "  status: draft", "---", "", "b"].join("\n");
    const out = decode(patchFrontmatterField(encode(src), "status", "final"));
    expect(out).toContain("  status: final");
  });
});
