// myne-md/myne#839 (cross-device): a note pulled from another device that has
// left the live tree must be detectable from its decrypted body, the same
// value-strict way the sidebar's `loadNoteBatch` reads it, so the editor's
// removal signal and the sidebar's tree cannot disagree.

import { describe, it, expect } from "vitest";
import { isRemovedFromLiveTree } from "../../src/notes/noteRemoved";

describe("isRemovedFromLiveTree", () => {
  it("is false for a live note and for a note with no frontmatter", () => {
    expect(isRemovedFromLiveTree("---\ntitle: X\n---\nbody\n")).toBe(false);
    expect(isRemovedFromLiveTree("plain body, no frontmatter")).toBe(false);
  });

  it("is true for the trashed, archived and deleted markers", () => {
    expect(isRemovedFromLiveTree("---\ntrashed: 2026-01-01T00:00:00Z\n---\n")).toBe(true);
    expect(isRemovedFromLiveTree("---\narchived: 2026-01-01T00:00:00Z\n---\n")).toBe(true);
    expect(isRemovedFromLiveTree("---\ndeleted: 2026-01-01T00:00:00Z\n---\n")).toBe(true);
  });

  it("is value-strict: a non-timestamp value leaves the note live", () => {
    expect(isRemovedFromLiveTree("---\ntrashed: true\n---\n")).toBe(false);
    expect(isRemovedFromLiveTree("---\narchived: no\n---\n")).toBe(false);
    // A `trashed:` mentioned in the body (not the frontmatter) is not a removal.
    expect(isRemovedFromLiveTree("---\ntitle: X\n---\ntrashed: 2026-01-01T00:00:00Z\n")).toBe(false);
  });
});
