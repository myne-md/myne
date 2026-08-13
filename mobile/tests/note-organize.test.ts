import { describe, it, expect } from "vitest";
import { patchTrashedField, patchArchivedField } from "../src/dialect/surgery";
import {
  readNoteFlags,
  isLiveNote,
  frontmatterBody,
  bodyAfterFrontmatter,
  frontmatterTitle,
} from "../src/lib/note-organize";

const enc = new TextEncoder();
const dec = new TextDecoder();
const patch = (text: string, fn: (b: Uint8Array) => Uint8Array) => dec.decode(fn(enc.encode(text)));

describe("note-organize flags", () => {
  it("a plain note (no frontmatter) has no flags and is live", () => {
    const f = readNoteFlags("# Hello\n\nbody");
    expect(f).toEqual({ trashed: null, archived: null, deleted: null, template: false, conflict: false });
    expect(isLiveNote(f)).toBe(true);
  });

  it("trashing writes an RFC-3339 timestamp that reads back byte-exact (surgery round-trip)", () => {
    const iso = "2026-07-04T12:00:00.000Z";
    const text = patch("# Note\n\nbody", (b) => patchTrashedField(b, iso));
    expect(text.startsWith(`---\ntrashed: ${iso}\n---\n\n`)).toBe(true);
    const f = readNoteFlags(text);
    expect(f.trashed).toBe(iso);
    expect(isLiveNote(f)).toBe(false);
  });

  it("an archived note is not live", () => {
    const text = patch("body", (b) => patchArchivedField(b, "2026-07-04T00:00:00.000Z"));
    expect(readNoteFlags(text).archived).toBe("2026-07-04T00:00:00.000Z");
    expect(isLiveNote(readNoteFlags(text))).toBe(false);
  });

  it("a bare `trashed: true` is NOT a valid trash (value-strict RFC 3339 only)", () => {
    expect(readNoteFlags("---\ntrashed: true\n---\nbody").trashed).toBeNull();
  });
});

describe("frontmatter split + title", () => {
  const text = "---\ntitle: Hi\n---\n\n# Body\ntext";

  it("frontmatterBody returns the inner FM block", () => {
    expect(frontmatterBody(text)).toBe("title: Hi\n");
  });

  it("bodyAfterFrontmatter excludes the FM block", () => {
    expect(bodyAfterFrontmatter(text)).toContain("# Body");
    expect(bodyAfterFrontmatter(text)).not.toContain("title:");
  });

  it("frontmatterTitle reads the managed title, null when absent", () => {
    expect(frontmatterTitle(text)).toBe("Hi");
    expect(frontmatterTitle("# No frontmatter")).toBeNull();
  });
});
