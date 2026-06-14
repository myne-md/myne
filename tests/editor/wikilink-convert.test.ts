// R2 conversion engine (MYND-84) — planning is pure over (body, note-set).
// Asserts the emitted §3 bytes precisely (shared contract with the picker WL-4).

import { describe, it, expect } from "vitest";
import {
  planWikilinkConversion,
  convertedLink,
  type ConversionRow,
} from "../../src/editor/wikilink/convert";
import type { ResolverNote } from "../../src/notes/resolveWikilink";
import type { WikilinkRef } from "../../src/dialect/types";

const note = (
  noteUuid: string,
  title: string | null,
  folder: string | null,
): ResolverNote => ({ noteUuid, title, folder });

const ref = (over: Partial<WikilinkRef>): WikilinkRef => ({
  raw: "",
  byteRange: { start: 0, end: 0 },
  embed: false,
  target: "",
  targetKind: "title",
  alias: null,
  heading: null,
  blockId: null,
  ...over,
});

const kinds = (rows: ConversionRow[]) => rows.map((r) => r.kind);

describe("convertedLink (§8.2 alias/anchor preservation)", () => {
  it("anchor-free → byte-identical to the WL-4 emitter", () => {
    expect(convertedLink(note("a", "Wednesday", "notes/2025/"), ref({}))).toBe(
      "[[notes/2025/Wednesday.md|Wednesday]]",
    );
  });
  it("keeps an existing alias", () => {
    expect(convertedLink(note("a", "Foo", "Projects/"), ref({ alias: "My Foo" }))).toBe(
      "[[Projects/Foo.md|My Foo]]",
    );
  });
  it("carries a #heading onto the path form", () => {
    expect(convertedLink(note("a", "Foo", null), ref({ heading: "Intro" }))).toBe(
      "[[Foo.md#Intro|Foo]]",
    );
  });
  it("carries a ^block onto the path form", () => {
    expect(convertedLink(note("a", "Foo", null), ref({ blockId: "abc123" }))).toBe(
      "[[Foo.md^abc123|Foo]]",
    );
  });
});

describe("planWikilinkConversion (§7.1)", () => {
  const notes = [
    note("a", "Wednesday", "notes/2025/"),
    note("b", "Foo", "Projects/"),
    note("c", "Foo", "Archive/"),
  ];

  it("rewrites a single-match title-only link", () => {
    const rows = planWikilinkConversion("see [[Wednesday]] today", notes);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "rewrite",
      before: "[[Wednesday]]",
      after: "[[notes/2025/Wednesday.md|Wednesday]]",
    });
  });

  it("preserves alias + heading through the rewrite", () => {
    const rows = planWikilinkConversion("[[Wednesday|Hump day]] and [[Wednesday#Plan]]", notes);
    expect(rows[0]).toMatchObject({ after: "[[notes/2025/Wednesday.md|Hump day]]" });
    expect(rows[1]).toMatchObject({ after: "[[notes/2025/Wednesday.md#Plan|Wednesday]]" });
  });

  it("classifies an ambiguous title as 'ambiguous' with candidates", () => {
    const rows = planWikilinkConversion("[[Foo]]", notes);
    expect(rows[0]?.kind).toBe("ambiguous");
    if (rows[0]?.kind === "ambiguous") {
      expect(rows[0].candidates.map((n) => n.noteUuid).sort()).toEqual(["b", "c"]);
    }
  });

  it("skips a no-match link", () => {
    const rows = planWikilinkConversion("[[Nope]]", notes);
    expect(rows[0]).toMatchObject({ kind: "skipped", reason: "no match" });
  });

  it("is idempotent: path-form + embeds produce NO row", () => {
    const rows = planWikilinkConversion(
      "[[notes/2025/Wednesday.md|Wednesday]] and ![[Wednesday]] and ![[image.png]]",
      notes,
    );
    expect(rows).toHaveLength(0);
  });

  it("orders rows by document position", () => {
    const rows = planWikilinkConversion("[[Nope]] then [[Wednesday]]", notes);
    expect(kinds(rows)).toEqual(["skipped", "rewrite"]);
  });
});
