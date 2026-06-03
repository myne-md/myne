// patchTrashedField (4-state incl. state-D delete on restore) + value-strict
// readTrashedField / isTrashed.
//
// `trashed:` is the 4th Myne-managed canonical FM field (markdown-dialect
// §3.6.1; MYND-133). Write trigger = trash (set, RFC 3339) + restore (state-D
// delete). Mirrors `folderField.test.ts`; adds value-strict read coverage.

import { describe, it, expect } from "vitest";
import {
  patchTrashedField,
  readTrashedFromFmBody,
} from "../../src/dialect/surgery";
import { enc, dec } from "./_helpers";

const TS = "2026-06-03T11:00:00Z";
const apply = (src: string, value: string | null): string =>
  dec.decode(patchTrashedField(enc.encode(src), value));
// `readTrashedFromFmBody` takes the FM *body* (between the `---` fences), which
// is what the Rust `note_titles_batch` slice + `loadNoteBatch` feed it.
const read = (fmBody: string): string | null => readTrashedFromFmBody(fmBody);

describe("patchTrashedField — state A (no frontmatter)", () => {
  it("prepends a canonical FM block carrying trashed", () => {
    expect(apply("# Hello\n", TS)).toBe(
      `---\ntrashed: ${TS}\n---\n\n# Hello\n`,
    );
  });
});

describe("patchTrashedField — state B (FM present, trashed absent)", () => {
  it("inserts trashed before the closing fence, after existing keys", () => {
    expect(apply("---\ntitle: Foo\n---\n\nbody", TS)).toBe(
      `---\ntitle: Foo\ntrashed: ${TS}\n---\n\nbody`,
    );
  });
});

describe("patchTrashedField — state C (trashed present, replace)", () => {
  it("replaces an existing plain trashed value", () => {
    expect(apply("---\ntrashed: 2020-01-01T00:00:00Z\n---\n\nbody", TS)).toBe(
      `---\ntrashed: ${TS}\n---\n\nbody`,
    );
  });
  it("preserves an existing double-quote style", () => {
    expect(
      apply('---\ntrashed: "2020-01-01T00:00:00Z"\n---\n\nbody', TS),
    ).toBe(`---\ntrashed: "${TS}"\n---\n\nbody`);
  });
  it("preserves a trailing comment on the trashed line", () => {
    expect(
      apply("---\ntrashed: 2020-01-01T00:00:00Z # mark\n---\n\nbody", TS),
    ).toBe(`---\ntrashed: ${TS} # mark\n---\n\nbody`);
  });
});

describe("patchTrashedField — state D (restore / delete)", () => {
  it("removes the whole block when trashed is the only field (with body)", () => {
    expect(apply(`---\ntrashed: ${TS}\n---\n\n# Hello`, null)).toBe("# Hello");
  });
  it("removes the whole block + trailing blank → empty for an empty body", () => {
    expect(apply(`---\ntrashed: ${TS}\n---\n\n`, null)).toBe("");
  });
  it("drops only the trashed line when another key remains", () => {
    expect(
      apply(`---\ntitle: Foo\ntrashed: ${TS}\n---\n\nbody`, null),
    ).toBe("---\ntitle: Foo\n---\n\nbody");
  });
  it("preserves folder + updated when restoring", () => {
    const src = `---\nfolder: Projects/\nupdated: 2026-01-01T00:00:00Z\ntrashed: ${TS}\n---\n\n# Body`;
    expect(apply(src, null)).toBe(
      "---\nfolder: Projects/\nupdated: 2026-01-01T00:00:00Z\n---\n\n# Body",
    );
  });
  it("is a no-op when there is no frontmatter", () => {
    expect(apply("# Hello\n", null)).toBe("# Hello\n");
  });
  it("is a no-op when frontmatter has no trashed field", () => {
    expect(apply("---\ntitle: Foo\n---\n\nbody", null)).toBe(
      "---\ntitle: Foo\n---\n\nbody",
    );
  });
});

describe("patchTrashedField — trash→restore round-trip (byte-identity)", () => {
  it("restore after trashing a folder note yields the original bytes", () => {
    const original = "---\nfolder: Projects/\n---\n\n# Note";
    const trashed = apply(original, TS);
    expect(dec.decode(patchTrashedField(enc.encode(trashed), null))).toBe(
      original,
    );
  });
  it("restore after trashing a bare note yields the bare body", () => {
    const original = "# Just a note\n";
    const trashed = apply(original, TS);
    expect(dec.decode(patchTrashedField(enc.encode(trashed), null))).toBe(
      original,
    );
  });
});

describe("patchTrashedField — C1 byte-stability for other fields", () => {
  it("touches neither other keys, comments, nor body when setting trashed", () => {
    const src =
      "---\nupdated: 2026-01-01T00:00:00Z\ntitle: Foo\ncustom: bar # c\n---\n\n# Body\ntext";
    expect(apply(src, TS)).toBe(
      `---\nupdated: 2026-01-01T00:00:00Z\ntitle: Foo\ncustom: bar # c\ntrashed: ${TS}\n---\n\n# Body\ntext`,
    );
  });
});

describe("readTrashedFromFmBody — value-strict (FM body input)", () => {
  it("returns the timestamp for a valid RFC 3339 trashed value", () => {
    expect(read(`trashed: ${TS}\n`)).toBe(TS);
  });
  it("reads a quoted valid value", () => {
    expect(read(`trashed: "${TS}"\n`)).toBe(TS);
  });
  it("reads a valid value despite a trailing comment", () => {
    expect(read(`trashed: ${TS} # auto\n`)).toBe(TS);
  });
  it("accepts a fractional-second offset timestamp", () => {
    const ts = "2026-06-03T11:00:00.250+02:00";
    expect(read(`trashed: ${ts}\n`)).toBe(ts);
  });
  it("returns null for a non-timestamp value (boolean) — note stays live", () => {
    expect(read("trashed: true\n")).toBeNull();
  });
  it("returns null for an arbitrary string value", () => {
    expect(read("trashed: someproject\n")).toBeNull();
  });
  it("returns null for a structurally-shaped but impossible date", () => {
    expect(read("trashed: 2026-13-40T99:99:99Z\n")).toBeNull();
  });
  it("returns null for an FM body with no trashed field", () => {
    expect(read("title: Foo\n")).toBeNull();
  });
  it("returns null for an empty FM body", () => {
    expect(read("")).toBeNull();
  });
  it("returns null for an empty trashed value", () => {
    expect(read("trashed:\n")).toBeNull();
  });
});
