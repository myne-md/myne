// patchTemplateField (4-state incl. state-D delete on convert-back) +
// value-strict readTemplateFromFmBody.
//
// `template:` is the 5th Myne-managed canonical FM field (markdown-dialect
// §3.6.1; MYND-186) — the inverse-visibility twin of `trashed:`. Write trigger =
// template create / convert (set, canonical `true`) + convert-back (state-D
// delete). Mirrors `trashedField.test.ts`; adds value-strict boolean read
// coverage and the `template:` + `trashed:` composition contract.

import { describe, it, expect } from "vitest";
import {
  patchTemplateField,
  patchTitleField,
  patchTrashedField,
  patchUpdatedField,
  readTemplateFromFmBody,
  readTrashedFromFmBody,
  TEMPLATE_FLAG_VALUE,
} from "../../src/dialect/surgery";
import { enc, dec } from "./_helpers";

const TS = "2026-06-03T11:00:00Z";
const apply = (src: string, value: string | null): string =>
  dec.decode(patchTemplateField(enc.encode(src), value));
const setTrashed = (src: string, value: string | null): string =>
  dec.decode(patchTrashedField(enc.encode(src), value));
// `readTemplateFromFmBody` takes the FM *body* (between the `---` fences), which
// is what the Rust `note_titles_batch` slice + `loadNoteBatch` feed it.
const read = (fmBody: string): boolean => readTemplateFromFmBody(fmBody);

describe("patchTemplateField — state A (no frontmatter)", () => {
  it("prepends a canonical FM block carrying template: true", () => {
    expect(apply("# Hello\n", TEMPLATE_FLAG_VALUE)).toBe(
      "---\ntemplate: true\n---\n\n# Hello\n",
    );
  });
});

describe("patchTemplateField — state B (FM present, template absent)", () => {
  it("inserts template before the closing fence, after existing keys", () => {
    expect(apply("---\ntitle: Meeting\n---\n\nbody", TEMPLATE_FLAG_VALUE)).toBe(
      "---\ntitle: Meeting\ntemplate: true\n---\n\nbody",
    );
  });
});

describe("patchTemplateField — state C (template present, replace)", () => {
  it("rewrites a non-canonical plain value to canonical true", () => {
    expect(apply("---\ntemplate: yes\n---\n\nbody", TEMPLATE_FLAG_VALUE)).toBe(
      "---\ntemplate: true\n---\n\nbody",
    );
  });
  it("preserves an existing double-quote style", () => {
    expect(
      apply('---\ntemplate: "false"\n---\n\nbody', TEMPLATE_FLAG_VALUE),
    ).toBe('---\ntemplate: "true"\n---\n\nbody');
  });
  it("preserves a trailing comment on the template line", () => {
    expect(
      apply("---\ntemplate: false # flag\n---\n\nbody", TEMPLATE_FLAG_VALUE),
    ).toBe("---\ntemplate: true # flag\n---\n\nbody");
  });
});

describe("patchTemplateField — state D (convert-back / delete)", () => {
  it("removes the whole block when template is the only field (with body)", () => {
    expect(apply("---\ntemplate: true\n---\n\n# Hello", null)).toBe("# Hello");
  });
  it("removes the whole block + trailing blank → empty for an empty body", () => {
    expect(apply("---\ntemplate: true\n---\n\n", null)).toBe("");
  });
  it("drops only the template line when another key remains", () => {
    expect(apply("---\ntitle: Foo\ntemplate: true\n---\n\nbody", null)).toBe(
      "---\ntitle: Foo\n---\n\nbody",
    );
  });
  it("is a no-op when there is no frontmatter", () => {
    expect(apply("# Hello\n", null)).toBe("# Hello\n");
  });
  it("is a no-op when frontmatter has no template field", () => {
    expect(apply("---\ntitle: Foo\n---\n\nbody", null)).toBe(
      "---\ntitle: Foo\n---\n\nbody",
    );
  });
});

describe("patchTemplateField — convert→convert-back round-trip (byte-identity)", () => {
  it("convert-back after marking a titled note yields the original bytes", () => {
    const original = "---\ntitle: Meeting\n---\n\n# Note";
    const marked = apply(original, TEMPLATE_FLAG_VALUE);
    expect(dec.decode(patchTemplateField(enc.encode(marked), null))).toBe(
      original,
    );
  });
  it("convert-back after marking a bare note yields the bare body", () => {
    const original = "# Just a note\n";
    const marked = apply(original, TEMPLATE_FLAG_VALUE);
    expect(dec.decode(patchTemplateField(enc.encode(marked), null))).toBe(
      original,
    );
  });
});

describe("patchTemplateField — C1 byte-stability for other fields", () => {
  it("touches neither other keys, comments, nor body when setting template", () => {
    const src =
      "---\nupdated: 2026-01-01T00:00:00Z\ntitle: Foo\ncustom: bar # c\n---\n\n# Body\ntext";
    expect(apply(src, TEMPLATE_FLAG_VALUE)).toBe(
      "---\nupdated: 2026-01-01T00:00:00Z\ntitle: Foo\ncustom: bar # c\ntemplate: true\n---\n\n# Body\ntext",
    );
  });
});

describe("readTemplateFromFmBody — value-strict boolean (FM body input)", () => {
  it("returns true for the canonical unquoted true", () => {
    expect(read("template: true\n")).toBe(true);
  });
  it("returns true despite a trailing comment", () => {
    expect(read("template: true # mine\n")).toBe(true);
  });
  it("returns false for template: 1 (note stays ordinary)", () => {
    expect(read("template: 1\n")).toBe(false);
  });
  it("returns false for template: yes", () => {
    expect(read("template: yes\n")).toBe(false);
  });
  it("returns false for capitalized True (case-sensitive)", () => {
    expect(read("template: True\n")).toBe(false);
  });
  it("returns false for a quoted \"true\" (YAML string, not the boolean)", () => {
    expect(read('template: "true"\n')).toBe(false);
  });
  it("returns false for template: false", () => {
    expect(read("template: false\n")).toBe(false);
  });
  it("returns false for an FM body with no template field", () => {
    expect(read("title: Foo\n")).toBe(false);
  });
  it("returns false for an empty FM body", () => {
    expect(read("")).toBe(false);
  });
  it("returns false for an empty template value", () => {
    expect(read("template:\n")).toBe(false);
  });
});

// === T4 — unknown-field preservation: template: + trashed: compose ===
//
// The two Myne-managed markers are independent flags on the same blob; neither
// patcher clobbers the other or any user-authored field (§3.6 preservation rule).
// Helper to slice the FM body (between the `---` fences) out of full note bytes,
// matching what loadNoteBatch feeds the value-strict readers.
function fmBodyOf(source: string): string {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(source);
  return m ? (m[1] ?? "") : "";
}

describe("template: + trashed: composition (no clobbering)", () => {
  it("setting template on a blob that already carries trashed preserves trashed + user fields", () => {
    const src = `---\ntags: [a, b]\ntrashed: ${TS}\n---\n\n# Body`;
    const out = apply(src, TEMPLATE_FLAG_VALUE);
    expect(out).toBe(
      `---\ntags: [a, b]\ntrashed: ${TS}\ntemplate: true\n---\n\n# Body`,
    );
    const body = fmBodyOf(out);
    expect(readTrashedFromFmBody(body)).toBe(TS);
    expect(readTemplateFromFmBody(body)).toBe(true);
  });

  it("setting trashed on a blob that already carries template preserves template + user fields", () => {
    const src = "---\ntags: [a, b]\ntemplate: true\n---\n\n# Body";
    const out = setTrashed(src, TS);
    expect(out).toBe(
      `---\ntags: [a, b]\ntemplate: true\ntrashed: ${TS}\n---\n\n# Body`,
    );
    const body = fmBodyOf(out);
    expect(readTemplateFromFmBody(body)).toBe(true);
    expect(readTrashedFromFmBody(body)).toBe(TS);
  });

  it("a blob can carry both flags at once; both read back correctly", () => {
    const body = `template: true\ntrashed: ${TS}`;
    expect(readTemplateFromFmBody(body)).toBe(true);
    expect(readTrashedFromFmBody(body)).toBe(TS);
  });

  it("deleting template leaves trashed and user fields intact", () => {
    const src = `---\ntags: [a, b]\ntemplate: true\ntrashed: ${TS}\n---\n\n# Body`;
    const out = apply(src, null);
    expect(out).toBe(`---\ntags: [a, b]\ntrashed: ${TS}\n---\n\n# Body`);
    expect(readTrashedFromFmBody(fmBodyOf(out))).toBe(TS);
  });
});

// === T5 — editing a template (rename / save) preserves the template: flag ===
//
// Editing a template routes through the same paths any note uses — rename =
// patchTitleField + patchUpdatedField, autosave = patchUpdatedField — none of
// which touch the `template:` line. No dedicated "edit template" op exists.
describe("template flag survives note-edit surgery", () => {
  it("a title rewrite (rename path) leaves template: true intact", () => {
    const src = "---\ntitle: Old\ntemplate: true\n---\n\n# Body";
    const renamed = dec.decode(patchTitleField(enc.encode(src), "New name"));
    expect(renamed).toContain("template: true");
    expect(readTemplateFromFmBody(fmBodyOf(renamed))).toBe(true);
    expect(renamed).toContain("title: New name");
  });

  it("an updated: stamp (autosave path) leaves template: true intact", () => {
    const src = "---\ntemplate: true\n---\n\n# Body edited";
    const saved = dec.decode(
      patchUpdatedField(enc.encode(src), "2026-06-07T12:00:00Z"),
    );
    expect(readTemplateFromFmBody(fmBodyOf(saved))).toBe(true);
    expect(saved).toContain("updated: 2026-06-07T12:00:00Z");
  });
});
