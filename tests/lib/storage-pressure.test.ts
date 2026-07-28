// Is this failure the storage running out? (phase3-web-client task 91)
//
// The predicate has to be right in BOTH directions and the two mistakes are not
// symmetric:
//
//   * Missing a real quota failure leaves the user on "Save failed — click
//     Retry", which is advice that cannot work: they retry forever while the
//     store stays full.
//   * Claiming one that is not there sends them to free space for a locked
//     handle or a stale one, which frees nothing and fixes nothing.

import { describe, expect, it } from "vitest";
import { ioKindOf, isStorageFull } from "../../src/lib/storage-pressure";

describe("storage-pressure detection", () => {
  it("reads the kind from both wire shapes", () => {
    // Some backend enums put the kind at the top level; others nest it under
    // `detail`, per the `#[serde(tag = "kind", content = "detail")]` convention.
    // A caller should not have to know which enum it caught.
    expect(ioKindOf({ io_error_kind: "NoSpace" })).toBe("NoSpace");
    expect(ioKindOf({ kind: "Io", detail: { io_error_kind: "NoSpace" } })).toBe("NoSpace");
  });

  it("says yes only for NoSpace", () => {
    expect(isStorageFull({ io_error_kind: "NoSpace" })).toBe(true);
    expect(isStorageFull({ kind: "Io", detail: { io_error_kind: "NoSpace" } })).toBe(true);
  });

  it("says no for the other storage failures, which have different remedies", () => {
    // A locked OPFS sync access handle is `PermissionDenied`; a stale one is
    // `Other`. Both are storage failures and neither is fixed by freeing space,
    // so telling the user to free space would send them to do something that
    // cannot help.
    expect(isStorageFull({ io_error_kind: "PermissionDenied" })).toBe(false);
    expect(isStorageFull({ io_error_kind: "Other" })).toBe(false);
    expect(isStorageFull({ io_error_kind: "NotFound" })).toBe(false);
  });

  it("says no rather than throwing on anything else", () => {
    // The error reaching this predicate is `unknown` — it can be a DOMException,
    // a string, or nothing at all. A throw here would replace a save failure
    // with a crash on the screen where the user is trying to keep their work.
    for (const value of [null, undefined, "NoSpace", 0, [], {}, new Error("boom")]) {
      expect(() => isStorageFull(value)).not.toThrow();
      expect(isStorageFull(value)).toBe(false);
    }
  });

  it("does not match a lookalike string anywhere in the object", () => {
    // A message that happens to mention the words must not be read as the kind:
    // the closed enum is the contract, and matching prose would make the
    // predicate fire on a translated error message one day.
    expect(isStorageFull({ message: "NoSpace left on device" })).toBe(false);
  });
});
