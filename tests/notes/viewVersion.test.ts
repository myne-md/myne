// The version-increment rule for a locally edited view (view-manifests task 8).
//
// The rule has two failures worth pinning, and each one is silent in the app:
//
//   1. a save that changes nothing and BUMPS anyway, which turns every re-import
//      of an identical file into "a newer version you have not seen";
//   2. a save that changes something and does NOT bump, which leaves two
//      different definitions at one version, so an import of either is refused as
//      same-version-different-content with no way forward.
//
// The third case is the pre-feature one: a view with no version must stay
// unversioned on a no-op save, or a save that touched nothing rewrites a vault's
// bytes.

import { describe, expect, it } from "vitest";
import type { SavedView } from "../../src/lib/prefs";
import {
  nextViewVersion,
  viewDefinitionFingerprint,
  withNextVersion,
} from "../../src/notes/views/viewVersion";

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

const RESERVED = "archived";
/** A tag for the filter fixtures, spelled out so none of them can collide with
 *  the reserved marker above. */
const READING_TAG = "reading";

describe("nextViewVersion", () => {
  it("moves forward when a display field changes", () => {
    expect(nextViewVersion(view(), view({ columns: ["status"] }))).toBe(4);
  });

  it("moves forward when the filter changes", () => {
    expect(
      nextViewVersion(view(), view({ filters: { kind: "hasTag", tag: READING_TAG } })),
    ).toBe(4);
  });

  it("stays put when nothing changed", () => {
    expect(nextViewVersion(view(), view())).toBe(3);
  });

  it("stays put when the only difference is field ORDER inside the definition", () => {
    // A rebuild from a form hands the same logical object with keys in another
    // insertion order. The canonical encoder sorts keys, so this is not a change.
    const previous = view({ columns: ["author", "status"] });
    const next = { ...previous } as SavedView;
    delete (next as { columns?: string[] }).columns;
    (next as { columns?: string[] }).columns = ["author", "status"];
    expect(nextViewVersion(previous, next)).toBe(3);
  });

  it("stays put when an empty list is written as absent", () => {
    // `columns: []` and no `columns` are the same bytes on disk: the encoder
    // omits an empty sequence.
    const previous = view();
    expect(nextViewVersion(previous, view({ columns: [] }))).toBe(3);
  });

  it("moves forward for a write-field change", () => {
    expect(nextViewVersion(view(), view({ write_fields: ["status"] }))).toBe(4);
  });

  it("counts a column REORDER as a change, because the order is the payload", () => {
    const previous = view({ columns: ["a", "b"] });
    expect(nextViewVersion(previous, view({ columns: ["b", "a"] }))).toBe(4);
  });

  it("stays unversioned on a no-op save of a pre-feature view", () => {
    const legacy = view({ version: undefined });
    expect(nextViewVersion(legacy, { ...legacy })).toBeUndefined();
  });

  it("gives a pre-feature view version 1 on its first real change", () => {
    const legacy = view({ version: undefined });
    expect(nextViewVersion(legacy, { ...legacy, name: "Books" })).toBe(1);
  });

  it("is not confused by the version itself, which is the answer", () => {
    // `next` arrives as a spread of `previous`, so the version is present on
    // both sides. If the fingerprint included it, every save would compare equal
    // and no edit would ever bump.
    expect(nextViewVersion(view({ version: 1 }), view({ version: 99 }))).toBe(1);
  });
});

describe("withNextVersion", () => {
  it("returns the definition carrying its settled version", () => {
    const edited = withNextVersion(view(), view({ name: "Books" }));
    expect(edited.version).toBe(4);
    expect(edited.name).toBe("Books");
  });

  it("delivers no version key at all for an unversioned no-op save", () => {
    const legacy = view({ version: undefined });
    const out = withNextVersion(legacy, { ...legacy });
    expect("version" in out).toBe(false);
  });

  it("does not mutate the definition it was handed", () => {
    const previous = view();
    const next = view({ name: "Books" });
    withNextVersion(previous, next);
    expect(next.version).toBe(3);
    expect(previous.version).toBe(3);
  });
});

describe("viewDefinitionFingerprint", () => {
  it("is stable across key insertion order", () => {
    const a = view();
    const b: SavedView = {
      filters: a.filters,
      view_type: a.view_type,
      name: a.name,
      id: a.id,
      version: a.version,
    };
    expect(viewDefinitionFingerprint(a)).toBe(viewDefinitionFingerprint(b));
  });

  it("sees a difference in one property key inside the filter", () => {
    const a = view({ filters: { kind: "hasTag", tag: "books" } });
    const b = view({ filters: { kind: "hasTag", tag: "book" } });
    expect(viewDefinitionFingerprint(a)).not.toBe(viewDefinitionFingerprint(b));
  });

  it("treats a reserved marker appearing as a change, so the refusal is not masked", () => {
    // A hand-edited definition could carry one; the form never offers it. The
    // fingerprint still has to notice, because the save path is what would write
    // it.
    const a = view();
    const b = view({ write_fields: [RESERVED] });
    expect(viewDefinitionFingerprint(a)).not.toBe(viewDefinitionFingerprint(b));
  });
});
