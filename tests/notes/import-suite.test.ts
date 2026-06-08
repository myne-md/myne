// Obsidian importer — consolidated mapping suite (MYND-51 task 5) + empty-dir
// detection (task 4). Behavior-level: asserts composed plaintext / flags /
// deliberate-folder outputs, not internal call shapes. The full end-to-end
// Obsidian-vault round trip is owned by MYND-90; the filename≠title inbound-
// wikilink mismatch (story 15) is a documented residual MYND-90 covers — no
// resolver change is made here.

import { describe, it, expect } from "vitest";
import { composeImportedFolderPlaintext } from "../../src/notes/import/folderMapping";
import { mapImportedFile } from "../../src/notes/import/mapping";
import { collectDeliberateImportFolders } from "../../src/notes/import/emptyDirs";

describe("empty-dir → deliberate_folders detection (SYNC-4)", () => {
  it("yields an empty source dir with no note beneath it", () => {
    const dirs = ["Projects", "Projects/Empty"];
    const noteFolders = ["Projects/"]; // a note in Projects/, none in Projects/Empty/
    expect(collectDeliberateImportFolders(dirs, noteFolders)).toEqual([
      "Projects/Empty/",
    ]);
  });

  it("does NOT emit a dir that contains a note (covered by the note's folder:)", () => {
    expect(collectDeliberateImportFolders(["Projects"], ["Projects/"])).toEqual([]);
  });

  it("does NOT emit a dir that is an ancestor of a note's folder", () => {
    // a note in A/B/C/ covers A/, A/B/, A/B/C/
    expect(collectDeliberateImportFolders(["A", "A/B", "A/B/C"], ["A/B/C/"])).toEqual(
      [],
    );
  });

  it("emits intermediate empty dirs (no note anywhere beneath)", () => {
    expect(collectDeliberateImportFolders(["A", "A/B"], [])).toEqual(["A/", "A/B/"]);
  });

  it("excludes the vault root and dedups under case-fold identity", () => {
    const dirs = ["", "Notes", "notes"]; // root + a case-only-distinct dup
    expect(collectDeliberateImportFolders(dirs, [])).toEqual(["Notes/"]);
  });
});

describe("illegal-segment classes are each caught by the importer (SYNC-3)", () => {
  // The exhaustive grammar lives in folderPath.test.ts (isLegalSegment); here
  // we confirm the importer wiring flags each representative class via a folder
  // segment, byte-preserved and non-blocking.
  const cases: Array<[string, string]> = [
    ["forbidden #", "Bad#Seg"],
    ["forbidden |", "a|b"],
    ["forbidden ]]", "x]]y"],
    ["leading whitespace", " leading"],
    ["trailing whitespace", "trailing "],
    ["trailing dot", "dot."],
    ["traversal ..", ".."],
  ];
  for (const [name, seg] of cases) {
    it(`flags ${name} in a folder segment, preserved + non-blocking`, () => {
      const r = mapImportedFile(`${seg}/note.md`, "x\n");
      const flag = r.illegalFlags.find((f) => f.kind === "folder");
      expect(flag, name).toBeDefined();
      expect(flag?.segment).toBe(seg); // verbatim, never mutated
      expect(r.plaintext).toContain(seg); // preserved in the folder: value
    });
  }

  it("a control char in a segment is flagged (built from a char code, no literal byte)", () => {
    const seg = "a" + String.fromCharCode(7) + "b"; // embedded BEL (U+0007)
    const r = mapImportedFile(`${seg}/note.md`, "x\n");
    expect(r.illegalFlags.some((f) => f.kind === "folder")).toBe(true);
  });
});

describe("C1 byte-stable guard — only the sanctioned folder: field is added", () => {
  const bodies = [
    "# Heading\n\n__bold__ and _italic_, a [[WikiLink]] and #tag.\n",
    "- [X] uppercase task\n1) alternate marker\n\n> [!NOTE] callout text\n",
    "Setext\n======\n\n    indented code\n\nref [link][1]\n\n[1]: https://x\n",
  ];
  for (const [i, body] of bodies.entries()) {
    it(`body #${i} is byte-identical after stripping the injected folder: block`, () => {
      const out = composeImportedFolderPlaintext("A/B/note.md", body);
      expect(out.replace("---\nfolder: A/B/\n---\n\n", "")).toBe(body);
    });
  }

  it("root body is wholly untouched (no field injected at all)", () => {
    const body = "# Root\n\nverbatim ~~strike~~ and `code`.\n";
    expect(composeImportedFolderPlaintext("root.md", body)).toBe(body);
  });
});
