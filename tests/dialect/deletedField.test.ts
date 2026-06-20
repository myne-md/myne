// `patchDeletedField` — the write side of the `deleted:` sync-tombstone marker
// (MYND-426 task 1). `deleted:` is the sync deletion tombstone: an under-sync
// delete writes a `deleted: <RFC3339>` version (fresh content_nonce) instead of
// a bare unlink, so the deletion propagates as a version, not an absence. It is
// the value-strict twin of `trashed:`/`archived:` and composes with every other
// managed field. This covers the surgery (A/B/C set + state-D delete).

import { describe, it, expect } from "vitest";
import { patchDeletedField } from "../../src/dialect/surgery";
import { enc, dec } from "./_helpers";

const TS = "2026-06-20T12:00:00Z";
const apply = (src: string, value: string | null): string =>
  dec.decode(patchDeletedField(enc.encode(src), value));

describe("patchDeletedField — set (states A/B/C)", () => {
  it("state A: creates a frontmatter block on an FM-less note", () => {
    const out = apply("# Note body\n", TS);
    expect(out).toBe(`---\ndeleted: ${TS}\n---\n\n# Note body\n`);
  });

  it("state B: inserts into an existing block without an existing key", () => {
    const src = `---\ntitle: Hi\n---\n\nBody\n`;
    const out = apply(src, TS);
    expect(out).toContain(`deleted: ${TS}\n`);
    expect(out).toContain("title: Hi");
  });

  it("state C: replaces an existing deleted value in place", () => {
    const src = `---\ndeleted: 2020-01-01T00:00:00Z\ntitle: Hi\n---\n\nBody\n`;
    const out = apply(src, TS);
    expect(out).toContain(`deleted: ${TS}`);
    expect(out).not.toContain("2020-01-01");
    expect(out).toContain("title: Hi");
  });

  it("composes with another managed field without clobbering it", () => {
    const src = `---\nfolder: Projects/\n---\n\nBody\n`;
    const out = apply(src, TS);
    expect(out).toContain("folder: Projects/");
    expect(out).toContain(`deleted: ${TS}`);
  });
});

describe("patchDeletedField — delete (state D)", () => {
  it("removes only the deleted line, keeping other keys", () => {
    const src = `---\ndeleted: ${TS}\ntitle: Hi\n---\n\nBody\n`;
    const out = apply(src, null);
    expect(out).not.toContain("deleted:");
    expect(out).toContain("title: Hi");
  });

  it("collapses an empty block to an FM-less note", () => {
    const src = `---\ndeleted: ${TS}\n---\n\n# Body\n`;
    const out = apply(src, null);
    expect(out).toBe("# Body\n");
  });

  it("is a no-op when there is no deleted field", () => {
    const src = `---\ntitle: Hi\n---\n\nBody\n`;
    expect(apply(src, null)).toBe(src);
  });
});
