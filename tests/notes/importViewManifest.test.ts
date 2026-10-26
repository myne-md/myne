// The ordered import comparison (view-manifests task 9).
//
// An id is not an instruction to overwrite, so the four outcomes below are four
// different sentences and only ONE of them stores anything. The cases here are the
// ones where a plausible implementation is silently wrong, which is why they are
// written against the refusal arms rather than the happy path:
//
//   - same version + different definition: a naive "same id means update" takes
//     it, and that is either a different author reusing an id or a file changed
//     after sign-off;
//   - lower version: a stale file must not replace a newer view;
//   - same version + identical definition: a repeated download must be a no-op
//     success, not an error dialog and not a write.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedView } from "../../src/lib/prefs";

const upsertSavedView = vi.hoisted(() => vi.fn());
const setViewApproval = vi.hoisted(() => vi.fn());

vi.mock("../../src/lib/prefs", () => ({
  upsertSavedView,
  setViewApproval,
}));

import {
  approveImportedView,
  compareIncomingManifest,
  storeImportedView,
} from "../../src/notes/importViewManifest";

function view(over: Partial<SavedView> = {}): SavedView {
  return {
    id: "v1",
    name: "Reading list",
    view_type: "table",
    filters: { kind: "all" },
    version: 3,
    ...over,
  };
}

beforeEach(() => {
  upsertSavedView.mockReset().mockResolvedValue(undefined);
  setViewApproval.mockReset().mockResolvedValue(undefined);
});

describe("compareIncomingManifest", () => {
  it("imports a new id as a new view", () => {
    expect(compareIncomingManifest(view(), null).kind).toBe("new");
  });

  it("replaces a lower stored version", () => {
    const ordering = compareIncomingManifest(view({ version: 4 }), view({ version: 3 }));
    expect(ordering.kind).toBe("update");
  });

  it("refuses a lower incoming version and names both", () => {
    const ordering = compareIncomingManifest(view({ version: 2 }), view({ version: 5 }));
    expect(ordering).toMatchObject({ kind: "older" });
    if (ordering.kind !== "older") throw new Error("unreachable");
    expect(ordering.incoming.version).toBe(2);
    expect(ordering.stored.version).toBe(5);
  });

  it("reports an identical re-import as a no-op", () => {
    expect(compareIncomingManifest(view(), view()).kind).toBe("identical");
  });

  it("reports an identical re-import as a no-op even after a field reorder", () => {
    const stored = view({ columns: ["author", "status"] });
    const incoming = { ...stored };
    delete (incoming as { columns?: string[] }).columns;
    (incoming as { columns?: string[] }).columns = ["author", "status"];
    expect(compareIncomingManifest(incoming, stored).kind).toBe("identical");
  });

  it("refuses same version with different content, where same-id-implies-update would accept", () => {
    const ordering = compareIncomingManifest(view({ name: "Books" }), view({ name: "Reading list" }));
    expect(ordering.kind).toBe("sameVersionDifferentContent");
  });

  it("counts a filter change at the same version as different content", () => {
    expect(
      compareIncomingManifest(
        view({ filters: { kind: "hasTag", tag: "books" } }),
        view({ filters: { kind: "all" } }),
      ).kind,
    ).toBe("sameVersionDifferentContent");
  });

  it("treats a versionless stored view as older than any versioned file", () => {
    // Only a view authored before the field existed can lack a version, and a file
    // always carries one, so any file outranks it.
    const ordering = compareIncomingManifest(view({ version: 1 }), view({ version: undefined }));
    expect(ordering.kind).toBe("update");
  });
});

describe("storeImportedView / approveImportedView", () => {
  it("stores the definition without approving it", async () => {
    const incoming = view({ version: 4 });
    await storeImportedView(incoming);

    expect(upsertSavedView).toHaveBeenCalledWith(incoming);
    // The whole point: new bytes are a new decision, so this write is not an
    // approval. The stored approval still names the version it was shown.
    expect(setViewApproval).not.toHaveBeenCalled();
  });

  it("approves the incoming version and nothing else", async () => {
    const incoming = view({ version: 4 });
    await approveImportedView(incoming);

    expect(setViewApproval).toHaveBeenCalledWith("v1", 4);
    expect(upsertSavedView).not.toHaveBeenCalled();
  });
});
