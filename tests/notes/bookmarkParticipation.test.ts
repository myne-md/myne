// url-bookmark task 6 — Saved-views / tags / backlinks participation
// (MYND-447, browser-extension epic, sub-feature 5 `url-bookmark`).
//
// WHAT THIS PINS
// --------------
// A bookmark note is an ORDINARY `.myn` note: a content-light body (the bare-
// autolink source URL) under a frontmatter block carrying a managed `title:`
// plus unmanaged provenance `source:` (the URL) + `clipped:` (an RFC-3339 date).
// The claim under verification is that such a note participates in the existing
// property index, saved views, tag index, and backlink graph FOR FREE — with NO
// new index schema, NO bespoke source-URL reverse-index, and NO bookmark-shaped
// code path. These assertions PROVE that claim by exercising the REAL functions
// over the REAL bookmark frontmatter produced by `composeBookmarkPlaintext`.
//
// The four claims, each pinned below:
//   1. The §3.6.4 derived property index (`extractProperties`/`coerceValue`)
//      coerces every arbitrary key — so `source:` types as `string` and
//      `clipped:` types as `date`, with no new typing rule.
//   2. A saved view can filter on `source:` ("everything from this domain") and
//      on `clipped:` ("clipped this month") via the closed property-leaf
//      allow-list (`evaluateFilter` + `comparePropertyValue`).
//   3. An inline `#tag` added to a bookmark, and an inbound `[[wikilink]]`
//      linking it by its managed title, are surfaced by the shared dialect
//      `parse()` — the exact inputs the tag index + backlink graph consume.
//   4. Moving a bookmark into a folder via the normal `folder:` mechanics is the
//      ordinary `inFolder` leaf — no bookmark-specific folder path.

import { describe, expect, it, vi } from "vitest";
import { composeBookmarkPlaintext } from "../../src/clip/composeBookmarkPlaintext";
import { parse, patchFrontmatterField } from "../../src/dialect";
import { coerceValue, extractProperties } from "../../src/notes/propertyTyping";
import {
  comparePropertyValue,
  evaluateFilter,
  type FilterNode,
  type LeafResolvers,
  type StoredProperty,
} from "../../src/notes/queryEngine";

const dec = new TextDecoder();

/** Produce a realistic bookmark note plaintext via the REAL composer, so every
 *  assertion below exercises the actual on-disk bookmark frontmatter shape
 *  (`title:` + `source:` + `clipped:`), not a hand-rolled approximation. */
function bookmarkNote(
  url: string,
  title: string,
  clippedDate: string,
): string {
  return composeBookmarkPlaintext({ url, title, clippedDate });
}

/** The raw YAML frontmatter text of a note (what the property index extracts
 *  from). `parse().frontmatter.raw` is the verbatim block between the `---`
 *  fences — exactly what `extractProperties` consumes on the wire. */
function rawFrontmatter(plaintext: string): string {
  const raw = parse(plaintext).frontmatter.raw;
  if (raw === null) throw new Error(`no frontmatter in:\n${plaintext}`);
  return raw;
}

/** The typed property index contribution of a note, keyed for direct lookup. */
function typedByKey(plaintext: string): Record<string, StoredProperty> {
  const entries = extractProperties(rawFrontmatter(plaintext));
  return Object.fromEntries(
    entries.map((e) => [e.key, e as unknown as StoredProperty]),
  );
}

// ---------------------------------------------------------------------------
// Claim 1 — the derived property index types a bookmark's frontmatter for free.
// ---------------------------------------------------------------------------

describe("bookmark property typing — source→string, clipped→date (§3.6.4, no new schema)", () => {
  it("types a real composed bookmark's frontmatter via the generic coercion", () => {
    const note = bookmarkNote(
      "https://blog.example.com/posts/2026/06/whatever",
      "Some Article",
      "2026-06-18T12:00:00.000Z",
    );
    const byKey = typedByKey(note);

    // The managed title is an ordinary string property (observed, not excluded).
    expect(byKey.title).toMatchObject({ type: "string", value: "Some Article" });
    // The unmanaged provenance keys: source is a URL string; clipped is a date.
    expect(byKey.source).toMatchObject({
      type: "string",
      value: "https://blog.example.com/posts/2026/06/whatever",
    });
    expect(byKey.clipped).toMatchObject({
      type: "date",
      value: "2026-06-18T12:00:00.000Z",
    });
    // No bespoke source-URL index: source is typed by the SAME path as any key.
    expect(coerceValue("https://blog.example.com/posts/2026/06/whatever")).toEqual({
      type: "string",
      value: "https://blog.example.com/posts/2026/06/whatever",
    });
  });

  it("clipped types as date whether it is a full-date or a date-time RFC-3339 value", () => {
    // A full-date `clipped:` (the "clipped this month" granularity).
    const dayNote = bookmarkNote("https://x.test/a", "A", "2026-06-18");
    expect(typedByKey(dayNote).clipped).toMatchObject({
      type: "date",
      value: "2026-06-18",
    });
    // A date-time `clipped:` (what the desktop composer emits today).
    const tsNote = bookmarkNote("https://x.test/b", "B", "2026-06-18T09:30:00Z");
    expect(typedByKey(tsNote).clipped).toMatchObject({
      type: "date",
      value: "2026-06-18T09:30:00Z",
    });
  });
});

// ---------------------------------------------------------------------------
// Claim 2 — a saved view filters on source: and clipped: with no new machinery.
// ---------------------------------------------------------------------------

/** Fake leaf resolvers backed by the typed property entries of a set of notes —
 *  the production `propertyValues` accessor reads exactly this shape from the
 *  encrypted property index (#1). The evaluator does NO re-typing (SYNC-2). */
function resolversFromNotes(
  notes: Record<string, string>,
): LeafResolvers {
  const propertyValues = (
    key: string,
  ): Array<readonly [string, StoredProperty]> => {
    const out: Array<readonly [string, StoredProperty]> = [];
    for (const [id, plaintext] of Object.entries(notes)) {
      const sp = typedByKey(plaintext)[key];
      if (sp !== undefined) out.push([id, sp] as const);
    }
    return out;
  };
  return {
    hasTag: vi.fn(async () => []),
    inFolder: vi.fn(async () => []),
    search: vi.fn(async () => []),
    titleMatch: vi.fn(async () => []),
    hasTask: vi.fn(async () => []),
    propertyValues: vi.fn(async (key: string) => propertyValues(key)),
  };
}

describe("bookmark saved-view filter — selects on source: and clipped: (closed property leaf)", () => {
  // A small vault: two bookmarks from example.com, one from elsewhere, plus a
  // plain (non-bookmark) note that carries no source:/clipped: keys.
  const notes: Record<string, string> = {
    bm_a: bookmarkNote("https://example.com/one", "One", "2026-06-05T08:00:00Z"),
    bm_b: bookmarkNote("https://example.com/two", "Two", "2026-06-20T08:00:00Z"),
    bm_other: bookmarkNote("https://other.test/x", "Other", "2026-06-10T08:00:00Z"),
    plain: "---\ntitle: Just A Note\n---\n\nbody\n",
  };
  const live = new Set(Object.keys(notes));

  it("filters on source: — 'everything from this domain'", async () => {
    const r = resolversFromNotes(notes);
    // contains is folded substring on a string property — domain membership.
    const node: FilterNode = {
      kind: "property",
      key: "source",
      op: "contains",
      value: "example.com",
    };
    const ids = await evaluateFilter(node, live, r);
    expect([...ids].sort()).toEqual(["bm_a", "bm_b"]);
    // The plain note carries no source: key → it is never in the property set.
    expect(ids).not.toContain("plain");
    expect(ids).not.toContain("bm_other");
  });

  it("filters on clipped: — 'clipped this month' (date range on a date property)", async () => {
    const r = resolversFromNotes(notes);
    // June 2026: clipped >= 2026-06-01 AND clipped < 2026-07-01. Date leaves
    // compare by instant (full-date operand = midnight UTC), SYNC-9.
    const node: FilterNode = {
      kind: "and",
      children: [
        { kind: "property", key: "clipped", op: ">=", value: "2026-06-01" },
        { kind: "property", key: "clipped", op: "<", value: "2026-07-01" },
      ],
    };
    const ids = await evaluateFilter(node, live, r);
    // All three bookmarks were clipped in June; the plain note has no clipped:.
    expect([...ids].sort()).toEqual(["bm_a", "bm_b", "bm_other"]);

    // A tighter window (after the 15th) selects only the later-clipped bookmark.
    const lateNode: FilterNode = {
      kind: "property",
      key: "clipped",
      op: ">",
      value: "2026-06-15",
    };
    const lateIds = await evaluateFilter(lateNode, live, r);
    expect([...lateIds].sort()).toEqual(["bm_b"]);
  });

  it("composes source + clipped into one saved-view filter (domain ∧ this month)", async () => {
    const r = resolversFromNotes(notes);
    const node: FilterNode = {
      kind: "and",
      children: [
        { kind: "property", key: "source", op: "contains", value: "example.com" },
        { kind: "property", key: "clipped", op: ">=", value: "2026-06-01" },
        { kind: "property", key: "clipped", op: "<", value: "2026-07-01" },
      ],
    };
    expect([...(await evaluateFilter(node, live, r))].sort()).toEqual([
      "bm_a",
      "bm_b",
    ]);
  });

  it("the typed comparison itself matches the bookmark's stored source/clipped", () => {
    const byKey = typedByKey(notes.bm_b);
    // source (string) — folded-substring domain match + exact equality.
    expect(comparePropertyValue(byKey.source, "contains", "example.com")).toBe(true);
    expect(comparePropertyValue(byKey.source, "contains", "github.com")).toBe(false);
    // clipped (date) — instant comparison against a full-date operand.
    expect(comparePropertyValue(byKey.clipped, ">=", "2026-06-01")).toBe(true);
    expect(comparePropertyValue(byKey.clipped, "<", "2026-07-01")).toBe(true);
    expect(comparePropertyValue(byKey.clipped, "<", "2026-06-01")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Claim 3 — an added #tag + an inbound [[wikilink]] feed the tag/backlink graph.
// ---------------------------------------------------------------------------

describe("bookmark tag + backlink participation — ordinary dialect surfaces", () => {
  it("an inline #tag added to a bookmark is surfaced by parse().inlineTags", () => {
    // A user appends a tag to the bookmark body — the same affordance any note
    // has. (The body already holds the bare-autolink URL; the tag rides below.)
    const note =
      bookmarkNote("https://example.com/p", "Cool Post", "2026-06-18T12:00:00.000Z") +
      "\n#reading\n";
    const tags = parse(note).inlineTags.map((t) => t.tag);
    // `tag` is the verbatim source minus the leading `#`; the index layer folds.
    expect(tags).toContain("reading");
    // Nothing bookmark-specific: the tag is in the body, outside the frontmatter,
    // exactly where the tag index reads it for ANY note.
    expect(parse(note).frontmatter.error).toBeNull();
  });

  it("an inbound [[wikilink]] to the bookmark's title is surfaced by parse().wikilinks", () => {
    // The bookmark has a real managed title (not "Untitled"), so it is a
    // first-class wikilink target. Another note links it by that title.
    const inbound = "---\ntitle: Reading List\n---\n\nSee [[Cool Post]] for details.\n";
    const links = parse(inbound).wikilinks;
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      target: "Cool Post",
      targetKind: "title",
      embed: false,
    });
    // This is the exact (sourceNote → targetTitle) edge the backlink graph
    // resolves; resolution + panel shaping (backlinkRows) are unchanged.
  });

  it("a bookmark can both carry tags AND be a wikilink target (full graph citizen)", () => {
    const note =
      bookmarkNote("https://example.com/p", "Cool Post", "2026-06-18T12:00:00.000Z") +
      "\n#reading #later\n";
    const parsed = parse(note);
    expect(parsed.inlineTags.map((t) => t.tag).sort()).toEqual(["later", "reading"]);
    // Its own outbound links (none here) and inbound links are ordinary edges.
    expect(parsed.wikilinks).toEqual([]);
    expect(parsed.frontmatter.parsed?.title).toBe("Cool Post");
  });
});

// ---------------------------------------------------------------------------
// Claim 4 — moving a bookmark into a folder is the ordinary folder: mechanism.
// ---------------------------------------------------------------------------

describe("bookmark folder participation — ordinary folder: frontmatter + inFolder leaf", () => {
  it("adding a folder: key files the bookmark with no bookmark-specific path", async () => {
    // A bookmark lands at the root (SYNC-15, no folder: line). Moving it is the
    // generic arbitrary-FM injector writing folder: — the same writer renameNote
    // and drag-to-folder use. (We exercise patchFrontmatterField directly here;
    // production routes through the move command, but the on-disk shape is this.)
    const root = bookmarkNote(
      "https://example.com/p",
      "Cool Post",
      "2026-06-18T12:00:00.000Z",
    );
    // Root bookmark carries no folder: line.
    expect(root).not.toMatch(/^\s*folder\s*:/m);

    const enc = new TextEncoder();
    const filed = dec.decode(
      patchFrontmatterField(enc.encode(root), "folder", "Reading/"),
    );
    expect(parse(filed).frontmatter.parsed?.folder).toBe("Reading/");

    // The folder is now an ordinary frontmatter key the folder tree + inFolder
    // leaf consume; the property index also observes it (managed-field semantics).
    const byKey = typedByKey(filed);
    expect(byKey.folder).toMatchObject({ type: "string", value: "Reading/" });

    // The inFolder leaf selects the filed bookmark exactly like any note —
    // resolvers.inFolder is the injected folder-subtree accessor (#2).
    const r: LeafResolvers = {
      hasTag: vi.fn(async () => []),
      inFolder: vi.fn(async (path: string) =>
        path === "Reading/" ? ["bm"] : [],
      ),
      search: vi.fn(async () => []),
      titleMatch: vi.fn(async () => []),
      hasTask: vi.fn(async () => []),
      propertyValues: vi.fn(async () => []),
    };
    const ids = await evaluateFilter(
      { kind: "inFolder", path: "Reading/" },
      new Set(["bm"]),
      r,
    );
    expect(ids).toEqual(["bm"]);
  });
});
