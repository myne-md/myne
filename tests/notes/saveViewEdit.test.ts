// The one write a locally edited view makes (view-manifests task 8).
//
// Two directions, and both matter:
//
//   - an APPROVED view's edit must land the definition AND this device's
//     approval of its new version in ONE prefs write, so editing your own view
//     never leaves it unapproved (`set_view_approval` with a definition);
//   - an UNAPPROVED view's edit must NOT approve it. The view is not the user's
//     own yet: it is waiting on a decision the manager is still asking for, and a
//     rename from the sidebar must not answer that question on their behalf.
//
// A third case is the version itself: a no-op save must not bump, which is what
// keeps a repeated import of an identical file the harmless no-op it is meant to
// be.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedView } from "../../src/lib/prefs";

const upsertSavedView = vi.hoisted(() => vi.fn());
const setViewApproval = vi.hoisted(() => vi.fn());

vi.mock("../../src/lib/prefs", () => ({
  upsertSavedView,
  setViewApproval,
}));

import { saveLocalViewEdit } from "../../src/notes/views/saveViewEdit";

function view(over: Partial<SavedView> = {}): SavedView {
  return {
    id: "v1",
    name: "Reading list",
    view_type: "table",
    filters: { kind: "all" },
    version: 2,
    ...over,
  };
}

beforeEach(() => {
  upsertSavedView.mockReset().mockResolvedValue(undefined);
  setViewApproval.mockReset().mockResolvedValue(undefined);
});

describe("saveLocalViewEdit", () => {
  it("writes the definition and this device's approval in ONE call when approved", () => {
    const previous = view();
    const next = view({ name: "Books" });

    return saveLocalViewEdit(previous, next, true).then((saved) => {
      expect(saved.version).toBe(3);
      expect(setViewApproval).toHaveBeenCalledTimes(1);
      expect(setViewApproval).toHaveBeenCalledWith("v1", 3, saved);
      // The plain upsert would be a second write of the same blob.
      expect(upsertSavedView).not.toHaveBeenCalled();
    });
  });

  it("does not approve an unapproved view, and leaves it pending at its new version", () => {
    const previous = view();
    const next = view({ name: "Books" });

    return saveLocalViewEdit(previous, next, false).then((saved) => {
      expect(saved.version).toBe(3);
      expect(upsertSavedView).toHaveBeenCalledWith(saved);
      // The critical half: no approval call, so the manager still asks.
      expect(setViewApproval).not.toHaveBeenCalled();
    });
  });

  it("keeps the version on a save that changed nothing", () => {
    const previous = view();
    return saveLocalViewEdit(previous, view(), true).then((saved) => {
      expect(saved.version).toBe(2);
      expect(setViewApproval).toHaveBeenCalledWith("v1", 2, saved);
    });
  });
});
