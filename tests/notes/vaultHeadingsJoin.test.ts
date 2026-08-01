// `joinVaultHeadings` — the join that turns trash-blind index rows into the
// `[[##` picker's set (myne#216).
//
// The join is where the picker's exclusion lives now. Before this change the
// heading set was derived by walking `useResolverNotes()` and reading each note
// body, so trashed and template notes were excluded by construction: they were
// never in the list being walked. The index has no such notion — it stores every
// note it is told about — so an exclusion that used to be structural is now a
// behaviour, and a behaviour needs a test.

import { describe, expect, it } from "vitest";
import { joinVaultHeadings } from "../../src/notes/useVaultHeadings";
import type { ResolverNote } from "../../src/notes/resolveWikilink";
import type { VaultHeadingRow } from "../../src/notes/vaultIndices";

const note = (noteUuid: string, title: string | null, folder: string | null = null): ResolverNote => ({
  noteUuid,
  title,
  folder,
  folderIndex: false,
  isDrawing: false,
});

const row = (noteId: string, text: string, level = 2): VaultHeadingRow => ({
  noteId,
  text,
  level,
});

describe("joinVaultHeadings", () => {
  it("attaches each row's note title and folder from the resident set", () => {
    const rows = [row("n1", "Goals", 1), row("n1", "Risks", 3)];
    const notes = [note("n1", "Project", "Work/")];

    expect(joinVaultHeadings(rows, notes)).toEqual([
      { noteUuid: "n1", title: "Project", folder: "Work/", heading: "Goals", level: 1 },
      { noteUuid: "n1", title: "Project", folder: "Work/", heading: "Risks", level: 3 },
    ]);
  });

  it("drops rows whose note is not resident — the trash/template exclusion", () => {
    // `n2` is in the index (trashed or a template) but absent from the resolver
    // set. Its headings must not reach the picker.
    const rows = [row("n1", "Kept"), row("n2", "Trashed"), row("n3", "Template")];
    const notes = [note("n1", "Live note")];

    const out = joinVaultHeadings(rows, notes);

    expect(out).toHaveLength(1);
    expect(out[0]!.heading).toBe("Kept");
  });

  it("orders by the resident set, then by document order within a note", () => {
    // Rows arrive in hash order from the index; the output must not.
    const rows = [row("n2", "B1"), row("n1", "A1"), row("n2", "B2"), row("n1", "A2")];
    const notes = [note("n1", "First"), note("n2", "Second")];

    expect(joinVaultHeadings(rows, notes).map((h) => h.heading)).toEqual([
      "A1",
      "A2",
      "B1",
      "B2",
    ]);
  });

  it("is empty when the index has nothing yet, and when nothing is resident", () => {
    expect(joinVaultHeadings([], [note("n1", "Live")])).toEqual([]);
    expect(joinVaultHeadings([row("n1", "Orphan")], [])).toEqual([]);
  });

  it("keeps an untitled note's headings, carrying the null title through", () => {
    // The picker renders provenance from `title`; an untitled note is a real
    // case (`ResolverNote.title` is nullable) and must not be filtered out.
    const out = joinVaultHeadings([row("n1", "Heading")], [note("n1", null)]);

    expect(out).toEqual([
      { noteUuid: "n1", title: null, folder: null, heading: "Heading", level: 2 },
    ]);
  });
});
