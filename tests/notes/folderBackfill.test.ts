// myne-md/myne#613 task 6: the once-per-unlock back-fill for a vault created
// before at-fill.
//
// Keyed off what reached `invoke`, never off the binding's name: the defect this
// closes is a folder that vanishes when emptied, and what decides that is the
// PAYLOAD of the prefs write, not whether a function was called.
//
// The counterfactual matters more here than usual, because the two ways to get
// this wrong are opposite. Registering too little leaves the issue open for the
// oldest folders in the vault. Registering too much resurrects folders the user
// emptied on purpose, and does it silently, on unlock.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  backfillDeliberateFolders,
  foldersToBackfill,
  type BackfillRecord,
} from "../../src/notes/folderBackfill";

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(0);
});

/** A live note in `folder`. */
function live(folder: string | null): BackfillRecord {
  return {
    folder,
    trashed: null,
    deleted: null,
    archived: null,
    template: false,
    conflict: false,
  };
}

/** Every `prefs|set_deliberate_folders` payload that reached `invoke`. */
function writes(): Array<{
  add?: string[];
  addUnlessRemoved?: string[];
  remove?: string[];
}> {
  return invokeMock.mock.calls
    .filter(([cmd]) => cmd === "plugin:prefs|set_deliberate_folders")
    .map(
      ([, args]) =>
        (
          args as {
            mutation: {
              add?: string[];
              addUnlessRemoved?: string[];
              remove?: string[];
            };
          }
        ).mutation,
    );
}

describe("foldersToBackfill: what a live note proves", () => {
  it("names every folder the live notes are in, once each", () => {
    expect(
      foldersToBackfill(
        [live("Projects/"), live("Projects/"), live("Ideas/"), live(null)],
        [],
      ),
    ).toEqual(["Projects/", "Ideas/"]);
  });

  it("a folder whose notes are ALL in Trash is not registered", () => {
    // The user emptied it. The tree does not show it. Registering it here would
    // resurrect a folder as a side effect of unlocking, which is the opposite
    // failure to the one this feature fixes and is worse: it is silent.
    const trashed = { ...live("Old/"), trashed: "2026-08-01T00:00:00.000Z" };
    expect(foldersToBackfill([trashed], [])).toEqual([]);
  });

  it("a folder with one live note among trashed ones IS registered", () => {
    // The counterfactual for the case above: the rule is per NOTE, so one
    // survivor still proves the folder. Without this the previous test would
    // also pass for a version that registers nothing at all.
    const trashed = { ...live("Old/"), trashed: "2026-08-01T00:00:00.000Z" };
    expect(foldersToBackfill([trashed, live("Old/")], [])).toEqual(["Old/"]);
  });

  it("archived, deleted, template and conflict notes prove nothing", () => {
    const stamp = "2026-08-01T00:00:00.000Z";
    const rows: BackfillRecord[] = [
      { ...live("A/"), archived: stamp },
      { ...live("B/"), deleted: stamp },
      { ...live("C/"), template: true },
      { ...live("D/"), conflict: true },
    ];
    // Each is excluded from the sidebar tree today, so registering it would make
    // a folder appear that the user cannot currently see.
    expect(foldersToBackfill(rows, [])).toEqual([]);
  });

  it("skips a folder the vault already has registered", () => {
    expect(foldersToBackfill([live("Projects/"), live("Ideas/")], ["Projects/"])).toEqual([
      "Ideas/",
    ]);
  });

  it("compares by canonical key, so a case difference is not re-added forever", () => {
    // Registered as `Projects/`, the note says `projects/`. Comparing raw
    // strings would emit an add on every single unlock for the life of the
    // vault, each one re-encrypting `vault.prefs` and bumping the nonce.
    expect(foldersToBackfill([live("projects/")], ["Projects/"])).toEqual([]);
  });
});

describe("backfillDeliberateFolders: the write", () => {
  it("registers what the notes prove, as an ADD claiming no removal", async () => {
    await backfillDeliberateFolders([live("Projects/"), live("Ideas/")], []);
    const w = writes();
    expect(w).toHaveLength(1); // floor: it wrote at all
    // `addUnlessRemoved`, not `add`: the back-fill is a REPAIR, and the core
    // skips any entry whose removal is on record so a peer's folder delete is
    // not undone by this device still holding the notes (myne#613 round 2).
    expect(w[0]?.addUnlessRemoved).toEqual(["Projects/", "Ideas/"]);
    // A back-fill can never claim a deletion. If it could, an unlock on a device
    // holding a stale note set would delete folders across the whole fleet.
    expect(w[0]?.remove ?? []).toEqual([]);
  });

  it("a second unlock writes NOTHING, not an empty-effect write", async () => {
    // Asserted on the IPC, not on the resulting set: an empty-effect write still
    // re-encrypts the whole `vault.prefs` blob and bumps the nonce, which every
    // mounted `usePrefs` then re-reads. "It converges anyway" is not the same
    // property.
    await backfillDeliberateFolders([live("Projects/")], ["Projects/"]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("a vault with no foldered notes writes nothing", async () => {
    await backfillDeliberateFolders([live(null), live(null)], []);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("writes no note bytes, ever", async () => {
    await backfillDeliberateFolders([live("Projects/")], []);
    // Asserted on the COMMANDS that reached the IPC boundary rather than on a
    // return value: this is a migration-shaped operation, and the property that
    // matters is what it touched, not what it reported.
    const commands = invokeMock.mock.calls.map(([cmd]) => cmd as string);
    expect(commands).toEqual(["plugin:prefs|set_deliberate_folders"]);
    expect(commands.some((c) => c.startsWith("plugin:notes|"))).toBe(false);
  });

  it("a failed write resolves and leaves the next unlock to retry", async () => {
    invokeMock.mockRejectedValue(new Error("prefs write failed"));
    await expect(backfillDeliberateFolders([live("Projects/")], [])).resolves.toBe(0);
    // Nothing records that this ran, so the next unlock tries again with the
    // same input. A half-registered vault is not reachable: the core applies the
    // whole mutation under the prefs write mutex.
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(0);
    await backfillDeliberateFolders([live("Projects/")], []);
    expect(writes()[0]?.addUnlessRemoved).toEqual(["Projects/"]);
  });

  it("forwards the budget refusal count", async () => {
    invokeMock.mockResolvedValue(3);
    await expect(backfillDeliberateFolders([live("Projects/")], [])).resolves.toBe(3);
  });
});
