// Surgery — patchUpdatedField fixture tests + invariants.
//
// Each scenario has a paired `<name>.input.md` + `<name>.expected.md`
// under tests/fixtures/dialect/surgery/. The test reads both, applies
// patch with the canonical TEST_ISO, and asserts byte equality.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  patchFirstH1Line,
  patchSourceRanges,
  patchFolderField,
  patchTitleField,
  patchUpdatedField,
  readArchivedFromFmBody,
  readConflictFromFmBody,
  readConflictOfFromFmBody,
  readDeletedFromFmBody,
  readDoneFromFmBody,
  readKindFromFmBody,
  readTemplateFromFmBody,
  readTitleFromFmBody,
  readTrashedFromFmBody,
  readUpdatedFromFmBody,
} from "../../src/dialect/surgery";
import { bytesEqual, dec, enc, fixtureDir } from "./_helpers";

const FIXTURE_DIR = fixtureDir("surgery");
const TITLE_FIXTURE_DIR = fixtureDir("surgery/title");
const H1_FIXTURE_DIR = fixtureDir("surgery/h1");
const TEST_ISO = "2026-05-10T12:00:00Z";
const TEST_TITLE = "Test Note Title";

const fixtures = fs
  .readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith(".input.md"))
  .map((f) => f.replace(/\.input\.md$/, ""))
  .sort();

const titleFixtures = fs
  .readdirSync(TITLE_FIXTURE_DIR)
  .filter((f) => f.endsWith(".input.md"))
  .map((f) => f.replace(/\.input\.md$/, ""))
  .sort();

const h1Fixtures = fs
  .readdirSync(H1_FIXTURE_DIR)
  .filter((f) => f.endsWith(".input.md"))
  .map((f) => f.replace(/\.input\.md$/, ""))
  .sort();

describe("patchUpdatedField — fixtures", () => {
  for (const name of fixtures) {
    it(`fixture: ${name}`, () => {
      const inputBytes = enc.encode(
        fs.readFileSync(path.join(FIXTURE_DIR, `${name}.input.md`), "utf-8"),
      );
      const expectedBytes = enc.encode(
        fs.readFileSync(
          path.join(FIXTURE_DIR, `${name}.expected.md`),
          "utf-8",
        ),
      );
      const actualBytes = patchUpdatedField(inputBytes, TEST_ISO);
      // Decoded comparison gives a readable diff on failure.
      expect(dec.decode(actualBytes)).toBe(dec.decode(expectedBytes));
      expect(bytesEqual(actualBytes, expectedBytes)).toBe(true);
    });
  }
});

describe("patchUpdatedField — invariants", () => {
  it("idempotent: applying the same iso twice yields byte-identical output", () => {
    for (const name of fixtures) {
      const inputBytes = enc.encode(
        fs.readFileSync(path.join(FIXTURE_DIR, `${name}.input.md`), "utf-8"),
      );
      const once = patchUpdatedField(inputBytes, TEST_ISO);
      const twice = patchUpdatedField(once, TEST_ISO);
      expect(bytesEqual(once, twice)).toBe(true);
    }
  });

  it("pure: same input + same iso → same output (no clock dependency)", () => {
    const input = enc.encode("# heading\nbody\n");
    const a = patchUpdatedField(input, TEST_ISO);
    const b = patchUpdatedField(input, TEST_ISO);
    expect(bytesEqual(a, b)).toBe(true);
  });

  it("FM-without-closer takes State A path (treats as no-FM)", () => {
    const input = enc.encode("---\nfoo: bar\nbody no closer\n");
    const result = dec.decode(patchUpdatedField(input, TEST_ISO));
    // State A prepends `---\nupdated: <iso>\n---\n\n` before the original.
    expect(result.startsWith("---\nupdated: " + TEST_ISO + "\n---\n\n")).toBe(true);
    expect(result).toContain("foo: bar");
    expect(result).toContain("body no closer");
  });

  it("never throws on adversarial input", () => {
    const inputs: Uint8Array[] = [
      enc.encode(""),
      enc.encode("---"),
      enc.encode("---\n"),
      enc.encode("---\n---"),
      enc.encode("---\n\0\n---\n"),
      new Uint8Array([0xff, 0xfe, 0xfd]),
    ];
    for (const input of inputs) {
      expect(() => patchUpdatedField(input, TEST_ISO)).not.toThrow();
    }
  });

  it("preserves body bytes outside the FM block (state C)", () => {
    const input = enc.encode(
      "---\nupdated: 2026-01-01T00:00:00Z\n---\n\n# Heading\n**bold** body.\n",
    );
    const result = dec.decode(patchUpdatedField(input, TEST_ISO));
    expect(result).toContain("# Heading\n**bold** body.\n");
  });
});

describe("patchTitleField — fixtures", () => {
  for (const name of titleFixtures) {
    it(`fixture: ${name}`, () => {
      const inputBytes = enc.encode(
        fs.readFileSync(
          path.join(TITLE_FIXTURE_DIR, `${name}.input.md`),
          "utf-8",
        ),
      );
      const expectedBytes = enc.encode(
        fs.readFileSync(
          path.join(TITLE_FIXTURE_DIR, `${name}.expected.md`),
          "utf-8",
        ),
      );
      const actualBytes = patchTitleField(inputBytes, TEST_TITLE);
      expect(dec.decode(actualBytes)).toBe(dec.decode(expectedBytes));
      expect(bytesEqual(actualBytes, expectedBytes)).toBe(true);
    });
  }
});

describe("patchTitleField — invariants", () => {
  it("idempotent: applying the same title twice yields byte-identical output", () => {
    for (const name of titleFixtures) {
      const inputBytes = enc.encode(
        fs.readFileSync(
          path.join(TITLE_FIXTURE_DIR, `${name}.input.md`),
          "utf-8",
        ),
      );
      const once = patchTitleField(inputBytes, TEST_TITLE);
      const twice = patchTitleField(once, TEST_TITLE);
      expect(bytesEqual(once, twice)).toBe(true);
    }
  });

  it("escalates to double-quoted when value contains YAML-unsafe characters", () => {
    const input = enc.encode("---\ntitle: Plain\n---\n\nBody\n");
    const result = dec.decode(patchTitleField(input, "Has: colon and space"));
    // `: ` opens a YAML mapping when unquoted → must be double-quoted.
    expect(result).toContain('title: "Has: colon and space"');
  });

  it("quotes a value YAML would re-type away from a string (date / number / bool)", () => {
    // Regression (MYND-191): a daily note titled `2026-06-07` reads back as a
    // YAML Date (→ Untitled) unless quoted. Same for number- / bool- / null-
    // shaped titles. needsYamlQuoting alone misses these (no reserved char).
    const input = enc.encode("---\ntitle: Plain\n---\n\nbody");
    const date = dec.decode(patchTitleField(input, "2026-06-07"));
    expect(date).toContain('title: "2026-06-07"');
    const num = dec.decode(patchTitleField(input, "42"));
    expect(num).toContain('title: "42"');
    const bool = dec.decode(patchTitleField(input, "true"));
    expect(bool).toContain('title: "true"');
    // A normal title stays unquoted (no behavior change for ordinary titles).
    const plain = dec.decode(patchTitleField(input, "Meeting notes"));
    expect(plain).toContain("title: Meeting notes\n");
  });

  it("quotes a re-typeable value when INSERTING into an existing FM block (state B)", () => {
    // Regression: the common rename path — a note that already carries
    // `updated:` (every autosaved note) or `folder:` but no `title:` line yet.
    // Inserting a date-shaped title here must quote it exactly like state C,
    // else it reads back as a Date → "Untitled". (State B previously used the
    // non-title scalar formatter and emitted it bare.)
    const updatedOnly = enc.encode(
      "---\nupdated: 2026-05-10T12:00:00Z\n---\n\nbody",
    );
    const date = dec.decode(patchTitleField(updatedOnly, "2026-06-07"));
    expect(date).toContain('title: "2026-06-07"');
    const folderOnly = enc.encode("---\nfolder: Daily/\n---\n\nbody");
    const num = dec.decode(patchTitleField(folderOnly, "42"));
    expect(num).toContain('title: "42"');
    // An ordinary title still inserts unquoted.
    const plain = dec.decode(patchTitleField(updatedOnly, "Meeting notes"));
    expect(plain).toContain("title: Meeting notes\n");
  });

  it("escapes embedded double-quotes and backslashes when quoting is forced", () => {
    const input = enc.encode("---\ntitle: Plain\n---\n");
    // Leading `-` is a YAML-reserved start char → forces double-quoting,
    // and the embedded `"` + `\` then need escaping inside the quoted form.
    const result = dec.decode(
      patchTitleField(input, '- value "quoted" and \\ slash'),
    );
    expect(result).toContain(
      'title: "- value \\"quoted\\" and \\\\ slash"',
    );
  });

  it("preserves bytes outside the FM block", () => {
    const input = enc.encode(
      "---\ntitle: Old\n---\n\n# Heading\n**bold** body.\n",
    );
    const result = dec.decode(patchTitleField(input, TEST_TITLE));
    expect(result).toContain("# Heading\n**bold** body.\n");
  });

  it("never throws on adversarial input", () => {
    const inputs: Uint8Array[] = [
      enc.encode(""),
      enc.encode("---"),
      enc.encode("---\n"),
      enc.encode("---\n---"),
      enc.encode("---\n\0\n---\n"),
      new Uint8Array([0xff, 0xfe, 0xfd]),
    ];
    for (const input of inputs) {
      expect(() => patchTitleField(input, TEST_TITLE)).not.toThrow();
    }
  });
});

describe("readTitleFromFmBody — value-strict title read", () => {
  it("reads an unquoted date title as the typed string (the heal path)", () => {
    expect(readTitleFromFmBody("title: 2026-06-07\n")).toBe("2026-06-07");
  });

  it("reads unquoted int / bool titles as their literal text", () => {
    expect(readTitleFromFmBody("title: 42\n")).toBe("42");
    expect(readTitleFromFmBody("title: true\n")).toBe("true");
  });

  it("unwraps double- and single-quoted scalars", () => {
    expect(readTitleFromFmBody('title: "2026-06-07"\n')).toBe("2026-06-07");
    expect(readTitleFromFmBody("title: 'Plain'\n")).toBe("Plain");
  });

  it("strips an unquoted trailing comment", () => {
    expect(readTitleFromFmBody("title: 2026-06-07 # daily\n")).toBe(
      "2026-06-07",
    );
  });

  it("returns null for a missing, empty, or block-scalar title", () => {
    expect(readTitleFromFmBody("folder: Daily/\n")).toBeNull();
    expect(readTitleFromFmBody("title:\n")).toBeNull();
    expect(readTitleFromFmBody("title: |\n  multi\n")).toBeNull();
    expect(readTitleFromFmBody("")).toBeNull();
  });
});

describe("patchFirstH1Line — fixtures", () => {
  for (const name of h1Fixtures) {
    it(`fixture: ${name}`, () => {
      const inputBytes = enc.encode(
        fs.readFileSync(
          path.join(H1_FIXTURE_DIR, `${name}.input.md`),
          "utf-8",
        ),
      );
      const expectedBytes = enc.encode(
        fs.readFileSync(
          path.join(H1_FIXTURE_DIR, `${name}.expected.md`),
          "utf-8",
        ),
      );
      const actualBytes = patchFirstH1Line(inputBytes, TEST_TITLE);
      expect(dec.decode(actualBytes)).toBe(dec.decode(expectedBytes));
      expect(bytesEqual(actualBytes, expectedBytes)).toBe(true);
    });
  }
});

describe("patchFirstH1Line — invariants", () => {
  it("idempotent: applying the same H1 twice yields byte-identical output", () => {
    for (const name of h1Fixtures) {
      const inputBytes = enc.encode(
        fs.readFileSync(
          path.join(H1_FIXTURE_DIR, `${name}.input.md`),
          "utf-8",
        ),
      );
      const once = patchFirstH1Line(inputBytes, TEST_TITLE);
      const twice = patchFirstH1Line(once, TEST_TITLE);
      expect(bytesEqual(once, twice)).toBe(true);
    }
  });

  it("strips embedded newlines from the value (defensive)", () => {
    const input = enc.encode("# Old\nBody.\n");
    const result = dec.decode(patchFirstH1Line(input, "Multi\nLine\rTitle"));
    expect(result).toBe("# Multi Line Title\nBody.\n");
  });

  it("does NOT treat `#hashtag` as an H1 (CommonMark strict: space required)", () => {
    const input = enc.encode("#hashtag-like\nbody\n");
    const result = dec.decode(patchFirstH1Line(input, TEST_TITLE));
    // No H1 → prepend path with separator.
    expect(result.startsWith("# " + TEST_TITLE + "\n\n")).toBe(true);
    expect(result).toContain("#hashtag-like");
  });

  it("skips H2/H3/etc. when looking for the first H1", () => {
    const input = enc.encode("## H2 first\n### H3 next\n# Real H1\nbody\n");
    const result = dec.decode(patchFirstH1Line(input, TEST_TITLE));
    expect(result).toBe("## H2 first\n### H3 next\n# Test Note Title\nbody\n");
  });

  it("never throws on adversarial input", () => {
    const inputs: Uint8Array[] = [
      enc.encode(""),
      enc.encode("---"),
      enc.encode("---\n"),
      enc.encode("---\n---"),
      enc.encode("# "),
      new Uint8Array([0xff, 0xfe, 0xfd]),
    ];
    for (const input of inputs) {
      expect(() => patchFirstH1Line(input, TEST_TITLE)).not.toThrow();
    }
  });
});

describe("patchSourceRanges — happy paths", () => {
  it("single-range replacement", () => {
    const input = enc.encode("Hello world");
    const result = dec.decode(
      patchSourceRanges(input, [{ start: 6, end: 11 }], ["Earth"]),
    );
    expect(result).toBe("Hello Earth");
  });

  it("multiple non-overlapping ranges in source order", () => {
    const input = enc.encode("a + b + c");
    const result = dec.decode(
      patchSourceRanges(
        input,
        [
          { start: 0, end: 1 },
          { start: 4, end: 5 },
          { start: 8, end: 9 },
        ],
        ["X", "Y", "Z"],
      ),
    );
    expect(result).toBe("X + Y + Z");
  });

  it("multiple non-overlapping ranges out of order — auto-sorted before applying", () => {
    const input = enc.encode("a + b + c");
    const result = dec.decode(
      patchSourceRanges(
        input,
        [
          { start: 8, end: 9 },
          { start: 0, end: 1 },
          { start: 4, end: 5 },
        ],
        ["Z", "X", "Y"],
      ),
    );
    expect(result).toBe("X + Y + Z");
  });

  it("empty replacement (deletion)", () => {
    const input = enc.encode("abcdef");
    const result = dec.decode(
      patchSourceRanges(input, [{ start: 2, end: 4 }], [""]),
    );
    expect(result).toBe("abef");
  });

  it("replacement longer than the source range", () => {
    const input = enc.encode("ab");
    const result = dec.decode(
      patchSourceRanges(input, [{ start: 1, end: 2 }], ["XYZ"]),
    );
    expect(result).toBe("aXYZ");
  });

  it("replacement shorter than the source range", () => {
    const input = enc.encode("abcdef");
    const result = dec.decode(
      patchSourceRanges(input, [{ start: 1, end: 5 }], ["X"]),
    );
    expect(result).toBe("aXf");
  });

  it("bytes outside any range preserved byte-identical", () => {
    const input = enc.encode("prefix MIDDLE suffix");
    const result = patchSourceRanges(
      input,
      [{ start: 7, end: 13 }],
      ["~~~"],
    );
    expect(dec.decode(result)).toBe("prefix ~~~ suffix");
    // Spot-check: prefix bytes (positions 0..6) byte-equal to input.
    for (let i = 0; i < 7; i++) {
      expect(result[i]).toBe(input[i]);
    }
  });

  it("zero ranges returns input unchanged", () => {
    const input = enc.encode("untouched");
    const result = patchSourceRanges(input, [], []);
    expect(dec.decode(result)).toBe("untouched");
  });
});

describe("patchSourceRanges — defensive throws", () => {
  it("throws when ranges and replacements have different lengths", () => {
    const input = enc.encode("abcd");
    expect(() =>
      patchSourceRanges(input, [{ start: 0, end: 1 }], ["X", "Y"]),
    ).toThrow(/length/);
  });

  it("throws on overlapping ranges", () => {
    const input = enc.encode("abcdef");
    expect(() =>
      patchSourceRanges(
        input,
        [
          { start: 0, end: 3 },
          { start: 2, end: 5 },
        ],
        ["X", "Y"],
      ),
    ).toThrow(/overlap/i);
  });

  it("throws on out-of-bounds range (end > length)", () => {
    const input = enc.encode("abc");
    expect(() =>
      patchSourceRanges(input, [{ start: 0, end: 5 }], ["X"]),
    ).toThrow(/bounds/i);
  });

  it("throws on out-of-bounds range (start < 0)", () => {
    const input = enc.encode("abc");
    expect(() =>
      patchSourceRanges(input, [{ start: -1, end: 2 }], ["X"]),
    ).toThrow(/bounds/i);
  });

  it("throws on inverted range (start > end)", () => {
    const input = enc.encode("abc");
    expect(() =>
      patchSourceRanges(input, [{ start: 2, end: 1 }], ["X"]),
    ).toThrow(/bounds/i);
  });
});

// ── myne#321: a managed key is COLUMN ZERO, always ──────────────────────────
//
// The twelve key regexes began `^([ \t]*`, so every reader and every writer
// matched a key nested inside somebody else's mapping.
//
// The write half fires unconditionally: `patchUpdatedField` runs on every save,
// so a note carrying the ordinary `seo:` / `dates:` / `meta:` shape had its
// NESTED value silently rewritten each time while the top-level key was never
// inserted — the user's own value destroyed, and sort-by-updated permanently
// broken for that note. The read half forges note STATE: a nested `deleted:`
// with a parseable timestamp made a note vanish from the sidebar, Trash,
// Conflicts, Archive and the template picker with no recovery affordance.
//
// The package already gets this right in `frontmatterSequence` and in the Rust
// twin; only this file was indent-blind, and it is the one on the hot path.
describe("managed keys are top-level only (myne#321)", () => {
  const nested = (key: string, value: string) =>
    `---\nseo:\n  ${key}: ${value}\n---\n\n# Body\n`;

  describe("writers insert a top-level key instead of patching a nested one", () => {
    it("patchUpdatedField — the every-save path", () => {
      const out = dec.decode(
        patchUpdatedField(enc.encode(nested("updated", "2020-01-01T00:00:00Z")), TEST_ISO),
      );
      expect(out).toContain("  updated: 2020-01-01T00:00:00Z");
      expect(out).toContain(`\nupdated: ${TEST_ISO}`);
    });

    it("patchTitleField — the importer's title injection", () => {
      // The exact failure the injection exists to prevent: `seo.title`
      // overwritten with the filename, and the note STILL landing "Untitled".
      const out = dec.decode(
        patchTitleField(enc.encode(nested("title", "Site Name")), "My Note"),
      );
      expect(out).toContain("  title: Site Name");
      expect(out).toContain("\ntitle: My Note");
    });
  });

  describe("readers ignore a nested key", () => {
    const fmBody = (key: string, value: string) => `seo:\n  ${key}: ${value}\n`;

    it("readTitleFromFmBody", () => {
      expect(readTitleFromFmBody(fmBody("title", "Nested"))).toBeNull();
    });

    it("readUpdatedFromFmBody", () => {
      expect(readUpdatedFromFmBody(fmBody("updated", "2026-04-01T00:00:00Z"))).toBeNull();
    });

    it("readDeletedFromFmBody — the one that made a note vanish", () => {
      expect(readDeletedFromFmBody(fmBody("deleted", "2026-04-01T00:00:00Z"))).toBeNull();
    });

    it("readTrashedFromFmBody", () => {
      expect(readTrashedFromFmBody(fmBody("trashed", "2026-04-01T00:00:00Z"))).toBeNull();
    });

    it("readArchivedFromFmBody", () => {
      expect(readArchivedFromFmBody(fmBody("archived", "2026-04-01T00:00:00Z"))).toBeNull();
    });

    it("readTemplateFromFmBody — the one that moved a note into Templates", () => {
      expect(readTemplateFromFmBody(fmBody("template", "true"))).toBe(false);
    });

    it("readKindFromFmBody — the one that force-rendered a canvas", () => {
      expect(readKindFromFmBody(fmBody("kind", "drawing"))).not.toBe("drawing");
    });

    it("readConflictFromFmBody / readConflictOfFromFmBody", () => {
      expect(readConflictFromFmBody(fmBody("conflict", "true"))).toBe(false);
      expect(readConflictOfFromFmBody(fmBody("conflict_of", "abc"))).toBeNull();
    });

    it("readDoneFromFmBody", () => {
      expect(readDoneFromFmBody(fmBody("done", "2026-04-01"))).toBeNull();
    });
  });

  it("a top-level key is still read and patched", () => {
    // The rule narrows what counts as managed; it must not stop the managed
    // keys working.
    expect(readTitleFromFmBody("title: Real\n")).toBe("Real");
    const out = dec.decode(
      patchUpdatedField(enc.encode("---\nupdated: 2020-01-01T00:00:00Z\n---\n\n# B\n"), TEST_ISO),
    );
    expect(out).toContain(`updated: ${TEST_ISO}`);
    expect(out).not.toContain("2020-01-01");
  });
});

// ── myne#324: a managed write replaces the whole LOGICAL value ──────────────
//
// `applyStateCImpl` rewrote only the key line, and consumed continuations only
// in its block-scalar branch — and there only while they were both indented and
// non-blank. Everything else left the old value's continuation lines welded onto
// the new one.
//
// Where the leftovers still parsed, the rename or move silently produced a
// mangled value with nothing in the UI to explain it. Where they did not,
// js-yaml threw on the whole block, `loadNoteBatch` caught it and returned `{}`,
// and the note lost its title, folder, updated timestamp, tags and cover at
// once — showing "Untitled" and unfiled, with the raw-slice title fallback not
// reached, because an empty parsed map is not the same as an absent one. The
// corrupted text is then re-encrypted to disk by the ordinary overwrite path.
//
// Reachable from any imported note (the importer preserves rawText byte for
// byte) or any hand-edited frontmatter.
describe("multi-line YAML values (myne#324)", () => {
  const title = (src: string, v = "New") => dec.decode(patchTitleField(enc.encode(src), v));

  it("a block scalar containing a blank line", () => {
    // The loop used to stop at the blank line, leaving `  Note: x` behind and
    // making js-yaml throw "bad indentation of a mapping entry".
    const out = title("---\ntitle: |\n  My\n\n  Note: x\nfolder: work\n---\n\nbody\n");
    expect(out).toBe("---\ntitle: New\nfolder: work\n---\n\nbody\n");
  });

  it("a multi-line PLAIN scalar", () => {
    const out = title("---\ntitle: My\n  Note\nfolder: w\n---\n\nb\n");
    expect(out).toBe("---\ntitle: New\nfolder: w\n---\n\nb\n");
  });

  it("a multi-line double-quoted scalar", () => {
    const out = title('---\ntitle: "My\n  Note"\nfolder: w\n---\n\nb\n');
    expect(out).toBe("---\ntitle: New\nfolder: w\n---\n\nb\n");
  });

  it("a multi-line value on another managed field", () => {
    const out = dec.decode(
      patchFolderField(enc.encode("---\nfolder: a\n  b\n---\n\nb\n"), "z"),
    );
    expect(out).toBe("---\nfolder: z\n---\n\nb\n");
  });

  it("does not eat the NEXT top-level key", () => {
    // The bound that matters in the other direction: consuming too much would
    // delete a sibling field.
    const out = title("---\ntitle: Old\nfolder: keep\nupdated: 2020-01-01T00:00:00Z\n---\n\nb\n");
    expect(out).toContain("folder: keep");
    expect(out).toContain("updated: 2020-01-01T00:00:00Z");
  });

  it("does not eat a blank line that ends the value", () => {
    const out = title("---\ntitle: Old\n\nfolder: keep\n---\n\nb\n");
    expect(out).toContain("folder: keep");
  });
});
