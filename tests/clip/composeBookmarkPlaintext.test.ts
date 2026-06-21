// url-bookmark task 3 — desktop bookmark body + provenance composition
// (MYND-447, browser-extension epic, sub-feature 5 `url-bookmark`).
//
// `composeBookmarkPlaintext` is the PURE composer for a SYNC-16 content-light
// bookmark note: body = the source URL as a BARE AUTOLINK (a bare URL on its own
// line — the welcomeNote / `myne.md` precedent, click-to-open in the editor) and
// the page title as the note's NAME (managed `title:`, via `patchTitleField`).
// Provenance — `source:` (URL) + `clipped:` (RFC-3339 date) — rides as UNMANAGED,
// preserved frontmatter via `patchFrontmatterField` (SYNC-14/SYNC-16). NO `url:`
// key (that is a clip-only SYNC-14 redundancy); a bookmark carries `title:` +
// `source:` + `clipped:` only.
//
// These tests pin the acceptance criteria:
//   1. body is the bare-autolink URL (a bare URL on its own line — NOT
//      `[text](url)`), and the title rides as the managed `title:` (a real name,
//      not "Untitled");
//   2. `title:` via the MANAGED canonical path (`patchTitleField`); `source:` +
//      `clipped:` via the UNMANAGED arbitrary-FM path (`patchFrontmatterField`);
//   3. the composed FM round-trips to `{ title, source, clipped }`;
//   4. `clipped:` is RFC-3339-shaped;
//   5. it is a ROOT note (no `folder:` line, SYNC-15) and carries NO `url:` key.

import { describe, expect, it } from "vitest";
import { composeBookmarkPlaintext } from "../../src/clip/composeBookmarkPlaintext";
import {
  buildInitialPlaintext,
  parse,
  patchFrontmatterField,
  patchTitleField,
} from "../../src/dialect";

const enc = new TextEncoder();
const dec = new TextDecoder();

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

/** Collapse a parsed `clipped:` value (Date or string) to its ISO string. The
 *  unmanaged plain scalar legitimately re-types a bare RFC-3339 timestamp into a
 *  `Date`; the value is intact either way. */
function asIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

describe("composeBookmarkPlaintext — content-light bookmark composition", () => {
  it("body is the bare-autolink URL, title is the managed note name", () => {
    const out = composeBookmarkPlaintext({
      url: "https://example.com/page",
      title: "Example Page",
      clippedDate: "2026-06-18T12:00:00.000Z",
    });

    // The URL rides as a BARE URL on its own line (click-to-open) — NOT a
    // `[text](url)` markdown link.
    expect(out).toContain("https://example.com/page");
    expect(out).not.toContain("[Example Page](https://example.com/page)");
    // The body line below the FM block is exactly the bare URL.
    const afterFm = out.replace(/^---\n[\s\S]*?\n---\n\n?/, "");
    expect(afterFm.trim()).toBe("https://example.com/page");

    // The title is the managed note NAME (frontmatter `title:`), not a body H1.
    expect(out).toMatch(/^title: /m);
    expect(afterFm).not.toContain("# Example Page");
  });

  it("round-trips to { title, source, clipped } (no url: key)", () => {
    const out = composeBookmarkPlaintext({
      url: "https://news.example/p/42",
      title: "Big Story",
      clippedDate: "2026-01-02T03:04:05.678Z",
    });
    const data = parsedFrontmatter(out);

    expect(data["title"]).toBe("Big Story");
    expect(data["source"]).toBe("https://news.example/p/42");
    expect(asIso(data["clipped"])).toBe("2026-01-02T03:04:05.678Z");

    // A bookmark carries NO `url:` key (that is a clip-only SYNC-14 redundancy).
    expect("url" in data).toBe(false);
    expect(out).not.toMatch(/^url\s*:/m);
  });

  it("clipped: is RFC-3339-shaped on disk (unquoted plain scalar)", () => {
    const out = composeBookmarkPlaintext({
      url: "https://example.com",
      title: "T",
      clippedDate: "2026-06-18T12:00:00.000Z",
    });
    expect(out).toContain("clipped: 2026-06-18T12:00:00.000Z");
  });

  it("is a ROOT note — no folder: line (SYNC-15)", () => {
    const out = composeBookmarkPlaintext({
      url: "https://example.com",
      title: "T",
      clippedDate: "2026-06-18T12:00:00.000Z",
    });
    expect(buildInitialPlaintext(null)).toBe("");
    expect(out).not.toMatch(/^\s*folder\s*:/m);
  });

  it("reuses the canonical surgery layer (patchTitleField + patchFrontmatterField)", () => {
    // The composed plaintext must be byte-identical to chaining the canonical
    // helpers: the bare-URL body, then the MANAGED `title:` (`patchTitleField`),
    // then UNMANAGED `source:` + `clipped:` (`patchFrontmatterField`). This pins
    // that the title rides the managed-canonical path and provenance the generic
    // arbitrary-FM path — exactly as the spec prescribes.
    const url = "https://example.com/page";
    const title = "Example Page";
    const clippedDate = "2026-06-18T12:00:00.000Z";

    const out = composeBookmarkPlaintext({ url, title, clippedDate });

    let expected = enc.encode(buildInitialPlaintext(null) + url + "\n");
    expected = patchTitleField(expected, title);
    expected = patchFrontmatterField(expected, "source", url);
    expected = patchFrontmatterField(expected, "clipped", clippedDate);

    expect(out).toBe(dec.decode(expected));
  });

  it("YAML-escapes a title and URL packed with FM-hostile characters", () => {
    const url = 'https://example.com/a?q="x": #frag&y=[1,2]';
    const title = 'Weird: title #with "quotes"';
    const out = composeBookmarkPlaintext({
      url,
      title,
      clippedDate: "2026-06-18T12:00:00.000Z",
    });
    const data = parsedFrontmatter(out);
    expect(data["title"]).toBe(title);
    expect(data["source"]).toBe(url);
  });
});
