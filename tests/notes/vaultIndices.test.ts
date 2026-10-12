// VaultIndices wrappers (MYND-31 / MYND-197): the PURE classification +
// resolution helpers (`isMediaTarget`, `extractTags`, `extractWikilinkEdges`,
// `resolveEdges`, `resolveTitle`) plus the IPC-backed `backlinks` / `byTag`
// trash-exclusion paths. The Tauri `invoke` seam is mocked.

import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  isMediaTarget,
  extractTags,
  extractWikilinkEdges,
  resolveEdges,
  resolveTitle,
  backlinks,
  byTag,
  reindexNoteFromBody,
  type WikilinkEdge,
} from "../../src/notes/vaultIndices";
import type {
  ParseResult,
  WikilinkRef,
  InlineTagRef,
} from "../../src/dialect/types";
import type { ResolverNote } from "../../src/notes/resolveWikilink";

afterEach(() => invokeMock.mockReset());

function note(uuid: string, title: string | null, folder: string | null = null): ResolverNote {
  return { noteUuid: uuid, title, folder };
}

function wikilink(over: Partial<WikilinkRef> = {}): WikilinkRef {
  return {
    raw: "[[X]]",
    byteRange: { start: 0, end: 5 },
    embed: false,
    target: "X",
    targetKind: "title",
    alias: null,
    heading: null,
    blockId: null,
    ...over,
  };
}

function inlineTag(tag: string): InlineTagRef {
  return { raw: `#${tag}`, tag, byteRange: { start: 0, end: tag.length + 1 } };
}

function parseResult(over: Partial<ParseResult> = {}): ParseResult {
  return {
    frontmatter: { raw: null, parsed: null, byteRange: null, error: null },
    headings: [],
    wikilinks: [],
    inlineTags: [],
    mediaRefs: [],
    fullText: "",
    errors: [],
    ...over,
  };
}

describe("isMediaTarget", () => {
  it("flags known media extensions (case-insensitive)", () => {
    expect(isMediaTarget("image.png")).toBe(true);
    expect(isMediaTarget("clip.MP4")).toBe(true);
    expect(isMediaTarget("dir/sub/a.JPEG")).toBe(true);
  });

  it("does NOT flag dotted note titles (whitelist, not any-non-md)", () => {
    // The WHITELIST guarantee: `[[2024.review]]` / `[[v0.1]]` are notes.
    expect(isMediaTarget("2024.review")).toBe(false);
    expect(isMediaTarget("v0.1")).toBe(false);
    expect(isMediaTarget("Plain Note")).toBe(false);
  });
});

describe("extractWikilinkEdges", () => {
  it("skips media EMBEDS but keeps a plain media-named link", () => {
    const edges = extractWikilinkEdges([
      wikilink({ target: "pic.png", embed: true }), // media embed → dropped
      wikilink({ target: "pic.png", embed: false }), // plain link → kept (E2)
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.target).toBe("pic.png");
    expect(edges[0]!.embed).toBe(false);
  });

  it("keeps a NOTE embed (`![[Note]]`) as an edge flagged embed", () => {
    const edges = extractWikilinkEdges([wikilink({ target: "Note", embed: true })]);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.embed).toBe(true);
  });

  it("carries anchor / alias / blockId / byte range verbatim and folds titleKey", () => {
    const edges = extractWikilinkEdges([
      wikilink({
        target: "Çay",
        heading: "Heading",
        alias: "shown",
        blockId: "blk",
        byteRange: { start: 3, end: 17 },
      }),
    ]);
    const e = edges[0]!;
    expect(e.anchor).toBe("Heading");
    expect(e.alias).toBe("shown");
    expect(e.blockId).toBe("blk");
    expect(e.byteStart).toBe(3);
    expect(e.byteEnd).toBe(17);
    // titleKey is the folded title — same fold the resolver uses.
    expect(e.titleKey).toBe(e.titleKey.toLowerCase());
    expect(e.titleKey.length).toBeGreaterThan(0);
  });
});

describe("extractTags", () => {
  it("unions inline tags with frontmatter tags, dedups by folded key", () => {
    const tags = extractTags(
      parseResult({
        inlineTags: [inlineTag("Work"), inlineTag("work")], // fold-dup → one
        frontmatter: {
          raw: "x",
          parsed: { tags: ["Project", 1984], tag: "Solo" },
          byteRange: null,
          error: null,
        },
      }),
    );
    const folded = tags.map((t) => t.folded).sort();
    // "Work"/"work" collapse; numeric 1984 coerced; single `tag:` scalar joins.
    expect(folded).toEqual(["1984", "project", "solo", "work"]);
    // first display wins for the folded "work" bucket.
    expect(tags.find((t) => t.folded === "work")!.display).toBe("Work");
  });

  it("ignores blank/whitespace tags and a null frontmatter", () => {
    const tags = extractTags(
      parseResult({
        inlineTags: [inlineTag("  ")],
        frontmatter: { raw: null, parsed: null, byteRange: null, error: null },
      }),
    );
    expect(tags).toEqual([]);
  });
});

describe("resolveEdges (pure resolution against the note-set)", () => {
  const notes = [note("a", "Alpha"), note("b", "Beta")];

  it("marks an unmatched target broken and a matched one resolved", () => {
    const edges: WikilinkEdge[] = [
      { ...wikilink(), target: "Beta", titleKey: "beta", anchor: null, blockId: null, alias: null, embed: false, byteStart: 0, byteEnd: 0, targetKind: "title" },
      { ...wikilink(), target: "Ghost", titleKey: "ghost", anchor: null, blockId: null, alias: null, embed: false, byteStart: 0, byteEnd: 0, targetKind: "title" },
    ];
    const out = resolveEdges(edges, notes);
    expect(out[0]!.resolution.status).toBe("resolved");
    expect(out[0]!.resolution.status === "resolved" && out[0]!.resolution.noteUuid).toBe("b");
    expect(out[1]!.resolution.status).toBe("broken");
  });
});

describe("resolveTitle", () => {
  const notes = [note("a", "Alpha", "Work/"), note("b", "Alpha", "Home/")];

  it("resolves a unique title with no folder hint", () => {
    const res = resolveTitle("Beta", null, [note("c", "Beta")]);
    expect(res.status).toBe("resolved");
  });

  it("uses the folder hint to disambiguate a title collision", () => {
    const res = resolveTitle("Alpha", "Home/", notes);
    expect(res.status === "resolved" && res.noteUuid).toBe("b");
    expect(res.status === "resolved" && res.ambiguous).toBe(false);
  });

  it("flags ambiguous when the collision can't be disambiguated", () => {
    const res = resolveTitle("Alpha", null, notes);
    expect(res.status === "resolved" && res.ambiguous).toBe(true);
    expect(res.status === "resolved" && res.matchCount).toBe(2);
  });

  it("returns broken for an unknown title", () => {
    expect(resolveTitle("Nope", null, notes).status).toBe("broken");
  });
});

describe("byTag (Rust trash-blind index + TS liveIds filter)", () => {
  it("returns the raw ids when no liveIds set is provided", async () => {
    invokeMock.mockResolvedValueOnce(["a", "b", "c"]);
    expect(await byTag("Work")).toEqual(["a", "b", "c"]);
    // tag is folded before the call (write-fold == query-fold).
    expect(invokeMock).toHaveBeenCalledWith(
      "plugin:vault-indices|vault_indices_by_tag",
      { foldedTag: "work" },
    );
  });

  it("filters out ids absent from the liveIds set (T3 trash exclusion)", async () => {
    invokeMock.mockResolvedValueOnce(["a", "b", "c"]);
    const live = new Set(["a", "c"]);
    expect(await byTag("Work", live)).toEqual(["a", "c"]);
  });
});

describe("backlinks (resolve-then-keep, trash exclusion, grouping)", () => {
  it("returns [] for an untitled target without an IPC round-trip", async () => {
    const notes = [note("a", null)];
    expect(await backlinks("a", notes)).toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("keeps only candidates that resolve to the target, grouped by source", async () => {
    const notes = [note("t", "Target"), note("s1", "Src1"), note("s2", "Src2")];
    const edge = (over: Partial<WikilinkEdge> = {}): WikilinkEdge => ({
      target: "Target",
      targetKind: "title",
      titleKey: "target",
      anchor: null,
      blockId: null,
      alias: null,
      embed: false,
      byteStart: 0,
      byteEnd: 0,
      ...over,
    });
    invokeMock.mockResolvedValueOnce([
      { source: "s1", edge: edge() },
      { source: "s1", edge: edge({ byteStart: 10 }) }, // second occurrence, same source
      { source: "s2", edge: edge() },
    ]);
    const groups = await backlinks("t", notes);
    expect(groups.map((g) => g.sourceUuid).sort()).toEqual(["s1", "s2"]);
    const s1 = groups.find((g) => g.sourceUuid === "s1")!;
    expect(s1.occurrences).toHaveLength(2);
    expect(s1.sourceTitle).toBe("Src1");
  });

  it("drops a candidate whose source is not in the live (non-trashed) set", async () => {
    // s-trashed is a backlink candidate but absent from the resolver note-set
    // (the live set), so it is excluded — Rust index stays trash-blind.
    const notes = [note("t", "Target"), note("s-live", "Live")];
    const edge: WikilinkEdge = {
      target: "Target",
      targetKind: "title",
      titleKey: "target",
      anchor: null,
      blockId: null,
      alias: null,
      embed: false,
      byteStart: 0,
      byteEnd: 0,
    };
    invokeMock.mockResolvedValueOnce([
      { source: "s-trashed", edge },
      { source: "s-live", edge },
    ]);
    const groups = await backlinks("t", notes);
    expect(groups.map((g) => g.sourceUuid)).toEqual(["s-live"]);
  });
});

// The seam between the dialect extractor and the index. Both ends were covered
// before this suite existed — `tests/notes/taskIndex.test.ts` for what the
// extractor produces, the Rust `state.rs` tests for what the index stores — and
// the call BETWEEN them was not, which is exactly the gap line-tasks shipped
// through: `reindexNoteFromBody` never invoked the extractor, `tasks` never
// reached the payload, and Rust's `Option` field turned the omission into an
// empty vector rather than an error. Every task surface read an empty index and
// no layer could tell it was broken. These assertions are about the WIRE, not
// about extraction — they fail if the field ever stops being sent.
describe("reindexNoteFromBody → the tasks leg of the apply payload", () => {
  function applyPayload(): Record<string, unknown> {
    const call = invokeMock.mock.calls.find(
      ([command]) => command === "plugin:vault-indices|vault_indices_apply",
    );
    expect(call, "vault_indices_apply was never invoked").toBeDefined();
    return call![1] as Record<string, unknown>;
  }

  it("carries every line-task, in document order, with its typed fields", async () => {
    await reindexNoteFromBody(
      "n1",
      [
        "# Ev",
        "",
        "- [ ] kirayı öde [due:: 2026-08-01] [repeat:: every month] [priority:: high]",
        "- [x] faturayı öde [done:: 2026-07-29]",
      ].join("\n"),
    );

    const tasks = applyPayload().tasks as Array<Record<string, unknown>>;
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({
      lineIndex: 2,
      completed: false,
      due: "2026-08-01",
      repeat: "every month",
      priority: "high",
    });
    // The raw line is the authority the pre-write verification compares
    // against, so it must survive verbatim — not normalized, not re-emitted.
    expect(tasks[0]!.rawLine).toBe(
      "- [ ] kirayı öde [due:: 2026-08-01] [repeat:: every month] [priority:: high]",
    );
    expect(tasks[1]).toMatchObject({ lineIndex: 3, completed: true, done: "2026-07-29" });
  });

  it("sends an empty vector for a note with no tasks, never an absent field", async () => {
    // `apply` has replace semantics: deleting a note's last task must overwrite
    // the stored vector. Omitting the field would lean on Rust's
    // `unwrap_or_default()` to mean the same thing — true today, and exactly
    // the kind of implicit agreement that broke this leg in the first place.
    await reindexNoteFromBody("n2", "# Ev\n\nsade bir not, task yok\n");
    expect(applyPayload().tasks).toEqual([]);
  });

  it("yields nothing for a drawing note, whose body is scene JSON", async () => {
    // A `- [ ]` inside serialized scene JSON is a phantom task. The extractor
    // skips drawing-class notes wholesale; asserting it here keeps the wire
    // honest if that exclusion ever moves.
    await reindexNoteFromBody("n3", '---\nkind: drawing\n---\n- [ ] phantom\n');
    expect(applyPayload().tasks).toEqual([]);
  });
});

// myne-md/myne#848: the working-set verdict reaches the index, so the agent's
// scope can be the list the sidebar shows rather than a second reader of the
// marker set. Same shape as the task leg above, and for the same reason: the
// failure is a field that stops being sent, which Rust's `Option` turns into
// "live" rather than into an error.
describe("reindexNoteFromBody → the working-set (`live`) leg of the apply payload", () => {
  function applyPayload(): Record<string, unknown> {
    const call = invokeMock.mock.calls.find(
      ([command]) => command === "plugin:vault-indices|vault_indices_apply",
    );
    expect(call, "vault_indices_apply was never invoked").toBeDefined();
    return call![1] as Record<string, unknown>;
  }

  it("sends live: true for an ordinary note", async () => {
    await reindexNoteFromBody("n1", "# Ev\n\nsade bir not\n");
    expect(applyPayload().live).toBe(true);
  });

  it("sends live: false for every marker the sidebar's predicate excludes", async () => {
    const cases: Array<[string, string]> = [
      ["trashed", "---\ntrashed: 2026-08-01T00:00:00Z\n---\nbody\n"],
      ["deleted", "---\ndeleted: 2026-08-01T00:00:00Z\n---\nbody\n"],
      ["archived", "---\narchived: 2026-08-01T00:00:00Z\n---\nbody\n"],
      ["template", "---\ntemplate: true\n---\nbody\n"],
      // `conflict:` is the axis a predicate reading only `trashed:` misses,
      // which is the class of bug this leg exists to close.
      ["conflict", "---\nconflict: true\n---\nbody\n"],
    ];
    for (const [name, body] of cases) {
      invokeMock.mockClear();
      await reindexNoteFromBody(name, body);
      expect(applyPayload().live, `${name} must be outside the working set`).toBe(false);
    }
  });

  it("is value-strict, not a marker-key match", async () => {
    // `readTrashedFromFmBody` returns null for a malformed timestamp, so a note
    // carrying `trashed: 2026-13-45T99:99:99Z` stays LIVE, the same answer the
    // sidebar gives it, because both read it through the one shared reader. A
    // hand-rolled producer matching the KEY would call this trashed and the two
    // views would disagree from that moment on.
    await reindexNoteFromBody("n9", "---\ntrashed: 2026-13-45T99:99:99Z\n---\nbody\n");
    expect(applyPayload().live).toBe(true);
  });
});
