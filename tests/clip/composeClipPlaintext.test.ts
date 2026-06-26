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

  it("composes onto an EMPTY body — provenance FM only, no body content", () => {
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

  it("is the arbitrary-FM surgery path, NOT a managed-field setter (criterion #4)", () => {
    // The composed plaintext must be byte-identical to applying the three
    // provenance keys via `patchFrontmatterField` (the generic arbitrary-FM
    // path `setNoteCover` uses) onto the same root-built base. This proves the
    // provenance keys ride the unmanaged path — no managed-canonical setter is
    // involved, the closed 7-field set is untouched.
    const env = envelope({ markdownBody: "" });
    const out = composeClipPlaintext(env, "");

    let expected = enc.encode(buildInitialPlaintext(null));
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
