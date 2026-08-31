// myne-md/myne#613 task 6, mobile half: the once-per-unlock back-fill.
//
// The desktop twin is `tests/notes/folderBackfill.test.ts` in the main tree, and
// it proves nothing about this one: mobile reads a note's folder and flags out
// of the note BODY rather than off a `TitleRecord`, so the parsing half is
// genuinely different code and is where a mobile-only defect would live.
//
// Keyed off what reached `invoke`, with the same counterfactuals: registering
// too little leaves the issue open for the vault's oldest folders, registering
// too much silently resurrects folders the user emptied on purpose.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  backfillDeliberateFolders,
  foldersToBackfill,
} from "../src/lib/folderBackfill";

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(0);
});

/** A note body carrying `folder:` and whatever extra frontmatter is passed. */
function body(folder: string | null, extra: Record<string, string> = {}): string {
  const fields = [
    ...(folder === null ? [] : [`folder: ${folder}`]),
    ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`),
  ];
  if (fields.length === 0) return "# Note\n\nbody\n";
  return `---\n${fields.join("\n")}\n---\n\n# Note\n\nbody\n`;
}

/** Every `prefs|set_deliberate_folders` payload that reached `invoke`. */
function writes(): Array<{ add?: string[]; remove?: string[] }> {
  return invokeMock.mock.calls
    .filter(([cmd]) => cmd === "plugin:prefs|set_deliberate_folders")
    .map(([, args]) => (args as { mutation: { add?: string[]; remove?: string[] } }).mutation);
}

const STAMP = "2026-08-01T00:00:00.000Z";

describe("foldersToBackfill: what a live note body proves", () => {
  it("names every folder the live notes are in, once each", () => {
    expect(
      foldersToBackfill(
        [body("Projects/"), body("Projects/"), body("Ideas/"), body(null)],
        [],
      ),
    ).toEqual(["Projects/", "Ideas/"]);
  });

  it("a folder whose notes are ALL in Trash is not registered", () => {
    expect(foldersToBackfill([body("Old/", { trashed: STAMP })], [])).toEqual([]);
  });

  it("a folder with one live note among trashed ones IS registered", () => {
    // The counterfactual: without it, the test above also passes for a version
    // that registers nothing at all.
    expect(
      foldersToBackfill([body("Old/", { trashed: STAMP }), body("Old/")], []),
    ).toEqual(["Old/"]);
  });

  it("archived and template notes prove nothing", () => {
    expect(
      foldersToBackfill(
        [body("A/", { archived: STAMP }), body("B/", { template: "true" })],
        [],
      ),
    ).toEqual([]);
  });

  it("skips a folder the vault already has registered", () => {
    expect(foldersToBackfill([body("Projects/"), body("Ideas/")], ["Projects/"])).toEqual([
      "Ideas/",
    ]);
  });

  it("compares by canonical key, so a case difference is not re-added forever", () => {
    expect(foldersToBackfill([body("projects/")], ["Projects/"])).toEqual([]);
  });
});

describe("backfillDeliberateFolders: the write", () => {
  it("registers what the notes prove, as an ADD claiming no removal", async () => {
    await backfillDeliberateFolders([body("Projects/"), body("Ideas/")], []);
    const w = writes();
    expect(w).toHaveLength(1); // floor: it wrote at all
    // `addUnlessRemoved`, not `add`: the back-fill is a REPAIR, and the core
    // skips any entry whose removal is on record so a peer's folder delete is
    // not undone by this device still holding the notes (myne#613 round 2).
    expect(w[0]?.addUnlessRemoved).toEqual(["Projects/", "Ideas/"]);
    expect(w[0]?.remove ?? []).toEqual([]);
  });

  it("a second unlock writes NOTHING, not an empty-effect write", async () => {
    await backfillDeliberateFolders([body("Projects/")], ["Projects/"]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("writes no note bytes, ever", async () => {
    await backfillDeliberateFolders([body("Projects/")], []);
    const commands = invokeMock.mock.calls.map(([cmd]) => cmd as string);
    expect(commands).toEqual(["plugin:prefs|set_deliberate_folders"]);
    expect(commands.some((c) => c.startsWith("plugin:notes|"))).toBe(false);
  });

  it("a failed write resolves and leaves the next unlock to retry", async () => {
    invokeMock.mockRejectedValue(new Error("prefs write failed"));
    await expect(backfillDeliberateFolders([body("Projects/")], [])).resolves.toBe(0);
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(0);
    await backfillDeliberateFolders([body("Projects/")], []);
    expect(writes()[0]?.addUnlessRemoved).toEqual(["Projects/"]);
  });
});
