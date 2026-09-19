// @vitest-environment jsdom
//
// `useVaultBlockAnchors`, the desktop ADOPTER of the `[[^^` join (myne-md/myne#452).
//
// The pure join has its own suite (`vaultBlockAnchorsJoin.test.ts`), and it was
// the only thing covering this. Round 2 of review measured the consequence:
// reverting this hook's body to the old `rows.map(...)` left every desktop test
// and every desktop E2E file green, because nothing asserted that THIS call site
// joins. A pure function nobody is proven to call is not a fix.
//
// So this asserts the two properties the map lost, at the adopter:
//   - a row whose note is not resident is dropped, which is what keeps the
//     picker from offering a deep link into a trashed note;
//   - title and folder come from the resident note rather than from the row,
//     whose copy is as old as that note's last apply and which the picker emits
//     a path from.

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { VaultBlockAnchor } from "@myne/editor/host/notes/blockAnchors";

const vaultBlockAnchorsMock = vi.fn();

vi.mock("../../src/notes/vaultIndices", () => ({
  vaultBlockAnchors: () => vaultBlockAnchorsMock(),
}));
vi.mock("../../src/notes/indexNonce", () => ({ useIndexNonce: () => 1 }));
vi.mock("../../src/notes/resolverNotes", () => ({
  useResolverNotes: () => [
    // The resident note carries the CURRENT title and folder. The row below
    // carries what it was called at its last apply.
    { noteUuid: "live", title: "Yeni ad", folder: "Yeni/", folderIndex: false, isDrawing: false },
  ],
}));

import { useVaultBlockAnchors } from "../../src/notes/useVaultBlockAnchors";

const ROWS: VaultBlockAnchor[] = [
  {
    noteId: "live",
    noteTitle: "Eski ad",
    noteFolder: "Eski/",
    blockId: "a1",
    preview: "canli onizleme",
  },
  {
    noteId: "trashed",
    noteTitle: "Cope atilmis not",
    noteFolder: null,
    blockId: "t1",
    preview: "cope atilmis onizleme",
  },
];

afterEach(() => {
  vaultBlockAnchorsMock.mockReset();
});

describe("useVaultBlockAnchors joins rather than maps", () => {
  it("drops a row whose note is not in the resident set", async () => {
    vaultBlockAnchorsMock.mockResolvedValue(ROWS);
    const { result } = renderHook(() => useVaultBlockAnchors());

    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0]!.blockId).toBe("a1");
    expect(result.current.map((a) => a.preview)).not.toContain("cope atilmis onizleme");
  });

  it("takes title and folder from the resident note, not from the row", async () => {
    vaultBlockAnchorsMock.mockResolvedValue(ROWS);
    const { result } = renderHook(() => useVaultBlockAnchors());

    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0]).toMatchObject({
      noteUuid: "live",
      title: "Yeni ad",
      folder: "Yeni/",
    });
  });

  it("is empty, not throwing, when the query rejects", async () => {
    // Best-effort by design: a failed query leaves the prior set rather than
    // blanking the picker mid-keystroke.
    vaultBlockAnchorsMock.mockRejectedValue(new Error("refused"));
    const { result } = renderHook(() => useVaultBlockAnchors());
    await waitFor(() => expect(result.current).toEqual([]));
  });
});
