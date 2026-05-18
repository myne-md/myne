// `diffDoc` pure-logic tests — covers the controlled-component mirror
// minimal-change diff in `src/editor/doc-diff.ts`. Bug: autosave-driven
// `setContent(patchedBody)` was issuing a full doc replacement which
// landed the cursor at position 0 (the frontmatter opening) after every
// save. The diff produces a minimal `{from, to, insert}` that CM6's
// transaction change-mapping anchors the cursor against.

import { describe, expect, it } from "vitest";
import { diffDoc } from "../../src/editor/doc-diff";

describe("diffDoc — minimal-change diff for CMEditor mirror", () => {
  it("returns null when strings are identical", () => {
    expect(diffDoc("hello", "hello")).toBeNull();
    expect(diffDoc("", "")).toBeNull();
  });

  it("frontmatter `updated:` timestamp swap → only the timestamp byte range", () => {
    const before = "---\nupdated: 2026-05-16T15:48:00.000Z\n---\nhello\n";
    const after = "---\nupdated: 2026-05-16T16:00:42.000Z\n---\nhello\n";
    const d = diffDoc(before, after);
    expect(d).not.toBeNull();
    // Common prefix: "---\nupdated: 2026-05-16T1" (25 chars) — diverges at
    // position 25 where "5" (before) vs "6" (after) differ.
    expect(d!.from).toBe(25);
    // Common suffix shared from byte 36 onwards in `before`.
    expect(before.substring(0, d!.from) + d!.insert + before.substring(d!.to)).toBe(
      after,
    );
    // Body cursor positions (> d.to) are unaffected by the diff.
    expect(d!.to).toBeLessThan(before.indexOf("hello"));
  });

  it("pure append at end → from = current.length, empty replaced range", () => {
    const d = diffDoc("hello", "hello world")!;
    expect(d.from).toBe(5);
    expect(d.to).toBe(5);
    expect(d.insert).toBe(" world");
  });

  it("pure prepend at start → from = 0, no suffix overlap", () => {
    const d = diffDoc("world", "hello world")!;
    expect(d.from).toBe(0);
    expect(d.to).toBe(0);
    expect(d.insert).toBe("hello ");
  });

  it("middle replacement preserves prefix + suffix bytes", () => {
    const d = diffDoc("the brown fox", "the lazy fox")!;
    expect(d.from).toBe(4);
    expect(d.to).toBe(9);
    expect(d.insert).toBe("lazy");
  });

  it("full replacement when no overlap", () => {
    const d = diffDoc("abc", "xyz")!;
    expect(d.from).toBe(0);
    expect(d.to).toBe(3);
    expect(d.insert).toBe("xyz");
  });

  it("empty → text", () => {
    const d = diffDoc("", "hello")!;
    expect(d.from).toBe(0);
    expect(d.to).toBe(0);
    expect(d.insert).toBe("hello");
  });

  it("text → empty", () => {
    const d = diffDoc("hello", "")!;
    expect(d.from).toBe(0);
    expect(d.to).toBe(5);
    expect(d.insert).toBe("");
  });

  it("shared prefix only (suffix differs entirely)", () => {
    const d = diffDoc("hello world", "hello universe")!;
    expect(d.from).toBe(6);
    expect(d.to).toBe(11);
    expect(d.insert).toBe("universe");
  });
});
