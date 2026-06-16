// Async half of the unlinked-mentions engine (MYND-196): `verifyMentionCandidates`
// + the `findUnlinkedMentions` composition. Mocks the impure seams (`backlinks`,
// `noteRead`, `searchNotes`, `extractFullText`) and pins the branches the pure
// matcher tests can't reach: the open-title floor short-circuit, the
// already-linked + open-note exclusion (which also feeds the df count), the
// decrypt-verify keep/drop, the read-failure drop, and BM25 rank preservation.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backlinksMock = vi.fn();
const noteReadMock = vi.fn();
const searchNotesMock = vi.fn();
const extractFullTextMock = vi.fn();

vi.mock("../../src/notes/vaultIndices", () => ({
  backlinks: (...a: unknown[]) => backlinksMock(...a),
}));
vi.mock("../../src/notes/readNote", () => ({
  noteRead: (...a: unknown[]) => noteReadMock(...a),
}));
vi.mock("../../src/notes/searchNotes", () => ({
  searchNotes: (...a: unknown[]) => searchNotesMock(...a),
}));
vi.mock("../../src/dialect/visitors/fullText", () => ({
  extractFullText: (...a: unknown[]) => extractFullTextMock(...a),
}));

import {
  findUnlinkedMentions,
  verifyMentionCandidates,
} from "../../src/notes/unlinkedMentions";
import type { ResolverNote } from "../../src/notes/resolveWikilink";
import type { NoteSearchResult } from "../../src/types/note-search-result";

const hit = (note_id: string, title = note_id): NoteSearchResult => ({
  note_id,
  title,
  score: 1,
  matched_in: { title: false, body: true },
});

const note = (noteUuid: string, title: string | null = noteUuid): ResolverNote => ({
  noteUuid,
  title,
  folder: null,
});

beforeEach(() => {
  backlinksMock.mockReset().mockResolvedValue([]);
  // By default each candidate body contains the open title as a whole word so
  // the word-boundary verify keeps it; tests override per case.
  noteReadMock.mockReset().mockImplementation((id: string) => Promise.resolve(id));
  searchNotesMock.mockReset().mockResolvedValue([]);
  // Default: the decrypted "body" IS the open title, so the fold match keeps it.
  extractFullTextMock.mockReset().mockImplementation((b: string) => b);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("verifyMentionCandidates", () => {
  it("returns [] when the open title is below the min folded-char floor", async () => {
    const out = await verifyMentionCandidates("open", "Hi", [], [hit("a")]);
    expect(out).toEqual([]);
    expect(noteReadMock).not.toHaveBeenCalled(); // short-circuits before any read
  });

  it("keeps a candidate whose body contains the title as a whole word", async () => {
    extractFullTextMock.mockReturnValue("read about Apollo today");
    const out = await verifyMentionCandidates(
      "open",
      "Apollo",
      [note("open", "Apollo")],
      [hit("c1", "Doc One")],
    );
    expect(out).toEqual([{ noteId: "c1", title: "Doc One" }]);
  });

  it("drops a candidate whose body does NOT contain the title (word-boundary)", async () => {
    extractFullTextMock.mockReturnValue("a reindex pass, no mention");
    const out = await verifyMentionCandidates(
      "open",
      "Index",
      [note("open", "Index")],
      [hit("c1")],
    );
    expect(out).toEqual([]);
  });

  it("excludes the open note itself and notes already linking it (before any read)", async () => {
    backlinksMock.mockResolvedValue([{ sourceUuid: "linker", occurrences: [] }]);
    extractFullTextMock.mockReturnValue("Apollo");
    const out = await verifyMentionCandidates(
      "open",
      "Apollo",
      [note("open", "Apollo"), note("linker"), note("c1")],
      [hit("open"), hit("linker"), hit("c1", "Survivor")],
    );
    expect(out).toEqual([{ noteId: "c1", title: "Survivor" }]);
    // The open note + the linked note never paid a decrypt read.
    expect(noteReadMock).toHaveBeenCalledTimes(1);
    expect(noteReadMock).toHaveBeenCalledWith("c1");
  });

  it("drops just the candidate whose read throws (transient failure isolation)", async () => {
    extractFullTextMock.mockReturnValue("Apollo");
    noteReadMock.mockImplementation((id: string) =>
      id === "boom" ? Promise.reject(new Error("io")) : Promise.resolve(id),
    );
    const out = await verifyMentionCandidates(
      "open",
      "Apollo",
      [note("open", "Apollo")],
      [hit("ok1", "First"), hit("boom", "Bad"), hit("ok2", "Second")],
    );
    expect(out.map((m) => m.noteId)).toEqual(["ok1", "ok2"]);
  });

  it("preserves BM25 rank order of the survivors", async () => {
    extractFullTextMock.mockReturnValue("Apollo");
    const out = await verifyMentionCandidates(
      "open",
      "Apollo",
      [note("open", "Apollo")],
      [hit("third"), hit("first"), hit("second")],
    );
    expect(out.map((m) => m.noteId)).toEqual(["third", "first", "second"]);
  });

  it("applies the df floor on the post-exclusion candidate count", async () => {
    // 20-note corpus, 4 surviving candidates → df 0.20 > 0.15 → suppressed.
    extractFullTextMock.mockReturnValue("Apollo");
    const notes = Array.from({ length: 20 }, (_, i) => note(`n${i}`, "Apollo"));
    const out = await verifyMentionCandidates(
      "open",
      "Apollo",
      notes,
      ["a", "b", "c", "d"].map((id) => hit(id)),
    );
    expect(out).toEqual([]);
    expect(noteReadMock).not.toHaveBeenCalled(); // floor gates before the reads
  });
});

describe("findUnlinkedMentions composition", () => {
  it("returns [] for a null open title without searching", async () => {
    const out = await findUnlinkedMentions("open", null, []);
    expect(out).toEqual([]);
    expect(searchNotesMock).not.toHaveBeenCalled();
  });

  it("returns [] for a too-short title without searching", async () => {
    const out = await findUnlinkedMentions("open", "Hi", []);
    expect(out).toEqual([]);
    expect(searchNotesMock).not.toHaveBeenCalled();
  });

  it("recalls via searchNotes(title) then verifies the candidates", async () => {
    searchNotesMock.mockResolvedValue([hit("c1", "Mentioner")]);
    extractFullTextMock.mockReturnValue("see Apollo notes");
    const out = await findUnlinkedMentions("open", "Apollo", [note("open", "Apollo")]);
    expect(searchNotesMock).toHaveBeenCalledWith("Apollo");
    expect(out).toEqual([{ noteId: "c1", title: "Mentioner" }]);
  });
});
