// Value-strict `readArchivedFromFmBody` — the read side of the `archived:`
// canonical FM field (note-archive / MYND-331).
//
// `archived:` is the 7th Myne-managed canonical FM field (markdown-dialect
// §3.6.1). It is the exact value-strict twin of `trashed:`: only a valid
// RFC 3339 timestamp marks a note archived; a user's own non-timestamp
// `archived:` value reads as live (unprefixed-field collision mitigation).
// This file covers the read helper only; the patch/surgery side (set, restore,
// mutual exclusion with `trashed:`) lands with the archive action layer.

import { describe, it, expect } from "vitest";
import {
  patchArchivedField,
  readArchivedFromFmBody,
} from "../../src/dialect/surgery";
import { enc, dec } from "./_helpers";

const TS = "2026-06-17T09:30:00Z";
// `readArchivedFromFmBody` takes the FM *body* (between the `---` fences), the
// slice shape `note_titles_batch` + `loadNoteBatch` feed it — same as `trashed:`.
const read = (fmBody: string): string | null => readArchivedFromFmBody(fmBody);
const apply = (src: string, value: string | null): string =>
  dec.decode(patchArchivedField(enc.encode(src), value));

describe("readArchivedFromFmBody — value-strict (FM body input)", () => {
  it("returns the timestamp for a valid RFC 3339 archived value", () => {
    expect(read(`archived: ${TS}\n`)).toBe(TS);
  });
  it("reads a quoted valid value", () => {
    expect(read(`archived: "${TS}"\n`)).toBe(TS);
  });
  it("reads a valid value despite a trailing comment", () => {
    expect(read(`archived: ${TS} # auto\n`)).toBe(TS);
  });
  it("accepts a fractional-second offset timestamp", () => {
    const ts = "2026-06-17T09:30:00.250+02:00";
    expect(read(`archived: ${ts}\n`)).toBe(ts);
  });
  it("returns null for a non-timestamp value (boolean) — note stays live", () => {
    expect(read("archived: true\n")).toBeNull();
  });
  it("returns null for an arbitrary string value", () => {
    expect(read("archived: someproject\n")).toBeNull();
  });
  it("returns null for a structurally-shaped but impossible date", () => {
    expect(read("archived: 2026-13-40T99:99:99Z\n")).toBeNull();
  });
  it("returns null for an FM body with no archived field", () => {
    expect(read("title: Foo\n")).toBeNull();
  });
  it("returns null for an empty FM body", () => {
    expect(read("")).toBeNull();
  });
  it("returns null for an empty archived value", () => {
    expect(read("archived:\n")).toBeNull();
  });
  it("does not confuse `archived:` with `trashed:` on the same body", () => {
    expect(read(`trashed: ${TS}\narchived:\n`)).toBeNull();
  });
});

describe("patchArchivedField — state A (no frontmatter)", () => {
  it("prepends a canonical FM block carrying archived", () => {
    expect(apply("# Hello\n", TS)).toBe(`---\narchived: ${TS}\n---\n\n# Hello\n`);
  });
});

describe("patchArchivedField — state B (FM present, archived absent)", () => {
  it("inserts archived before the closing fence, after existing keys", () => {
    expect(apply("---\ntitle: Foo\n---\n\nbody", TS)).toBe(
      `---\ntitle: Foo\narchived: ${TS}\n---\n\nbody`,
    );
  });
});

describe("patchArchivedField — state C (archived present, replace)", () => {
  it("replaces an existing plain archived value", () => {
    expect(apply("---\narchived: 2020-01-01T00:00:00Z\n---\n\nbody", TS)).toBe(
      `---\narchived: ${TS}\n---\n\nbody`,
    );
  });
});

describe("patchArchivedField — state D (unarchive / delete)", () => {
  it("removes the whole block when archived is the only field (with body)", () => {
    expect(apply(`---\narchived: ${TS}\n---\n\n# Hello`, null)).toBe("# Hello");
  });
  it("drops only the archived line when another key remains", () => {
    expect(apply(`---\ntitle: Foo\narchived: ${TS}\n---\n\nbody`, null)).toBe(
      "---\ntitle: Foo\n---\n\nbody",
    );
  });
  it("is a no-op when frontmatter has no archived field", () => {
    expect(apply("---\ntitle: Foo\n---\n\nbody", null)).toBe(
      "---\ntitle: Foo\n---\n\nbody",
    );
  });
});

describe("patchArchivedField — archive→unarchive round-trip (byte-identity)", () => {
  it("unarchive after archiving a folder note yields the original bytes", () => {
    const original = "---\nfolder: Projects/\n---\n\n# Note";
    const archived = apply(original, TS);
    expect(dec.decode(patchArchivedField(enc.encode(archived), null))).toBe(
      original,
    );
  });
});
