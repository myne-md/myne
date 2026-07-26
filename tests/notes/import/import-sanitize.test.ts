// @vitest-environment jsdom
//
// Import sanitizer — the security boundary (MYND-580).
//
// jsdom is required, not incidental: DOMPurify's default export only binds to a
// window when one exists (in a bare node environment it stays an unbound factory),
// and the sanitizer returns a DOM fragment.
//
// This suite exists because the import allowlist is security-load-bearing and is
// WIDER than the render allowlist (it permits structural elements plus `href`/`src`).
// The grill (2026-07-25 R3) required the widening be expressed as a reviewable delta
// and gated; these tests are the mechanical half of that gate.

import { describe, expect, it } from "vitest";
import { SANITIZE_CONFIG } from "@myne/editor/html/sanitize";
import {
  IMPORT_DELTA_ATTR,
  IMPORT_DELTA_TAGS,
  IMPORT_SANITIZE_CONFIG,
  SAFE_URI_REGEXP,
  sanitizeImportedHtml,
} from "../../../src/notes/import/html/sanitize";

const tags = (): readonly string[] =>
  IMPORT_SANITIZE_CONFIG["ALLOWED_TAGS"] as readonly string[];
const attrs = (): readonly string[] =>
  IMPORT_SANITIZE_CONFIG["ALLOWED_ATTR"] as readonly string[];

async function clean(raw: string): Promise<string> {
  const frag = await sanitizeImportedHtml(raw);
  const host = document.createElement("div");
  // Reading serialized output for assertions only. `frag` came from the sanitizer
  // detached; this local element is never inserted into `document`.
  host.appendChild(frag);
  return host.innerHTML;
}

describe("import allowlist is a delta over the render allowlist", () => {
  it("contains every render tag (cannot desynchronize)", () => {
    for (const t of SANITIZE_CONFIG["ALLOWED_TAGS"] as readonly string[]) {
      expect(tags()).toContain(t);
    }
  });

  it("adds exactly the documented delta and nothing else", () => {
    const renderTags = new Set(SANITIZE_CONFIG["ALLOWED_TAGS"] as readonly string[]);
    const added = tags().filter((t) => !renderTags.has(t));
    expect([...added].sort()).toEqual([...IMPORT_DELTA_TAGS].sort());
  });

  it("adds exactly href/src/alt to the attribute list", () => {
    const renderAttr = new Set(SANITIZE_CONFIG["ALLOWED_ATTR"] as readonly string[]);
    const added = attrs().filter((a) => !renderAttr.has(a));
    expect([...added].sort()).toEqual([...IMPORT_DELTA_ATTR].sort());
  });

  it("never permits style, id, data-* or aria-*", () => {
    expect(attrs()).not.toContain("style");
    expect(attrs()).not.toContain("id");
    expect(IMPORT_SANITIZE_CONFIG["ALLOW_DATA_ATTR"]).toBe(false);
    expect(IMPORT_SANITIZE_CONFIG["ALLOW_ARIA_ATTR"]).toBe(false);
  });

  it("does not mutate the render config by importing it", () => {
    expect(SANITIZE_CONFIG["ALLOWED_TAGS"]).toHaveLength(8);
    expect(SANITIZE_CONFIG["ALLOWED_ATTR"]).toEqual(["title", "class"]);
  });
});

describe("script-bearing markup never survives", () => {
  it("strips <script> entirely", async () => {
    const out = await clean('<p>ok</p><script>alert(1)</script>');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(1)");
  });

  it("strips <iframe>, <object>, <embed>, <style>", async () => {
    const out = await clean(
      '<iframe src="https://e.test"></iframe><object></object><embed><style>p{}</style>',
    );
    expect(out).not.toMatch(/<(iframe|object|embed|style)/);
  });

  it("strips every on* handler", async () => {
    const out = await clean('<p onclick="steal()" onmouseover="x()">t</p>');
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("onmouseover");
    expect(out).toContain("t");
  });

  it("keeps the text of a removed element (KEEP_CONTENT)", async () => {
    const out = await clean("<article><h1>Title</h1></article>");
    expect(out).toContain("Title");
  });
});

describe("URL scheme narrowing", () => {
  const allowed = [
    "https://example.test/x",
    "http://example.test/x",
    "mailto:a@b.test",
    "relative/path.md",
    "./sibling.md",
    "../parent.md",
    "Page%20Title%201a2b.md",
    "#anchor",
    // Schemes are case-insensitive (RFC 3986 §3.1) and real-world exports do
    // emit them uppercased; DOMPurify does not fold case before testing, so the
    // pattern must. Without these the link would silently lose its `href`.
    "HTTPS://example.test/x",
    "HtTp://example.test/x",
    "MAILTO:a@b.test",
  ];
  const rejected = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "JAVASCRIPT:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "DATA:text/html;base64,PHNjcmlwdD4=",
    "file:///etc/passwd",
    "FILE:///etc/passwd",
    "vbscript:msgbox",
    // Near-misses on the recognizing arm must fall through to the relative arm
    // and be rejected there — the `i` flag widens neither.
    "httpsx://evil.test",
    "https:/evil.test",
    "mailtox:a@b.test",
  ];

  it.each(allowed)("permits %s", (url) => {
    expect(SAFE_URI_REGEXP.test(url)).toBe(true);
  });

  it.each(rejected)("rejects %s", (url) => {
    expect(SAFE_URI_REGEXP.test(url)).toBe(false);
  });

  it("drops a javascript: href at the sanitizer layer", async () => {
    const out = await clean('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toContain("javascript");
    expect(out).toContain("click");
  });

  it("keeps a plain https href", async () => {
    const out = await clean('<a href="https://example.test/">link</a>');
    expect(out).toContain("https://example.test/");
  });
});
