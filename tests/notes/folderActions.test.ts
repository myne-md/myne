// Tests for folder-delete semantics (MYND-144 Task 8; non-empty delete added
// 2026-06-09). `planFolderDelete` collects the target subtree's notes (the
// caller soft-trashes them — recoverable, MYND-133) and cascade-removes the
// (note-empty) subtree from the deliberate_folders set. The pure plan never
// touches a note blob; `persistFolderDelete` writes only the trimmed set.
// Supersedes the pre-2026-06-09 "block when non-empty" behavior.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setDeliberateFoldersMock = vi.fn();
vi.mock("../../src/lib/prefs", () => ({
  mutateDeliberateFolders: (...a: unknown[]) => setDeliberateFoldersMock(...a),
}));

import { deriveFolderTree } from "../../src/notes/folderTree";
import {
  planFolderDelete,
  persistFolderDelete,
} from "../../src/notes/folderActions";

beforeEach(() => setDeliberateFoldersMock.mockReset());
afterEach(() => setDeliberateFoldersMock.mockReset());

const tree = (
  notes: Array<{ noteUuid: string; folder: string | null }>,
  deliberate: string[] = [],
) => deriveFolderTree(notes, deliberate, []);

describe("planFolderDelete — collects the subtree's notes (no longer blocks)", () => {
  it("collects a direct note", () => {
    const t = tree([{ noteUuid: "n1", folder: "Projects/" }]);
    const plan = planFolderDelete("Projects/", t, []);
    expect(plan.noteIds).toEqual(["n1"]);
  });

  it("collects a descendant note", () => {
    const t = tree([{ noteUuid: "n1", folder: "Projects/Myne/" }]);
    const plan = planFolderDelete("Projects/", t, []);
    expect(plan.noteIds).toEqual(["n1"]);
  });

  // MYND-599: the folder note is EXCLUDED from `FolderNode.noteIds` (it is
  // hidden from the sidebar tree), so a collector that walked `noteIds` alone
  // left behind the one note keeping the folder alive — the delete appeared to
  // do nothing, and archive-then-trash was the only path that worked.
  it("collects a folder's own folder note, which is hidden from noteIds", () => {
    const t = tree([
      { noteUuid: "idx", folder: "Projects/", folderIndex: true },
      { noteUuid: "n1", folder: "Projects/" },
    ]);
    const plan = planFolderDelete("Projects/", t, []);
    expect(plan.noteIds.sort()).toEqual(["idx", "n1"]);
  });

  it("collects a DESCENDANT folder's folder note too", () => {
    const t = tree([
      { noteUuid: "deep", folder: "Projects/Myne/", folderIndex: true },
    ]);
    const plan = planFolderDelete("Projects/", t, []);
    expect(plan.noteIds).toEqual(["deep"]);
  });

  it("collects every note across the whole subtree, not its siblings", () => {
    const t = tree([
      { noteUuid: "a", folder: "Projects/" },
      { noteUuid: "b", folder: "Projects/Myne/" },
      { noteUuid: "c", folder: "Other/" },
    ]);
    const plan = planFolderDelete("Projects/", t, []);
    expect(plan.noteIds.sort()).toEqual(["a", "b"]);
  });

  it("yields an empty noteIds for a note-empty folder", () => {
    const t = tree([], ["Drafts/"]);
    const plan = planFolderDelete("Drafts/", t, ["Drafts/"]);
    expect(plan.noteIds).toEqual([]);
  });

  it("still trims the deliberate set when the subtree holds notes", () => {
    const set = ["Busy/"];
    const t = tree([{ noteUuid: "n1", folder: "Busy/" }], set);
    const plan = planFolderDelete("Busy/", t, set);
    expect(plan.noteIds).toEqual(["n1"]);
    expect(plan.removed).toEqual(["Busy/"]);
    expect(plan.nextDeliberate).toEqual([]);
  });
});

describe("planFolderDelete — remove note-empty deliberate folders", () => {
  it("removes a single empty deliberate folder from the set", () => {
    const t = tree([], ["Drafts/"]);
    const plan = planFolderDelete("Drafts/", t, ["Drafts/"]);
    expect(plan.removed).toEqual(["Drafts/"]);
    expect(plan.nextDeliberate).toEqual([]);
  });

  it("cascade-removes a nested empty subtree in one action", () => {
    const set = ["Projects/", "Projects/Myne/", "Projects/Myne/Sub/"];
    const t = tree([], set);
    const plan = planFolderDelete("Projects/", t, set);
    expect(plan.removed.sort()).toEqual(
      ["Projects/", "Projects/Myne/", "Projects/Myne/Sub/"].sort(),
    );
    expect(plan.nextDeliberate).toEqual([]);
  });

  it("deleting a child keeps a deliberate parent", () => {
    const set = ["Projects/", "Projects/Myne/"];
    const t = tree([], set);
    const plan = planFolderDelete("Projects/Myne/", t, set);
    expect(plan.removed).toEqual(["Projects/Myne/"]);
    expect(plan.nextDeliberate).toEqual(["Projects/"]);
  });

  it("does not touch an unrelated sibling", () => {
    const set = ["Projects/", "Archive/"];
    const t = tree([], set);
    const plan = planFolderDelete("Projects/", t, set);
    expect(plan.nextDeliberate).toEqual(["Archive/"]);
  });

  it("does not prefix-false-match a sibling that shares a name prefix", () => {
    const set = ["Projects/", "Projectsx/"];
    const t = tree([], set);
    const plan = planFolderDelete("Projects/", t, set);
    expect(plan.nextDeliberate).toEqual(["Projectsx/"]);
  });

  it("matches case-insensitively (fold + NFC)", () => {
    const t = tree([], ["Projects/"]);
    const plan = planFolderDelete("projects/", t, ["Projects/"]);
    expect(plan.removed).toEqual(["Projects/"]);
  });
});

describe("persistFolderDelete: states the subtree, and lets the core resolve it", () => {
  beforeEach(() => setDeliberateFoldersMock.mockReset().mockResolvedValue(0));

  /** The mutation the delete sent. */
  const sent = () =>
    setDeliberateFoldersMock.mock.calls[0]?.[0] as {
      remove?: string[];
      removePrefix?: string[];
    };

  it("sends the folded key as a prefix verb, not a list of survivors", async () => {
    const set = ["Drafts/", "Keep/"];
    const plan = planFolderDelete("Drafts/", tree([], set), set);
    await persistFolderDelete(plan);
    expect(setDeliberateFoldersMock).toHaveBeenCalledTimes(1);
    // The write says WHICH SUBTREE went, not what is left (`Keep/`) and not a
    // list this view happened to hold. Those are three different claims and only
    // the first is safe: a list is a statement about entries this caller may
    // never have seen, and disk holds entries four fire-and-forget at-fill
    // writers put there (myne-md/myne#613).
    expect(sent()).toEqual({ removePrefix: ["drafts/"] });
    expect(sent().remove).toBeUndefined();
  });

  it("states the FOLDED key, so the core matches what the planner matched", async () => {
    const set = ["Projects/"];
    const plan = planFolderDelete("PROJECTS/", tree([], set), set);
    await persistFolderDelete(plan);
    expect(sent().removePrefix).toEqual(["projects/"]);
  });

  it("writes NOTHING for a root delete", async () => {
    // The case four disk-derivation tests never covered, and the one that could
    // wipe the vault's whole folder list. `removedKey` used to be `""` for the
    // root no-op and the filter that consumed it used
    // `String.prototype.startsWith`, which is true for every input: the sentinel
    // meant to match nothing matched everything, and `deliberate_folders` syncs,
    // so every empty folder on every device would have gone. It is `null` now,
    // which makes the case unrepresentable rather than relying on a reader.
    const plan = planFolderDelete("", tree([], ["Alpha/", "Beta/"]), [
      "Alpha/",
      "Beta/",
    ]);
    expect(plan.removedKey).toBeNull();
    await persistFolderDelete(plan);
    expect(setDeliberateFoldersMock).not.toHaveBeenCalled();
  });
});

// Which STORED entries a prefix takes is deliberately not tested here any more.
// It is a property of `apply_set_mutation`, inside the prefs write mutex, and
// this side can only assert it against a mock of that rule, which is testing the
// mock. The Rust cases are `remove_prefix_takes_the_stored_subtree_and_an_empty_prefix_takes_nothing`
// (including the name-prefix sibling and the empty-prefix no-op) in
// `core/src/plugins/prefs/set_mutation.rs`.
