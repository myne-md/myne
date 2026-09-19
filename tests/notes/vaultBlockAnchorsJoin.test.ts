// `joinVaultBlockAnchors`, the join that turns trash-blind index rows into the
// `[[^^` picker's set (myne-md/myne#452).
//
// The twin of `vaultHeadingsJoin.test.ts` beside it, and it exists because this
// leg did NOT have a join until now. `useVaultBlockAnchors` mapped the Rust rows
// straight onto the facet shape, so the trash-blind dump reached the picker
// verbatim and `[[^^` offered deep links into trashed, template and
// conflict-copy notes. It also copied each row's own `noteTitle`/`noteFolder`,
// which is the index's copy rather than the resident one, so a rename between an
// apply and the picker opening emitted a stale path.
//
// Both are behaviours now rather than structural properties, and a behaviour
// needs a test.

import { describe, expect, it } from "vitest";
import {
  joinVaultBlockAnchors,
  type VaultBlockAnchor,
} from "../../editor/src/host/notes/blockAnchors";
import type { ResolverNote } from "../../editor/src/host/notes/resolveWikilink";

const note = (noteUuid: string, title: string | null, folder: string | null = null): ResolverNote => ({
  noteUuid,
  title,
  folder,
  folderIndex: false,
  isDrawing: false,
});

const row = (
  noteId: string,
  blockId: string,
  noteTitle: string | null = "Index copy",
  noteFolder: string | null = "Stale/",
): VaultBlockAnchor => ({
  noteId,
  noteTitle,
  noteFolder,
  blockId,
  preview: `preview for ${blockId}`,
});

describe("joinVaultBlockAnchors", () => {
  it("drops a row whose note is not in the resident set", () => {
    // How a trashed, template or conflict-copy note reaches a client: the Rust
    // index is trash-blind and hands it over. Dropping it here is the only
    // exclusion, and it is the one that stops the picker deep-linking INTO the
    // trash.
    const out = joinVaultBlockAnchors(
      [row("live", "a"), row("trashed", "b")],
      [note("live", "Live")],
    );
    expect(out.map((a) => a.blockId)).toEqual(["a"]);
  });

  it("drops every row when the note-set belongs to another vault", () => {
    // The vault-switch case. These rows carry plaintext (title, folder and a
    // preview line lifted from a note body), so a map rather than a join renders
    // vault A's content inside vault B.
    expect(joinVaultBlockAnchors([row("a-1", "x"), row("a-2", "y")], [note("b-1", "B")])).toEqual(
      [],
    );
  });

  it("takes title and folder from the resident note, not from the row", () => {
    // The row's own copy is as old as that note's last apply. The picker emits a
    // path from these, so a stale title emits a link to a name that no longer
    // resolves.
    const out = joinVaultBlockAnchors([row("n1", "a")], [note("n1", "Renamed", "Now/")]);
    expect(out).toEqual([
      {
        noteUuid: "n1",
        title: "Renamed",
        folder: "Now/",
        blockId: "a",
        preview: "preview for a",
      },
    ]);
  });

  it("orders by the note-set, then by row order within a note", () => {
    const out = joinVaultBlockAnchors(
      [row("n2", "b"), row("n1", "a1"), row("n1", "a2")],
      [note("n1", "First"), note("n2", "Second")],
    );
    expect(out.map((a) => a.blockId)).toEqual(["a1", "a2", "b"]);
  });

  it("is empty on either side being empty", () => {
    expect(joinVaultBlockAnchors([], [note("n1", "Live")])).toEqual([]);
    expect(joinVaultBlockAnchors([row("n1", "a")], [])).toEqual([]);
  });
});
