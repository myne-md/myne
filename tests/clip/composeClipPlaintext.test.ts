// desktop-ingest task 2 — provenance frontmatter composition (MYND-445).
//
// `composeClipPlaintext` is the PURE composer that turns a validated clip
// envelope (task 1's `ValidatedClipEnvelope`) + a markdown body into the
// plaintext of a ROOT note (SYNC-15: no `folder:` line) carrying provenance
// frontmatter — `source:` / `url:` / `clipped:` — as ORDINARY user-authored
// frontmatter (SYNC-14: the closed 7-field Myne-managed canonical set is NOT
// extended). Provenance rides through the generic arbitrary-frontmatter
// surgery path (`patchFrontmatterField`), NOT any managed-field setter.
//
// These tests pin the five acceptance criteria:
//   1. `source:`/`url:`/`clipped:` are emitted as ordinary FM on a ROOT note
//      (no `folder:` line);
//   2. special characters in URL / date are YAML-scalar-escaped (no broken FM);
//   3. a body that ALREADY carries user frontmatter keeps it untouched
//      alongside the injected provenance (editing/re-saving never strips it);
//   4. the closed managed-canonical field set is NOT extended — the composed
//      plaintext round-trips through `patchFrontmatterField` byte-for-byte, the
//      same arbitrary-FM path `setNoteCover` uses;
//   5. empty-body, body-with-frontmatter, and escaping cases are all covered.
//
// SYNC-14 carries `source:` AND `url:` both set to the single `sourceUrl` — a
// ratified redundancy (the literal three-key decision); the composer follows
// the ledger and emits both.

import { describe, expect, it } from "vitest";
import { composeClipPlaintext } from "../../src/clip/composeClipPlaintext";
import type { ValidatedClipEnvelope } from "../../src/clip/validateClipEnvelope";
import {
  buildInitialPlaintext,
  parse,
  patchFrontmatterField,
  patchTitleField,
} from "../../src/dialect";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A clean validated envelope; spread + override per test. */
function envelope(
  overrides: Partial<ValidatedClipEnvelope> = {},
): ValidatedClipEnvelope {
  return {
    markdownBody: "# Hello\n\nA clean clip body.",
    captureKind: "full-article",
    sourceUrl: "https://example.com/article",
    clipDate: "2026-06-18T12:00:00.000Z",
    imageBytes: [],
    ...overrides,
  };
}

/** Parse and assert the frontmatter block is well-formed (no FM parse error). */
function parsedFrontmatter(plaintext: string): Record<string, unknown> {
  const result = parse(plaintext);
  expect(result.frontmatter.error).toBeNull();
  const parsedData = result.frontmatter.parsed;
  if (parsedData === null) {
    throw new Error(`no frontmatter parsed in:\n${plaintext}`);
  }
  return parsedData;
}

/**
 * Normalize a parsed `clipped:` value to its RFC-3339 string. `clipped:` is an
 * UNMANAGED key emitted as a PLAIN YAML scalar (correct — provenance is not a
 * managed `title:`-class field that forces string quoting), so the canonical
 * js-yaml reader legitimately re-types a bare RFC-3339 timestamp into a `Date`.
 * The value is intact either way; this collapses both representations to the
 * ISO string so the test asserts content, not js-yaml's coercion choice.
 */
function asIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

describe("composeClipPlaintext — provenance frontmatter composition", () => {
  it("emits source/url/clipped as ordinary FM on a root note (no folder line)", () => {
    const env = envelope();
    const out = composeClipPlaintext(env, env.markdownBody);

    // Acceptance #1: the three provenance keys are present...
    expect(out).toContain("source: https://example.com/article");
    expect(out).toContain("url: https://example.com/article");
    expect(out).toContain("clipped: 2026-06-18T12:00:00.000Z");

    // ...and it is a ROOT note — NO `folder:` line (SYNC-15). The composer
    // builds onto `buildInitialPlaintext(null)` which is the empty string.
    expect(buildInitialPlaintext(null)).toBe("");
    expect(out).not.toMatch(/^\s*folder\s*:/m);

    // The body survives below the frontmatter block.
    expect(out).toContain("# Hello");
    expect(out).toContain("A clean clip body.");
  });

  it("sets both source: and url: to the single sourceUrl (SYNC-14 redundancy)", () => {
    const env = envelope({ sourceUrl: "https://news.example/p/42" });
    const out = composeClipPlaintext(env, env.markdownBody);
    expect(out).toContain("source: https://news.example/p/42");
    expect(out).toContain("url: https://news.example/p/42");
  });

  it("emits clipped: from the envelope's normalized RFC-3339 clipDate", () => {
    const env = envelope({ clipDate: "2026-01-02T03:04:05.678Z" });
    const out = composeClipPlaintext(env, env.markdownBody);
    expect(out).toContain("clipped: 2026-01-02T03:04:05.678Z");
  });

  it("composes onto an EMPTY body: the title + provenance FM, no body content", () => {
    const env = envelope({ markdownBody: "" });
    const out = composeClipPlaintext(env, "");

    // The provenance FM is present and parses cleanly.
    const data = parsedFrontmatter(out);
    expect(data["source"]).toBe("https://example.com/article");
    expect(data["url"]).toBe("https://example.com/article");
    expect(asIso(data["clipped"])).toBe("2026-06-18T12:00:00.000Z");
    // The raw on-disk form is the unquoted plain scalar.
    expect(out).toContain("clipped: 2026-06-18T12:00:00.000Z");

    // Still a root note.
    expect(out).not.toMatch(/^\s*folder\s*:/m);
  });

  it("YAML-escapes special characters in the URL (no broken frontmatter)", () => {
    // A URL packed with YAML-hostile characters: a `: ` mapping opener, a ` #`
    // comment opener, quotes, brackets. Unescaped, these break the FM block.
    const nastyUrl = 'https://example.com/a?q="hello world": #frag&x=[1,2]';
    const env = envelope({ sourceUrl: nastyUrl });
    const out = composeClipPlaintext(env, "body");

    // The FM block parses with NO error (escaping worked), and the value
    // round-trips back to the EXACT original string via the canonical reader.
    const data = parsedFrontmatter(out);
    expect(data["source"]).toBe(nastyUrl);
    expect(data["url"]).toBe(nastyUrl);
  });

  it("escapes a value YAML would otherwise re-type or break on", () => {
    // A URL beginning with a YAML-reserved char and containing `: ` — must be
    // quoted to survive as a plain string.
    const env = envelope({ sourceUrl: "@weird: value #with-comment" });
    const out = composeClipPlaintext(env, "body");
    const data = parsedFrontmatter(out);
    expect(data["source"]).toBe("@weird: value #with-comment");
  });

  it("preserves a body's existing user frontmatter alongside provenance", () => {
    // Acceptance #3: a clipped body that already carries user-authored FM keeps
    // every key untouched; provenance is injected alongside, never clobbering.
    const body =
      "---\nauthor: Jane Doe\ntags:\n  - research\n  - web\ncustom: kept value\n---\n\n# Clipped\n\nContent.";
    const env = envelope({ markdownBody: body });
    const out = composeClipPlaintext(env, body);

    const data = parsedFrontmatter(out);

    // Pre-existing user keys survive untouched...
    expect(data["author"]).toBe("Jane Doe");
    expect(data["tags"]).toEqual(["research", "web"]);
    expect(data["custom"]).toBe("kept value");

    // ...and provenance was injected ALONGSIDE them.
    expect(data["source"]).toBe("https://example.com/article");
    expect(data["url"]).toBe("https://example.com/article");
    expect(asIso(data["clipped"])).toBe("2026-06-18T12:00:00.000Z");

    // The body content survives.
    expect(out).toContain("# Clipped");
    expect(out).toContain("Content.");
  });

  it("overwrites a colliding user `source:` key in place (single line, no dup)", () => {
    // If the clipped body already had a `source:` key, the generic surgery path
    // overwrites it in place (state C) rather than duplicating the key.
    const body = "---\nsource: old-user-value\n---\n\nBody.";
    const env = envelope();
    const out = composeClipPlaintext(env, body);
    const data = parsedFrontmatter(out);
    // Provenance wins; exactly one `source:` line.
    expect(data["source"]).toBe("https://example.com/article");
    const sourceLines = out.split("\n").filter((l) => /^source\s*:/.test(l));
    expect(sourceLines).toHaveLength(1);
  });

  it("routes provenance through the arbitrary-FM path and the title through the managed one", () => {
    // The two writers must stay distinguishable (criterion #4, restated by
    // myne-md/myne#936). The three provenance keys ride the GENERIC
    // arbitrary-FM path (`patchFrontmatterField`, the injector `setNoteCover`
    // uses) onto the same root-built base, so no managed-canonical setter is
    // involved and the closed 7-field set is untouched. The `title:` rides the
    // MANAGED writer (`patchTitleField`) instead, because that is exactly what
    // it is: a canonical field, written like every rename writes it. Composing
    // the expected bytes with the two writers in the same order is what proves
    // the split: swap one for the other and this equality breaks.
    const env = envelope({ markdownBody: "" });
    const out = composeClipPlaintext(env, "", "Example Page");

    let expected = enc.encode(buildInitialPlaintext(null));
    expected = patchTitleField(expected, "Example Page");
    expected = patchFrontmatterField(expected, "source", env.sourceUrl);
    expected = patchFrontmatterField(expected, "url", env.sourceUrl);
    expected = patchFrontmatterField(expected, "clipped", env.clipDate);

    expect(out).toBe(dec.decode(expected));
  });

  it("uses the body parameter, NOT envelope.markdownBody, for the content", () => {
    // Task 5 passes an image-rewritten body distinct from envelope.markdownBody;
    // the composer must honour the passed body, not re-read the envelope's.
    const env = envelope({ markdownBody: "ORIGINAL envelope body" });
    const rewritten = "REWRITTEN body with ![[att:abc|pic.png]]";
    const out = composeClipPlaintext(env, rewritten);
    expect(out).toContain("REWRITTEN body with");
    expect(out).not.toContain("ORIGINAL envelope body");
  });
});

// ---------------------------------------------------------------------------
// The managed `title:` (myne-md/myne#936), the key that makes a clip a NAMED
// note instead of "Untitled". A title is read from frontmatter `title:` only
// (decision 0139), so a composer that omits it seals a note with no name, which
// is what every content clip did until this block existed.
// ---------------------------------------------------------------------------

describe("composeClipPlaintext: the managed title", () => {
  it("writes the page title as `title:` so the note is not Untitled", () => {
    const env = envelope();
    const out = composeClipPlaintext(env, env.markdownBody, "A Real Page Title");

    const data = parsedFrontmatter(out);
    expect(data["title"]).toBe("A Real Page Title");
    // Exactly one title line, and it is a real YAML string.
    expect(out.split("\n").filter((l) => /^title\s*:/.test(l))).toHaveLength(1);
    // The body's own heading is still there: the note is named without the
    // captured bytes being rewritten.
    expect(out).toContain("# Hello");
  });

  it("appends the title LAST when the body already carries the user's frontmatter", () => {
    // A clip body can start with frontmatter-ish content (`source:` above is the
    // production case, but a body may carry anything). The managed writer merges
    // into the existing block and keeps every other key.
    const body = "---\ncustom: kept\n---\n\n# Clipped\n\nContent.";
    const out = composeClipPlaintext(envelope(), body, "Named Anyway");

    const data = parsedFrontmatter(out);
    expect(data["title"]).toBe("Named Anyway");
    expect(data["custom"]).toBe("kept");
    expect(data["source"]).toBe("https://example.com/article");
  });

  it("writes an EMPTY title for a page that had none (createNote's house shape)", () => {
    // Not an omission: every new note is created carrying `title: ""` (myne#653),
    // and the read boundary normalizes an empty title back to untitled, so the
    // sidebar still shows the placeholder. Asserted so a future "skip the empty
    // value" tidy-up has to argue with this line.
    const out = composeClipPlaintext(envelope(), "# Untitled capture\n\nBody.", "");
    expect(out).toMatch(/^title: ""$/m);
    expect(parsedFrontmatter(out)["title"]).toBe("");
  });

  it("quotes a title that would otherwise re-type (a date-shaped name)", () => {
    // The managed writer's state matrix quotes a date-/int-/bool-shaped title so
    // js-yaml cannot re-type it; a clip of a page called `2026-06-07` is exactly
    // the case `loadNoteBatch` documents.
    const out = composeClipPlaintext(envelope(), "# 2026-06-07\n\nBody.", "2026-06-07");
    expect(parsedFrontmatter(out)["title"]).toBe("2026-06-07");
  });
});
