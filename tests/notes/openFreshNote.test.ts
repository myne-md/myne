// `refreshThenOpen` — the two-call ordering the template-create flow depends on
// (myne-md/myne#820, pinned by myne-md/myne#824).
//
// The open bridge refuses an id that is not live as if it were deleted, so a
// just-created note must be refreshed into the cache before `open`. This test
// exists because the previous inline version in `Editor.tsx` had no test:
// reverting it to a bare `open` left every test green.

import { describe, expect, it, vi } from "vitest";

import { refreshThenOpen } from "../../src/notes/openFreshNote";

describe("refreshThenOpen", () => {
  it("refreshes before opening", async () => {
    const order: string[] = [];
    const seam = {
      refreshOne: vi.fn(async (id: string) => {
        order.push(`refresh:${id}`);
      }),
      open: vi.fn(async (id: string) => {
        order.push(`open:${id}`);
      }),
    };
    await refreshThenOpen(seam, "note-1");
    expect(order).toEqual(["refresh:note-1", "open:note-1"]);
  });

  it("does not open when the refresh rejects", async () => {
    const open = vi.fn(async () => {});
    const seam = {
      refreshOne: vi.fn(async () => {
        throw new Error("refresh boom");
      }),
      open,
    };
    await expect(refreshThenOpen(seam, "note-1")).rejects.toThrow("refresh boom");
    expect(open).not.toHaveBeenCalled();
  });
});
