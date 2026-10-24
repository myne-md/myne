// The device-local approval rule (view-manifests task 7).
//
// This is the TypeScript mirror of the Rust authority, and the cases are the
// ones where a plausible implementation is silently wrong: a version bump that
// does NOT revoke (an approval keyed by id alone), a version-less view that asks
// for approval it can never receive (every pre-existing view behind a prompt on
// ship day), and a stored number for a DIFFERENT version that a loose `>=`
// comparison would accept.

import { describe, expect, it } from "vitest";
import { isViewApproved } from "../../src/notes/views/viewApproval";
import { orderSavedViews } from "../../src/notes/views/orderSavedViews";
import type { SavedView } from "../../src/lib/prefs";

function view(over: Partial<SavedView> = {}): SavedView {
  return {
    id: "v1",
    name: "Books",
    view_type: "table",
    filters: { kind: "all" },
    ...over,
  };
}

describe("isViewApproved", () => {
  it("is false for a versioned view with no approval recorded", () => {
    expect(isViewApproved(view({ version: 1 }), {})).toBe(false);
  });

  it("is true when the stored version equals the current one", () => {
    expect(isViewApproved(view({ version: 3 }), { v1: 3 })).toBe(true);
  });

  it("revokes on a version bump without touching the map", () => {
    // The whole point of the equality rule: an update clears the approval with
    // nothing to remember to clear.
    const approvals = { v1: 3 };
    expect(isViewApproved(view({ version: 3 }), approvals)).toBe(true);
    expect(isViewApproved(view({ version: 4 }), approvals)).toBe(false);
  });

  it("refuses a HIGHER stored version too", () => {
    // A stored number that does not match is not an approval of anything. A
    // `>=` comparison would read as approved, so this case exists to keep the
    // comparison an equality.
    expect(isViewApproved(view({ version: 2 }), { v1: 5 })).toBe(false);
  });

  it("treats a versionless view as approved", () => {
    // Only a view authored before the field existed can lack a version, since
    // the import reader refuses a manifest without one.
    expect(isViewApproved(view(), {})).toBe(true);
  });

  it("keys approval by id, so an approval of one view never covers another", () => {
    expect(isViewApproved(view({ id: "v2", version: 1 }), { v1: 1 })).toBe(false);
  });
});

describe("orderSavedViews", () => {
  it("follows view_order and appends a view the order does not name", () => {
    const a = view({ id: "a" });
    const b = view({ id: "b" });
    const orphan = view({ id: "orphan" });

    expect(orderSavedViews([orphan, b, a], ["b", "a"])).toEqual([b, a, orphan]);
  });

  it("skips a stale id in the order rather than rendering a hole", () => {
    const a = view({ id: "a" });
    expect(orderSavedViews([a], ["gone", "a"])).toEqual([a]);
  });

  it("does not duplicate a view named twice in the order", () => {
    const a = view({ id: "a" });
    expect(orderSavedViews([a], ["a", "a"])).toEqual([a]);
  });
});
