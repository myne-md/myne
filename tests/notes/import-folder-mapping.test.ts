// Obsidian importer — folder leg of the path→note mapping (MYND-51, task 1).
//
// Covers: relative-path → canonical `folder:` derivation, root → no field,
// deep nesting, case-fold identity, un-normalized tolerance, and the C1
// guarantee that only the sanctioned `folder:` field is injected (body bytes
// preserved). The full end-to-end Obsidian-vault round trip is owned by MYND-90.

import { describe, it, expect } from "vitest";
import {
  deriveImportFolder,
  injectImportFolder,
  composeImportedFolderPlaintext,
} from "../../src/notes/import/folderMapping";
import { folderKey } from "../../src/dialect/folderPath";
import { buildInitialPlaintext } from "../../src/dialect/surgery";

describe("deriveImportFolder", () => {
  it("derives the canonical trailing-slash folder from the parent dir", () => {
    expect(deriveImportFolder("Projects/Myne/spec.md")).toBe("Projects/Myne/");
  });

  it("returns null for a vault-root file (no parent dir)", () => {
    expect(deriveImportFolder("spec.md")).toBeNull();
  });

  it("preserves arbitrary nesting depth", () => {
    expect(deriveImportFolder("A/B/C/D/note.md")).toBe("A/B/C/D/");
  });

  it("tolerates un-normalized paths: duplicate + leading slashes collapse", () => {
    expect(deriveImportFolder("Projects//Myne/spec.md")).toBe("Projects/Myne/");
    expect(deriveImportFolder("/Projects/spec.md")).toBe("Projects/");
  });
});

describe("folderKey — shared folder identity (case-fold + NFC)", () => {
  it("folds case-only-distinct folders to one identity", () => {
    expect(folderKey("Projects/")).toBe(folderKey("projects/"));
    expect(folderKey("Projects/Myne/")).toBe("projects/myne/");
  });

  it("root (null) folds to empty string", () => {
    expect(folderKey(null)).toBe("");
  });

  it("agrees with the derived folder for case-only-distinct dirs", () => {
    expect(folderKey(deriveImportFolder("Projects/spec.md"))).toBe(
      folderKey(deriveImportFolder("projects/other.md")),
    );
  });
});

describe("composeImportedFolderPlaintext — C1-safe folder injection", () => {
  it("injects folder: into a note that has no frontmatter, preserving the body", () => {
    expect(composeImportedFolderPlaintext("Projects/Myne/spec.md", "# Hello\n")).toBe(
      "---\nfolder: Projects/Myne/\n---\n\n# Hello\n",
    );
  });

  it("root file with an empty body yields empty plaintext (== buildInitialPlaintext(null))", () => {
    expect(composeImportedFolderPlaintext("spec.md", "")).toBe("");
    expect(composeImportedFolderPlaintext("spec.md", "")).toBe(
      buildInitialPlaintext(null),
    );
  });

  it("root file with a body leaves the body byte-identical (no FM injected)", () => {
    const body = "# Root note\n\nsome **non-canonical** _body_.\n";
    expect(composeImportedFolderPlaintext("note.md", body)).toBe(body);
  });

  it("merges folder: into an existing Obsidian frontmatter block, preserving other keys + body", () => {
    const body = "---\ntags: [book, draft]\naliases:\n  - PKM\n---\n\nbody **kept** verbatim\n";
    const out = composeImportedFolderPlaintext("Reading/spec.md", body);
    expect(out).toContain("folder: Reading/");
    expect(out).toContain("tags: [book, draft]");
    expect(out).toContain("aliases:");
    expect(out).toContain("body **kept** verbatim");
  });

  it("only the folder: field differs — every other byte is preserved (C1 / SYNC-9)", () => {
    const body = "# Title\n\nLine with `code`, [[WikiLink]], #tag, and ~~strike~~.\n";
    const out = composeImportedFolderPlaintext("A/B/note.md", body);
    // Strip the single injected folder: FM block and the original must reappear intact.
    const withoutInjectedFm = out.replace("---\nfolder: A/B/\n---\n\n", "");
    expect(withoutInjectedFm).toBe(body);
  });
});

describe("injectImportFolder — equivalence with the empty-body twin", () => {
  it("empty body + folder equals buildInitialPlaintext(folder)", () => {
    expect(injectImportFolder("", "Projects/")).toBe(buildInitialPlaintext("Projects/"));
  });

  it("null folder is a no-op on the body", () => {
    const body = "untouched\n";
    expect(injectImportFolder(body, null)).toBe(body);
  });
});
