// patchFolderIndexField (set canonical true / state-D delete on undesignate) +
// value-strict readFolderIndexFromFmBody.
//
// `folder_index:` is the 6th Myne-managed canonical FM field (markdown-dialect
// §3.6.1; MYND-370). Write trigger = folder-note designate (set, canonical `true`)
// + undesignate (state-D delete). Mirrors `templateField.test.ts`; adds the
// value-strict boolean read coverage and the composition contract with the other
// managed flags. Unlike `template:`/`trashed:`, this flag does NOT hide the note —
// but that is a derivation/consumer concern, not a surgery concern, so the
// byte-level contracts here are identical to `template:`.

import { describe, it, expect } from "vitest";
import {
  patchFolderField,
  patchFolderIndexField,
  patchTemplateField,
  patchTitleField,
  patchTrashedField,
  patchUpdatedField,
  readFolderIndexFromFmBody,
  readTemplateFromFmBody,
  readTrashedFromFmBody,
  FOLDER_INDEX_FLAG_VALUE,
  TEMPLATE_FLAG_VALUE,
} from "../../src/dialect/surgery";
import { enc, dec } from "./_helpers";

const TS = "2026-06-03T11:00:00Z";
const apply = (src: string, on: boolean): string =>
  dec.decode(patchFolderIndexField(enc.encode(src), on));
// `readFolderIndexFromFmBody` takes the FM *body* (between the `---` fences),
// which is what the Rust `note_titles_batch` slice + `loadNoteBatch` feed it.
const read = (fmBody: string): boolean => readFolderIndexFromFmBody(fmBody);

function fmBodyOf(source: string): string {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(source);
  return m ? (m[1] ?? "") : "";
}

describe("FOLDER_INDEX_FLAG_VALUE", () => {
  it("is the canonical unquoted true", () => {
    expect(FOLDER_INDEX_FLAG_VALUE).toBe("true");
  });
});

describe("patchFolderIndexField — set (no frontmatter)", () => {
  it("prepends a canonical FM block carrying folder_index: true", () => {
    expect(apply("# Hello\n", true)).toBe(
      "---\nfolder_index: true\n---\n\n# Hello\n",
    );
  });
});

describe("patchFolderIndexField — set (FM present, flag absent)", () => {
  it("inserts folder_index before the closing fence, after existing keys", () => {
    expect(apply("---\nfolder: Projects/\n---\n\nbody", true)).toBe(
      "---\nfolder: Projects/\nfolder_index: true\n---\n\nbody",
    );
  });
});

describe("patchFolderIndexField — set (flag present, replace)", () => {
  it("rewrites a non-canonical plain value to canonical true", () => {
    expect(apply("---\nfolder_index: yes\n---\n\nbody", true)).toBe(
      "---\nfolder_index: true\n---\n\nbody",
    );
  });
  it("preserves a trailing comment on the folder_index line", () => {
    expect(apply("---\nfolder_index: no # flag\n---\n\nbody", true)).toBe(
      "---\nfolder_index: true # flag\n---\n\nbody",
    );
  });
});

describe("patchFolderIndexField — unset (state-D delete)", () => {
  it("removes the whole block when folder_index is the only field (with body)", () => {
    expect(apply("---\nfolder_index: true\n---\n\n# Hello", false)).toBe(
      "# Hello",
    );
  });
  it("removes the whole block + trailing blank → empty for an empty body", () => {
    expect(apply("---\nfolder_index: true\n---\n\n", false)).toBe("");
  });
  it("drops only the folder_index line when another key remains", () => {
    expect(
      apply("---\nfolder: Projects/\nfolder_index: true\n---\n\nbody", false),
    ).toBe("---\nfolder: Projects/\n---\n\nbody");
  });
  it("is a no-op when there is no frontmatter", () => {
    expect(apply("# Hello\n", false)).toBe("# Hello\n");
  });
  it("is a no-op when frontmatter has no folder_index field", () => {
    expect(apply("---\nfolder: Projects/\n---\n\nbody", false)).toBe(
      "---\nfolder: Projects/\n---\n\nbody",
    );
  });
});

describe("patchFolderIndexField — designate→undesignate round-trip (byte-identity)", () => {
  it("undesignate after designating a foldered note yields the original bytes", () => {
    const original = "---\nfolder: Projects/\n---\n\n# Note";
    const marked = apply(original, true);
    expect(dec.decode(patchFolderIndexField(enc.encode(marked), false))).toBe(
      original,
    );
  });
});

describe("readFolderIndexFromFmBody — value-strict boolean (FM body input)", () => {
  it("returns true for the canonical unquoted true", () => {
    expect(read("folder_index: true\n")).toBe(true);
  });
  it("returns true despite a trailing comment", () => {
    expect(read("folder_index: true # mine\n")).toBe(true);
  });
  it("returns false for folder_index: 1 (note stays ordinary)", () => {
    expect(read("folder_index: 1\n")).toBe(false);
  });
  it("returns false for folder_index: yes", () => {
    expect(read("folder_index: yes\n")).toBe(false);
  });
  it("returns false for capitalized True (case-sensitive)", () => {
    expect(read("folder_index: True\n")).toBe(false);
  });
  it("returns false for a quoted \"true\" (YAML string, not the boolean)", () => {
    expect(read('folder_index: "true"\n')).toBe(false);
  });
  it("returns false for folder_index: false", () => {
    expect(read("folder_index: false\n")).toBe(false);
  });
  it("returns false for an FM body with no folder_index field", () => {
    expect(read("folder: Projects/\n")).toBe(false);
  });
  it("returns false for an empty FM body", () => {
    expect(read("")).toBe(false);
  });
  it("returns false for an empty folder_index value", () => {
    expect(read("folder_index:\n")).toBe(false);
  });
});

// === composition: folder_index: + template: + trashed: + folder: compose ===
describe("folder_index composes with the other managed flags (no clobbering)", () => {
  it("designating on a blob with folder + trashed + template preserves all", () => {
    const src = `---\nfolder: Projects/\ntemplate: true\ntrashed: ${TS}\n---\n\n# Body`;
    const out = apply(src, true);
    expect(out).toBe(
      `---\nfolder: Projects/\ntemplate: true\ntrashed: ${TS}\nfolder_index: true\n---\n\n# Body`,
    );
    const body = fmBodyOf(out);
    expect(readFolderIndexFromFmBody(body)).toBe(true);
    expect(readTemplateFromFmBody(body)).toBe(true);
    expect(readTrashedFromFmBody(body)).toBe(TS);
  });

  it("undesignating leaves folder, template, and trashed intact", () => {
    const src = `---\nfolder: Projects/\nfolder_index: true\ntemplate: true\ntrashed: ${TS}\n---\n\n# Body`;
    const out = apply(src, false);
    expect(out).toBe(
      `---\nfolder: Projects/\ntemplate: true\ntrashed: ${TS}\n---\n\n# Body`,
    );
    const body = fmBodyOf(out);
    expect(readFolderIndexFromFmBody(body)).toBe(false);
    expect(readTemplateFromFmBody(body)).toBe(true);
    expect(readTrashedFromFmBody(body)).toBe(TS);
  });

  it("a folder move (patchFolderField) leaves folder_index: true intact", () => {
    const src = "---\nfolder: Projects/\nfolder_index: true\n---\n\n# Body";
    const moved = dec.decode(patchFolderField(enc.encode(src), "Work/"));
    expect(readFolderIndexFromFmBody(fmBodyOf(moved))).toBe(true);
    expect(moved).toContain("folder: Work/");
  });
});

// === folder_index flag survives ordinary note-edit surgery ===
describe("folder_index flag survives note-edit surgery", () => {
  it("a title rewrite (rename path) leaves folder_index: true intact", () => {
    const src = "---\ntitle: Old\nfolder_index: true\n---\n\n# Body";
    const renamed = dec.decode(patchTitleField(enc.encode(src), "New name"));
    expect(readFolderIndexFromFmBody(fmBodyOf(renamed))).toBe(true);
    expect(renamed).toContain("title: New name");
  });

  it("an updated: stamp (autosave path) leaves folder_index: true intact", () => {
    const src = "---\nfolder_index: true\n---\n\n# Body edited";
    const saved = dec.decode(
      patchUpdatedField(enc.encode(src), "2026-06-07T12:00:00Z"),
    );
    expect(readFolderIndexFromFmBody(fmBodyOf(saved))).toBe(true);
    expect(saved).toContain("updated: 2026-06-07T12:00:00Z");
  });

  it("setting template on a folder-index note keeps both flags", () => {
    const src = "---\nfolder_index: true\n---\n\n# Body";
    const out = dec.decode(
      patchTemplateField(enc.encode(src), TEMPLATE_FLAG_VALUE),
    );
    const body = fmBodyOf(out);
    expect(readFolderIndexFromFmBody(body)).toBe(true);
    expect(readTemplateFromFmBody(body)).toBe(true);
  });

  it("setting trashed on a folder-index note keeps both flags", () => {
    const src = "---\nfolder_index: true\n---\n\n# Body";
    const out = dec.decode(patchTrashedField(enc.encode(src), TS));
    const body = fmBodyOf(out);
    expect(readFolderIndexFromFmBody(body)).toBe(true);
    expect(readTrashedFromFmBody(body)).toBe(TS);
  });
});
