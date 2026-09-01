// Folder rename (MYND-144 Task 9 + MYND-370): rewrite the `folder:` of every
// note under the old prefix AND rewrite inbound folder-target (`[[Old/]]`)
// wikilinks, committed all-or-nothing through the transactional batch primitive
// (MYND-370 grill Q7 — folder-target links break on rename since the folder path
// IS their resolution key, so the legacy best-effort folder move is lifted to the
// same transactional parity note-title rename has). Plus prefix-rewrite of the
// matching deliberate_folders entries.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const noteReadMock = vi.fn();
const writeBatchMock = vi.fn();
const reindexMock = vi.fn();
const setDeliberateFoldersMock = vi.fn();
const flushMock = vi.fn();
vi.mock("../../src/notes/renameFlushHook", () => ({
  renameFlushHooks: () => ({
    openNoteIds: () => new Set<string>(),
    flushOpenPanes: (...a: unknown[]) => flushMock(...a),
  }),
}));
vi.mock("../../src/notes/readNote", () => ({
  noteRead: (...a: unknown[]) => noteReadMock(...a),
}));
vi.mock("../../src/notes/noteWriteBatch", () => ({
  noteWriteBatchTransactional: (...a: unknown[]) => writeBatchMock(...a),
}));
vi.mock("../../src/notes/vaultIndices", () => ({
  reindexNoteFromBody: (...a: unknown[]) => reindexMock(...a),
}));
vi.mock("../../src/lib/prefs", async (importOriginal) => ({
  mutateDeliberateFolders: (...a: unknown[]) => setDeliberateFoldersMock(...a),
  // The REAL derivation, not a copy of it. It is what decides whether a
  // stale view can claim a deletion (myne-md/myne#613), so a stub here would
  // test the stub, and a hand-copy would be one more place for the real one
  // to drift away from.
  mutationFrom: (await importOriginal<typeof import("../../src/lib/prefs")>()).mutationFrom,
}));

import {
  planFolderRenameBatch,
  renameFolder,
  type FolderRenameNote,
} from "../../src/notes/folderActions";

type Note = { noteUuid: string; folder: string | null };

const NOW = "2026-06-17T00:00:00Z";

beforeEach(() => {
  noteReadMock.mockReset();
  writeBatchMock.mockReset();
  reindexMock.mockReset();
  setDeliberateFoldersMock.mockReset();
  flushMock.mockReset();
  flushMock.mockResolvedValue(undefined);
});
afterEach(() => {
  noteReadMock.mockReset();
  writeBatchMock.mockReset();
  reindexMock.mockReset();
  setDeliberateFoldersMock.mockReset();
  flushMock.mockReset();
});

describe("planFolderRenameBatch — pure (MYND-370 transactional plan)", () => {
  const n = (noteUuid: string, folder: string | null, body: string): FolderRenameNote => ({
    noteUuid,
    folder,
    body,
  });

  it("re-roots `folder:` of moved notes (with updated: bump) into the batch", () => {
    const plan = planFolderRenameBatch(
      "Projects/",
      "Work/",
      [n("n1", "Projects/", "# A"), n("n2", "Projects/Myne/", "# B"), n("n3", "Other/", "# C")],
      ["Projects/"],
      NOW,
    );
    if ("invalid" in plan) throw new Error("unexpected invalid");
    expect(plan.movedIds.sort()).toEqual(["n1", "n2"]);
    const byId = new Map(plan.batch.map((e) => [e.noteId, e.plaintext]));
    expect(byId.get("n1")).toContain("folder: Work/");
    expect(byId.get("n1")).toContain(`updated: ${NOW}`);
    expect(byId.get("n2")).toContain("folder: Work/Myne/");
    expect(byId.has("n3")).toBe(false);
    expect(plan.nextDeliberate).toEqual(["Work/"]);
  });

  it("does not prefix-false-match a name-prefix sibling", () => {
    const plan = planFolderRenameBatch(
      "Projects/",
      "Work/",
      [n("x", "Projectsx/", "# X")],
      ["Projectsx/"],
      NOW,
    );
    if ("invalid" in plan) throw new Error("unexpected invalid");
    expect(plan.movedIds).toEqual([]);
    expect(plan.batch).toEqual([]);
    expect(plan.nextDeliberate).toEqual(["Projectsx/"]);
  });

  it("matches case-insensitively, normalizing the renamed prefix", () => {
    const plan = planFolderRenameBatch(
      "Projects/",
      "Work/",
      [n("n", "projects/myne/", "# B")],
      [],
      NOW,
    );
    if ("invalid" in plan) throw new Error("unexpected invalid");
    expect(plan.movedIds).toEqual(["n"]);
    expect(plan.batch[0]!.plaintext).toContain("folder: Work/myne/");
  });

  it("normalizes non-canonical source/target inputs", () => {
    const plan = planFolderRenameBatch(
      "Projects",
      "Work",
      [n("n", "Projects/Sub", "# B")],
      [],
      NOW,
    );
    if ("invalid" in plan) throw new Error("unexpected invalid");
    expect(plan.batch[0]!.plaintext).toContain("folder: Work/Sub/");
  });

  it("prefix-rewrites matching deliberate_folders entries", () => {
    const plan = planFolderRenameBatch(
      "Projects/",
      "Work/",
      [],
      ["Projects/", "Projects/Myne/", "Archive/"],
      NOW,
    );
    if ("invalid" in plan) throw new Error("unexpected invalid");
    expect(plan.nextDeliberate).toEqual(["Work/", "Work/Myne/", "Archive/"]);
    expect(plan.deliberateRewritten).toBe(2);
  });

  it("rewrites inbound folder-target links `[[Old/]]` → `[[New/]]` in any note", () => {
    const plan = planFolderRenameBatch(
      "Projects/",
      "Work/",
      [n("ref", "Other/", "see [[Projects/]] and [[Projects/Myne/]]")],
      [],
      NOW,
    );
    if ("invalid" in plan) throw new Error("unexpected invalid");
    expect(plan.inboundIds).toEqual(["ref"]);
    expect(plan.movedIds).toEqual([]);
    const text = plan.batch.find((e) => e.noteId === "ref")!.plaintext;
    expect(text).toBe("see [[Work/]] and [[Work/Myne/]]");
  });

  it("composes a move + an inbound rewrite on the same note", () => {
    // A note in the renamed subtree that also links to its own folder index.
    const plan = planFolderRenameBatch(
      "Projects/",
      "Work/",
      [n("self", "Projects/", "body [[Projects/]] end")],
      [],
      NOW,
    );
    if ("invalid" in plan) throw new Error("unexpected invalid");
    expect(plan.movedIds).toEqual(["self"]);
    expect(plan.inboundIds).toEqual(["self"]);
    const text = plan.batch.find((e) => e.noteId === "self")!.plaintext;
    expect(text).toContain("folder: Work/");
    expect(text).toContain("[[Work/]]");
    expect(text).not.toContain("[[Projects/]]");
  });

  it("leaves title-keyed and note path-form links untouched", () => {
    const plan = planFolderRenameBatch(
      "Projects/",
      "Work/",
      [n("x", "Other/", "[[Note]] and [[Projects/Note]] stay")],
      [],
      NOW,
    );
    if ("invalid" in plan) throw new Error("unexpected invalid");
    expect(plan.batch).toEqual([]);
  });

  it("is invalid for a root source/target", () => {
    expect(planFolderRenameBatch("", "Work/", [], [], NOW)).toEqual({ invalid: true });
  });

  it("is an empty no-op batch when source equals target", () => {
    const plan = planFolderRenameBatch(
      "Projects/",
      "Projects/",
      [n("x", "Projects/", "[[Projects/]]")],
      ["Projects/"],
      NOW,
    );
    if ("invalid" in plan) throw new Error("unexpected invalid");
    expect(plan.batch).toEqual([]);
    expect(plan.deliberateRewritten).toBe(0);
  });
});

describe("renameFolder — async apply (transactional)", () => {
  it("reads bodies, commits one batch, persists the deliberate set, re-indexes moves", async () => {
    noteReadMock.mockImplementation((id: string) =>
      Promise.resolve(id === "ref" ? "[[Projects/]]" : "---\nfolder: Projects/\n---\n\n# B"),
    );
    writeBatchMock.mockResolvedValueOnce(undefined);
    setDeliberateFoldersMock.mockResolvedValueOnce(undefined);
    const notes: Note[] = [
      { noteUuid: "n1", folder: "Projects/" },
      { noteUuid: "ref", folder: "Other/" },
    ];
    const result = await renameFolder("Projects/", "Work/", notes, ["Projects/"]);
    expect(result.failed).toEqual([]);
    expect(result.moved.sort()).toEqual(["n1", "ref"]);
    // Exactly one transactional commit carrying both the move + the inbound rewrite.
    expect(writeBatchMock).toHaveBeenCalledTimes(1);
    const batch = writeBatchMock.mock.calls[0]![0] as Array<{ noteId: string; plaintext: string }>;
    expect(batch.map((e) => e.noteId).sort()).toEqual(["n1", "ref"]);
    // A rename states the SUBTREE once and the core re-roots whatever is
    // stored under it. It used to send a remove-plus-add pair derived from the
    // caller's own set, which could mention neither an entry an at-fill writer
    // had just put on disk nor one a peer had landed: those stayed under the OLD
    // path and reappeared empty at the next unlock (myne-md/myne#613 review).
    // One verb is also atomic, where the pair could land its removals, stamp
    // each as a propagating deletion, and have its additions refused by the byte
    // budget.
    expect(setDeliberateFoldersMock).toHaveBeenCalledWith({
      renamePrefix: [{ from: "projects/", to: "Work/" }],
    });
    // Moved note re-indexed; the pure inbound-only note is not a move.
    expect(reindexMock).toHaveBeenCalledWith("n1", expect.stringContaining("folder: Work/"));
  });

  // The `deliberate_folders` write happens PAST the commit, so a failure there
  // has the rename on disk. Throwing would tell the caller a rename that landed
  // did not, and skip the decoration and archived-folder re-rooting it still
  // owes; those live in `vault.prefs` and nothing reconciles them later.
  it("retries the post-commit deliberate write once before giving up", async () => {
    noteReadMock.mockResolvedValue("---\nfolder: P/\n---\n\n# B");
    writeBatchMock.mockResolvedValueOnce(undefined);
    setDeliberateFoldersMock
      .mockRejectedValueOnce(new Error("prefs busy"))
      .mockResolvedValueOnce(undefined);

    const result = await renameFolder("P/", "Q/", [{ noteUuid: "n", folder: "P/" }], ["P/"]);

    expect(setDeliberateFoldersMock).toHaveBeenCalledTimes(2);
    // The retry is the difference between recoverable and permanent: a second
    // rename cannot fix this later, because after a relaunch the stale entry is
    // under the OLD path and `planFolderRenameBatch` keys its rewrite off the
    // CURRENT one, so nothing matches and this block does not even run.
    expect(result.deliberateWriteFailed).toBe(false);
    expect(result.failed).toEqual([]);
    expect(result.moved).toEqual(["n"]);
  });

  it("reports a twice-failed deliberate write rather than throwing it", async () => {
    noteReadMock.mockResolvedValue("---\nfolder: P/\n---\n\n# B");
    writeBatchMock.mockResolvedValueOnce(undefined);
    setDeliberateFoldersMock.mockRejectedValue(new Error("disk full"));

    const result = await renameFolder("P/", "Q/", [{ noteUuid: "n", folder: "P/" }], ["P/"]);

    expect(setDeliberateFoldersMock).toHaveBeenCalledTimes(2);
    expect(result.deliberateWriteFailed).toBe(true);
    // And the rename is still reported as landed, which is the whole reason this
    // is a value and not a throw: the caller runs the decoration and
    // archived-folder re-rooting off `moved` and `nextDeliberate`.
    expect(result.failed).toEqual([]);
    expect(result.moved).toEqual(["n"]);
    expect(result.nextDeliberate).toEqual(["Q/"]);
  });

  it("does not report a failure when there was no deliberate entry to write", async () => {
    // The other direction. A rename with nothing in the deliberate set skips the
    // write entirely, and a flag that turned on there would put a notice about a
    // setting on a rename that had none.
    noteReadMock.mockResolvedValue("---\nfolder: P/\n---\n\n# B");
    writeBatchMock.mockResolvedValueOnce(undefined);
    setDeliberateFoldersMock.mockRejectedValue(new Error("never called"));

    const result = await renameFolder("P/", "Q/", [{ noteUuid: "n", folder: "P/" }], []);

    expect(setDeliberateFoldersMock).not.toHaveBeenCalled();
    expect(result.deliberateWriteFailed).toBe(false);
  });

  it("flushes open dirty panes BEFORE reading any body (WL-8 pre-flight)", async () => {
    const order: string[] = [];
    flushMock.mockImplementation(() => {
      order.push("flush");
      return Promise.resolve(undefined);
    });
    noteReadMock.mockImplementation(() => {
      order.push("read");
      return Promise.resolve("# x");
    });
    await renameFolder("P/", "Q/", [{ noteUuid: "n", folder: "P/" }], []);
    expect(flushMock).toHaveBeenCalledTimes(1);
    expect(order[0]).toBe("flush");
    expect(order).toContain("read");
    expect(order.indexOf("flush")).toBeLessThan(order.indexOf("read"));
  });

  it("on a transactional failure reports all-as-failed and writes nothing else", async () => {
    noteReadMock.mockResolvedValue("---\nfolder: P/\n---\n\nx");
    writeBatchMock.mockRejectedValueOnce({ kind: "Io" });
    const notes: Note[] = [{ noteUuid: "n", folder: "P/" }];
    const result = await renameFolder("P/", "Q/", notes, ["P/"]);
    expect(result.moved).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.noteId).toBe("n");
    // Atomic at the orchestrator level: no deliberate write on rollback.
    expect(setDeliberateFoldersMock).not.toHaveBeenCalled();
  });

  // ── myne#300: a post-commit rejection is not "the vault is unchanged" ────
  //
  // `write_batch_transactional` used to collapse both sides of the commit
  // point into one `Io`, and this function read every rejection as
  // all-or-nothing. Past the `.rename-journal` marker the batch IS committed —
  // the backend publishes the rest at the next vault open — so the old
  // behaviour told the user a folder rename that was already on disk had
  // failed, AND skipped the two things the recovery pass cannot redo for it:
  // the deliberate-folder rewrite and the re-index.
  it("treats a CommittedPendingPublish rejection as committed, not as failure", async () => {
    noteReadMock.mockImplementation((id: string) =>
      Promise.resolve(id === "ref" ? "[[P/]]" : "---\nfolder: P/\n---\n\nx"),
    );
    writeBatchMock.mockRejectedValueOnce({
      kind: "CommittedPendingPublish",
      detail: { io_error_kind: "NoSpace" },
    });
    setDeliberateFoldersMock.mockResolvedValueOnce(undefined);
    const notes: Note[] = [
      { noteUuid: "n", folder: "P/" },
      { noteUuid: "ref", folder: "Other/" },
    ];
    const result = await renameFolder("P/", "Q/", notes, ["P/"]);

    expect(result.failed).toEqual([]);
    expect(result.moved.sort()).toEqual(["n", "ref"]);
    // The two writes the recovery pass will NOT redo happen anyway.
    expect(setDeliberateFoldersMock).toHaveBeenCalledWith({
      renamePrefix: [{ from: "p/", to: "Q/" }],
    });
    expect(reindexMock).toHaveBeenCalledWith("n", expect.stringContaining("folder: Q/"));
  });

  it("still rolls back on an unrecognized rejection — the safe default", async () => {
    // A rejection shape this build does not know (an older backend, a thrown
    // Error) must keep the conservative reading. Recognizing "committed" is
    // opt-in by tag; everything else stays all-or-nothing.
    noteReadMock.mockResolvedValue("---\nfolder: P/\n---\n\nx");
    writeBatchMock.mockRejectedValueOnce(new Error("boom"));
    const result = await renameFolder("P/", "Q/", [{ noteUuid: "n", folder: "P/" }], ["P/"]);
    expect(result.moved).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(setDeliberateFoldersMock).not.toHaveBeenCalled();
  });

  it("does not commit or persist when nothing changed", async () => {
    noteReadMock.mockResolvedValue("# unrelated, no links, not in subtree");
    await renameFolder("P/", "Q/", [{ noteUuid: "n", folder: "Other/" }], ["Other/"]);
    expect(writeBatchMock).not.toHaveBeenCalled();
    expect(setDeliberateFoldersMock).not.toHaveBeenCalled();
  });

  it("returns invalid for a root source without reading or writing", async () => {
    const result = await renameFolder("", "Q/", [], []);
    expect(result.invalid).toBe(true);
    expect(noteReadMock).not.toHaveBeenCalled();
    expect(writeBatchMock).not.toHaveBeenCalled();
  });
});
