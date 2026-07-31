// Conflict-diff normalization (MYND-334): strip the managed conflict markers and
// suppress the volatile `updated:` stamp so a conflict compare shows the edit the
// user made, not the timestamp the machine wrote. Pure — no IPC, no jsdom.

import { describe, it, expect } from "vitest";
import { normalizeForDiff, normalizeConflictPair } from "../../src/dialect/diffNormalize";
import { lineDiff, changedLineCount } from "../../src/dialect/diff";

const note = (fm: string, body: string) => `---\n${fm}\n---\n\n${body}`;

describe("normalizeForDiff", () => {
  it("drops a Myne-managed `updated:` stamp", () => {
    const out = normalizeForDiff(note("title: Notes\nupdated: 2026-07-31T10:00:00Z", "Hello"));
    expect(out).toBe(note("title: Notes", "Hello"));
  });

  it("strips the `conflict:` / `conflict_of:` markers", () => {
    const out = normalizeForDiff(
      note("title: Notes\nconflict: true\nconflict_of: 9f1c-uuid", "Hello"),
    );
    expect(out).not.toContain("conflict");
    expect(out).toBe(note("title: Notes", "Hello"));
  });

  it("collapses the frontmatter block when `updated:` was its only field", () => {
    // `patchFrontmatterField`'s empty-block collapse takes the fences and the
    // blank line after them — symmetric across both sides, so the pair still
    // lines up.
    expect(normalizeForDiff(note("updated: 2026-07-31T10:00:00Z", "Hello"))).toBe("Hello");
  });

  it("leaves a note without frontmatter untouched", () => {
    expect(normalizeForDiff("# Hello\n\nplain body")).toBe("# Hello\n\nplain body");
  });

  it("keeps a user-authored non-RFC-3339 `updated:` — value-strict, §3.6.1", () => {
    // The unprefixed-field collision footgun: `updated: soon` is the user's own
    // property, not Myne's stamp, so a divergence on it is a real divergence.
    const out = normalizeForDiff(note("title: Notes\nupdated: soon", "Hello"));
    expect(out).toContain("updated: soon");
  });

  it("is idempotent", () => {
    const once = normalizeForDiff(
      note("title: Notes\nupdated: 2026-07-31T10:00:00Z\nconflict: true", "Hello"),
    );
    expect(normalizeForDiff(once)).toBe(once);
  });

  it("preserves every unmanaged field, including user tags", () => {
    const out = normalizeForDiff(
      note("title: Notes\ntags: [a, b]\ncover: x.png\nupdated: 2026-07-31T10:00:00Z", "Hello"),
    );
    expect(out).toBe(note("title: Notes\ntags: [a, b]\ncover: x.png", "Hello"));
  });
});

describe("normalizeConflictPair", () => {
  const stamp = (iso: string, extra = "") =>
    note(`title: Notes\nupdated: ${iso}${extra}`, "The body prose.");

  it("`updated:`-only divergence normalizes to no change", () => {
    const { mine, theirs } = normalizeConflictPair(
      stamp("2026-07-31T10:00:00Z"),
      stamp("2026-07-31T11:22:33Z", "\nconflict: true\nconflict_of: 9f1c-uuid"),
    );
    expect(mine).toBe(theirs);
    expect(changedLineCount(lineDiff(mine, theirs))).toBe(0);
  });

  it("a genuine title edit still surfaces", () => {
    const { mine, theirs } = normalizeConflictPair(
      note("title: Notes\nupdated: 2026-07-31T10:00:00Z", "The body prose."),
      note(
        "title: Renamed\nupdated: 2026-07-31T11:22:33Z\nconflict: true\nconflict_of: 9f1c-uuid",
        "The body prose.",
      ),
    );
    expect(changedLineCount(lineDiff(mine, theirs))).toBeGreaterThan(0);
    expect(theirs).toContain("title: Renamed");
  });

  it("a genuine tags edit still surfaces", () => {
    const { mine, theirs } = normalizeConflictPair(
      note("tags: [a]\nupdated: 2026-07-31T10:00:00Z", "The body prose."),
      note("tags: [a, b]\nupdated: 2026-07-31T11:22:33Z", "The body prose."),
    );
    expect(changedLineCount(lineDiff(mine, theirs))).toBeGreaterThan(0);
  });

  it("a genuine body edit still surfaces", () => {
    const { mine, theirs } = normalizeConflictPair(
      stamp("2026-07-31T10:00:00Z"),
      note("title: Notes\nupdated: 2026-07-31T11:22:33Z", "The body prose, revised."),
    );
    expect(changedLineCount(lineDiff(mine, theirs))).toBeGreaterThan(0);
  });

  it("never leaks a conflict marker into either side", () => {
    const { mine, theirs } = normalizeConflictPair(
      stamp("2026-07-31T10:00:00Z"),
      stamp("2026-07-31T11:22:33Z", "\nconflict: true\nconflict_of: 9f1c-uuid"),
    );
    expect(mine).not.toContain("conflict");
    expect(theirs).not.toContain("conflict");
  });

  it("tolerates an orphan side with no frontmatter at all", () => {
    const { mine, theirs } = normalizeConflictPair("just prose", stamp("2026-07-31T11:22:33Z"));
    expect(mine).toBe("just prose");
    expect(theirs).toBe(note("title: Notes", "The body prose."));
  });
});
