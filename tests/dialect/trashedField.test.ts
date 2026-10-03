// patchTrashedField / patchArchivedField (4-state incl. state-D delete) +
// value-strict readTrashedFromFmBody / readArchivedFromFmBody.
//
// `trashed:` and `archived:` are structurally identical Myne-managed canonical FM
// fields (markdown-dialect §3.6.1; MYND-133 / MYND-331). `readArchivedFromFmBody`
// is a line-for-line copy of `readTrashedFromFmBody`, the four archived patchers
// copy the four trashed ones, and all of them funnel into the shared
// `applyStateCImpl`: only the key literal and the `KEY_RE` differ. So the suite
// runs ONCE per key as a keyed parameter rather than being hand-copied per field.
// The one behaviour that is NOT shared: reading one key while the OTHER key is on
// the same body, is pinned separately at the bottom.

import { describe, it, expect } from "vitest";
import {
  patchArchivedField,
  patchTrashedField,
  readArchivedFromFmBody,
  readTrashedFromFmBody,
} from "../../src/dialect/surgery";
import { enc, dec } from "./_helpers";

const TS = "2026-06-03T11:00:00Z";

interface ManagedField {
  readonly key: "trashed" | "archived";
  /** The exported patcher's name, for readable test titles. */
  readonly label: string;
  readonly patch: (bytes: Uint8Array, value: string | null) => Uint8Array;
  readonly read: (fmBody: string) => string | null;
}

const FIELDS: readonly ManagedField[] = [
  {
    key: "trashed",
    label: "patchTrashedField",
    patch: patchTrashedField,
    read: readTrashedFromFmBody,
  },
  {
    key: "archived",
    label: "patchArchivedField",
    patch: patchArchivedField,
    read: readArchivedFromFmBody,
  },
];

for (const { key, label, patch, read } of FIELDS) {
  const apply = (src: string, value: string | null): string =>
    dec.decode(patch(enc.encode(src), value));

  describe(`${label}: state A (no frontmatter)`, () => {
    it("prepends a canonical FM block carrying the field", () => {
      expect(apply("# Hello\n", TS)).toBe(`---\n${key}: ${TS}\n---\n\n# Hello\n`);
    });
  });

  describe(`${label}: state B (FM present, field absent)`, () => {
    it("inserts the field before the closing fence, after existing keys", () => {
      expect(apply("---\ntitle: Foo\n---\n\nbody", TS)).toBe(
        `---\ntitle: Foo\n${key}: ${TS}\n---\n\nbody`,
      );
    });
  });

  describe(`${label}: state C (field present, replace)`, () => {
    it("replaces an existing plain value", () => {
      expect(apply(`---\n${key}: 2020-01-01T00:00:00Z\n---\n\nbody`, TS)).toBe(
        `---\n${key}: ${TS}\n---\n\nbody`,
      );
    });
    it("preserves an existing double-quote style", () => {
      expect(
        apply(`---\n${key}: "2020-01-01T00:00:00Z"\n---\n\nbody`, TS),
      ).toBe(`---\n${key}: "${TS}"\n---\n\nbody`);
    });
    it("preserves a trailing comment on the line", () => {
      expect(
        apply(`---\n${key}: 2020-01-01T00:00:00Z # mark\n---\n\nbody`, TS),
      ).toBe(`---\n${key}: ${TS} # mark\n---\n\nbody`);
    });
  });

  describe(`${label}: state D (delete)`, () => {
    it("removes the whole block when the field is the only one (with body)", () => {
      expect(apply(`---\n${key}: ${TS}\n---\n\n# Hello`, null)).toBe("# Hello");
    });
    it("removes the whole block + trailing blank → empty for an empty body", () => {
      expect(apply(`---\n${key}: ${TS}\n---\n\n`, null)).toBe("");
    });
    it("drops only the field line when another key remains", () => {
      expect(apply(`---\ntitle: Foo\n${key}: ${TS}\n---\n\nbody`, null)).toBe(
        "---\ntitle: Foo\n---\n\nbody",
      );
    });
    it("preserves folder + updated when deleting", () => {
      const src = `---\nfolder: Projects/\nupdated: 2026-01-01T00:00:00Z\n${key}: ${TS}\n---\n\n# Body`;
      expect(apply(src, null)).toBe(
        "---\nfolder: Projects/\nupdated: 2026-01-01T00:00:00Z\n---\n\n# Body",
      );
    });
    it("is a no-op when there is no frontmatter", () => {
      expect(apply("# Hello\n", null)).toBe("# Hello\n");
    });
    it("is a no-op when frontmatter has no such field", () => {
      expect(apply("---\ntitle: Foo\n---\n\nbody", null)).toBe(
        "---\ntitle: Foo\n---\n\nbody",
      );
    });
  });

  describe(`${label}: set→delete round-trip (byte-identity)`, () => {
    it("deleting after setting on a folder note yields the original bytes", () => {
      const original = "---\nfolder: Projects/\n---\n\n# Note";
      const set = apply(original, TS);
      expect(dec.decode(patch(enc.encode(set), null))).toBe(original);
    });
    it("deleting after setting on a bare note yields the bare body", () => {
      const original = "# Just a note\n";
      const set = apply(original, TS);
      expect(dec.decode(patch(enc.encode(set), null))).toBe(original);
    });
  });

  describe(`${label}: C1 byte-stability for other fields`, () => {
    it("touches neither other keys, comments, nor body when setting the field", () => {
      const src =
        "---\nupdated: 2026-01-01T00:00:00Z\ntitle: Foo\ncustom: bar # c\n---\n\n# Body\ntext";
      expect(apply(src, TS)).toBe(
        `---\nupdated: 2026-01-01T00:00:00Z\ntitle: Foo\ncustom: bar # c\n${key}: ${TS}\n---\n\n# Body\ntext`,
      );
    });
  });

  describe(`${label}: value-strict read (FM body input)`, () => {
    it("returns the timestamp for a valid RFC 3339 value", () => {
      expect(read(`${key}: ${TS}\n`)).toBe(TS);
    });
    it("reads a quoted valid value", () => {
      expect(read(`${key}: "${TS}"\n`)).toBe(TS);
    });
    it("reads a valid value despite a trailing comment", () => {
      expect(read(`${key}: ${TS} # auto\n`)).toBe(TS);
    });
    it("accepts a fractional-second offset timestamp", () => {
      const ts = "2026-06-03T11:00:00.250+02:00";
      expect(read(`${key}: ${ts}\n`)).toBe(ts);
    });
    it("returns null for a non-timestamp value (boolean): note stays live", () => {
      expect(read(`${key}: true\n`)).toBeNull();
    });
    it("returns null for an arbitrary string value", () => {
      expect(read(`${key}: someproject\n`)).toBeNull();
    });
    it("returns null for a structurally-shaped but impossible date", () => {
      expect(read(`${key}: 2026-13-40T99:99:99Z\n`)).toBeNull();
    });
    it("returns null for an FM body with no such field", () => {
      expect(read("title: Foo\n")).toBeNull();
    });
    it("returns null for an empty FM body", () => {
      expect(read("")).toBeNull();
    });
    it("returns null for an empty value", () => {
      expect(read(`${key}:\n`)).toBeNull();
    });
  });
}

// The archived reader must not pick up the trashed key (or vice versa) when both
// appear on one body. This is the single behaviour the keyed parameter above
// cannot express, so it is pinned on its own.
describe("readArchivedFromFmBody: does not confuse the two keys", () => {
  it("does not confuse `archived:` with `trashed:` on the same body", () => {
    expect(readArchivedFromFmBody(`trashed: ${TS}\narchived:\n`)).toBeNull();
  });
});
