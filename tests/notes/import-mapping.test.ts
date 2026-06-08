// Obsidian importer — title leg (MYND-51 task 2) + unified per-file mapping
// with illegal-segment flagging (task 3, story 14 seam).

import { describe, it, expect } from "vitest";
import {
  deriveImportTitle,
  importBasename,
} from "../../src/notes/import/titleMapping";
import { mapImportedFile } from "../../src/notes/import/mapping";

describe("importBasename", () => {
  it("returns the final path segment", () => {
    expect(importBasename("A/B/c.md")).toBe("c.md");
    expect(importBasename("c.md")).toBe("c.md");
  });
});

describe("deriveImportTitle — filename→title read-time default", () => {
  it("strips exactly one trailing .md from the filename", () => {
    expect(deriveImportTitle("Weekly Review.md", null)).toBe("Weekly Review");
    expect(deriveImportTitle("x/Foo.md.md", null)).toBe("Foo.md");
    expect(deriveImportTitle("report.md", null)).toBe("report");
  });

  it("a present FM title: wins over the filename", () => {
    expect(deriveImportTitle("note.md", "Explicit Title")).toBe("Explicit Title");
  });
});

describe("mapImportedFile — plaintext + readTimeTitle + flags", () => {
  it("happy path: folder injected, filename title, no flags", () => {
    const r = mapImportedFile("Projects/spec.md", "# Hi\n");
    expect(r.plaintext).toContain("folder: Projects/");
    expect(r.readTimeTitle).toBe("spec");
    expect(r.illegalFlags).toEqual([]);
  });

  it("NEVER injects a title: field for a file with no FM title:", () => {
    const r = mapImportedFile("Projects/Weekly Review.md", "plain body\n");
    expect(r.plaintext).not.toContain("title:");
    expect(r.readTimeTitle).toBe("Weekly Review"); // read-time only
  });

  it("a present FM title: is preserved (not re-injected) and wins the read-time title", () => {
    const body = "---\ntitle: Real Title\ntags: [x]\n---\n\nbody\n";
    const r = mapImportedFile("p/whatever.md", body);
    expect(r.readTimeTitle).toBe("Real Title");
    expect(r.plaintext).toContain("title: Real Title"); // the file's own, preserved
    expect(r.plaintext).toContain("folder: p/");
    expect(r.plaintext).toContain("tags: [x]");
    expect(r.plaintext).toContain("body");
  });

  it("flags an illegal folder segment, byte-preserved, non-blocking", () => {
    const r = mapImportedFile("Bad#Folder/note.md", "x\n");
    const folderFlag = r.illegalFlags.find((f) => f.kind === "folder");
    expect(folderFlag).toBeDefined();
    expect(folderFlag?.segment).toBe("Bad#Folder");
    expect(folderFlag?.reason).toBe("illegal-char");
    // The illegal segment is preserved verbatim in the composed plaintext.
    expect(r.plaintext).toContain("Bad#Folder");
  });

  it("flags an illegal title segment (title never injected, only flagged)", () => {
    const r = mapImportedFile("p/Note]]End.md", "x\n");
    const titleFlag = r.illegalFlags.find((f) => f.kind === "title");
    expect(titleFlag?.segment).toBe("Note]]End");
    expect(titleFlag?.reason).toBe("illegal-char");
    expect(r.plaintext).not.toContain("title:"); // still not injected
  });

  it("enforces the segment byte cap as a flag, not an error", () => {
    const long = "a".repeat(300);
    const r = mapImportedFile(`${long}/note.md`, "x\n");
    expect(r.illegalFlags.some((f) => f.reason === "segment-too-long")).toBe(true);
  });

  it("is non-blocking — never throws on illegal input", () => {
    expect(() => mapImportedFile("####/||.md", "x")).not.toThrow();
  });

  it("root file: no folder, no flags, body byte-identical", () => {
    const body = "# Root\n\n_kept_ verbatim\n";
    const r = mapImportedFile("root.md", body);
    expect(r.plaintext).toBe(body);
    expect(r.readTimeTitle).toBe("root");
    expect(r.illegalFlags).toEqual([]);
    expect(r.preexistingFolder).toBeNull();
  });
});

describe("mapImportedFile — pre-existing folder: is preserved, never overwritten (C1)", () => {
  it("preserves a user-authored folder: byte-for-byte and reports the discrepancy", () => {
    const body = "---\nfolder: My Own Category\ntags: [x]\n---\n\nbody\n";
    const r = mapImportedFile("Projects/Sub/note.md", body);
    expect(r.plaintext).toBe(body); // byte-identical — no overwrite
    expect(r.preexistingFolder).toEqual({
      existing: "My Own Category",
      derivedFromPath: "Projects/Sub/",
    });
    // derived-folder segment flags are suppressed (the derived folder is unused here)
    expect(r.illegalFlags.filter((f) => f.kind === "folder")).toEqual([]);
  });

  it("does NOT collapse a block-scalar folder: value (the silent-rewrite case)", () => {
    const body = "---\nfolder: >\n  multi\n  line\ntags: [y]\n---\n\nbody\n";
    const r = mapImportedFile("X/note.md", body);
    expect(r.plaintext).toBe(body); // preserved verbatim — nothing collapsed
    expect(r.preexistingFolder).not.toBeNull();
  });

  it("the common case (no folder: in the file) still injects and reports null", () => {
    const r = mapImportedFile("Projects/note.md", "# Hi\n");
    expect(r.preexistingFolder).toBeNull();
    expect(r.plaintext).toContain("folder: Projects/");
  });
});
