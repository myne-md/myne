// Clip serializer — task 8 (capture-extraction): `capture_kind` discriminator
// + select-text highlight range path.
//
// Both capture shapes (full-article + selection/highlight) feed the SAME
// `serializeClipMarkdown` (ONE code path). This slice pins:
//   - a `full-article` clip serializes the whole readable-article markdown;
//   - a `selection` (highlight) clip serializes ONLY the selected-range
//     markdown — a complete document, not a mis-parsing fragment;
//   - both routes hit the identical serializer (discriminated by `captureKind`);
//   - the typed `ClipInput` carries the provenance fields (`sourceUrl`,
//     `clipDate`) WITHOUT emitting them as body / frontmatter (sub-feature 3);
//   - the contract mirrors sub-feature 1's envelope shape exactly (field names +
//     the `capture_kind` literal set), never redefined here.
//
// `serializeClip` returns a structured `ClipSerializeResult` (task 10): an `ok`
// outcome carries the canonical body in `.markdown`; a `no-content` outcome (no
// extractable content) is covered by `no-content.test.ts`. These task-8 tests
// assert the `ok` body via the helper below.

import { describe, expect, it, vi } from "vitest";
import {
  CAPTURE_KINDS,
  type CaptureKind,
  type ClipInput,
  serializeClip,
} from "../../../src/dialect/clip/captureKind";
import {
  CAPTURE_KINDS as CAPTURE_KINDS_INDEX,
  serializeClip as serializeClipFromIndex,
} from "../../../src/dialect/index";
import { serializeClipMarkdown } from "../../../src/dialect/clip";
import * as clipModule from "../../../src/dialect/clip";
import { assertCanonicalD1 } from "./_rig";

// A realistic readable-article markdown body (the WHOLE article a full clip
// serializes): heading + prose + a list + a link.
const ARTICLE = `# How tides work

The Moon's gravity pulls the ocean toward it.

- A high tide forms on the near side.
- Another forms on the far side.

See the [tide tables](https://example.com/tides) for your area.`;

// A realistic SELECTION markdown body — only the selected range (a couple of
// paragraphs lifted out of the same article), NOT the whole article.
const SELECTION = `Another forms on the far side.

See the [tide tables](https://example.com/tides) for your area.`;

function fullClip(body: string): ClipInput {
  return {
    captureKind: "full-article",
    markdownBody: body,
    sourceUrl: "https://example.com/tides",
    clipDate: "2026-06-20T12:00:00Z",
  };
}

function highlightClip(body: string): ClipInput {
  return {
    captureKind: "selection",
    markdownBody: body,
    sourceUrl: "https://example.com/tides",
    clipDate: "2026-06-20T12:00:00Z",
  };
}

// Serialize a clip and assert the `ok` outcome, returning its canonical body.
// Every body these task-8 tests use carries real content, so the outcome is
// always `ok`; the `no-content` arm is exercised by `no-content.test.ts`.
function okBody(input: ClipInput): string {
  const result = serializeClip(input);
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") throw new Error("expected an `ok` outcome");
  return result.markdown;
}

describe("serializeClip — capture_kind discriminator (full vs highlight)", () => {
  it("a `full-article` clip serializes the WHOLE article markdown", () => {
    const out = okBody(fullClip(ARTICLE));
    // Whole-article canonical emit: the serializer's own output for the body.
    expect(out).toBe(serializeClipMarkdown(ARTICLE));
    // It carries the whole article (heading + both list items + the link).
    expect(out).toContain("# How tides work");
    expect(out).toContain("- A high tide forms on the near side.");
    expect(out).toContain("[tide tables](https://example.com/tides)");
  });

  it("a `selection` (highlight) clip serializes ONLY the selected-range markdown", () => {
    const out = okBody(highlightClip(SELECTION));
    // Only the selected range — identical to serializing the selection body
    // directly; the whole-article content the selection omits is NOT present.
    expect(out).toBe(serializeClipMarkdown(SELECTION));
    expect(out).not.toContain("# How tides work");
    expect(out).not.toContain("A high tide forms on the near side.");
    // What WAS selected is faithfully present.
    expect(out).toContain("Another forms on the far side.");
    expect(out).toContain("[tide tables](https://example.com/tides)");
  });

  it("both shapes feed the IDENTICAL serializer (one code path)", () => {
    const spy = vi.spyOn(clipModule, "serializeClipMarkdown");
    try {
      serializeClip(fullClip(ARTICLE));
      serializeClip(highlightClip(SELECTION));
      // Two clips → two calls into the ONE serializer, discriminated only by
      // which body reached it — no second/forked emit path.
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenNthCalledWith(1, ARTICLE);
      expect(spy).toHaveBeenNthCalledWith(2, SELECTION);
    } finally {
      spy.mockRestore();
    }
  });

  it("routes a `bookmark` clip through the same serializer too", () => {
    // `bookmark` is part of sub-feature 1's closed kind set; a content-light
    // bookmark body still goes through the one path (no forked handling here).
    const body = "[https://example.com](https://example.com)";
    const out = okBody({
      captureKind: "bookmark",
      markdownBody: body,
      sourceUrl: "https://example.com",
      clipDate: "2026-06-20T12:00:00Z",
    });
    expect(out).toBe(serializeClipMarkdown(body));
  });
});

describe("serializeClip — highlight body serializes as a complete document", () => {
  it("a highlight selection round-trips as canonical D1 (a whole document, not a fragment)", () => {
    // The selected-range markdown is a complete best-effort document: it
    // round-trips + is idempotent through the same canonical invariants any
    // full clip satisfies — it is never a fragment that mis-parses.
    assertCanonicalD1(SELECTION);
    const out = okBody(highlightClip(SELECTION));
    expect(out).toBe(serializeClipMarkdown(SELECTION));
  });

  it("a single-line selection still serializes as a complete document", () => {
    const body = "just one *selected* sentence.";
    assertCanonicalD1(body);
    expect(okBody(highlightClip(body))).toBe(serializeClipMarkdown(body));
  });
});

describe("serializeClip — provenance is carried, never emitted", () => {
  it("does NOT emit `sourceUrl` / `clipDate` as body or frontmatter", () => {
    // Provenance rides the envelope and is composed into frontmatter by
    // sub-feature 3 — this slice carries the fields typed but emits NEITHER.
    // Use a distinct provenance URL/date that does NOT appear in the body, so a
    // match could only come from the serializer leaking provenance (it never
    // does — it returns the canonical body unchanged).
    const input: ClipInput = {
      captureKind: "selection",
      markdownBody: "A plain selected sentence with no links.",
      sourceUrl: "https://provenance.example/article-42",
      clipDate: "2026-06-20T09:30:00Z",
    };
    const out = okBody(input);
    expect(out).not.toContain(input.sourceUrl);
    expect(out).not.toContain(input.clipDate);
    // No frontmatter fence emitted at all (sub-feature 3 owns frontmatter).
    expect(out.startsWith("---")).toBe(false);
    expect(out).not.toContain("source:");
    expect(out).not.toContain("clipped:");
    // The body is exactly the canonical emit of the selected markdown.
    expect(out).toBe(serializeClipMarkdown(input.markdownBody));
  });

  it("a highlight clip carries the same provenance fields as a full clip", () => {
    // Field-for-field: both shapes expose the identical provenance contract;
    // only the body + captureKind differ.
    const full = fullClip(ARTICLE);
    const highlight = highlightClip(SELECTION);
    expect(Object.keys(full).sort()).toEqual(Object.keys(highlight).sort());
    expect(full.sourceUrl).toBe(highlight.sourceUrl);
    expect(full.clipDate).toBe(highlight.clipDate);
    // The body the serializer emits ignores provenance entirely (carry, not emit).
    expect(okBody(full)).toBe(serializeClipMarkdown(full.markdownBody));
    expect(okBody(highlight)).toBe(
      serializeClipMarkdown(highlight.markdownBody),
    );
  });
});

describe("serializeClip — contract mirrors sub-feature 1's envelope (not redefined)", () => {
  it("the `CaptureKind` literal set matches the Rust/extension `capture_kind` values", () => {
    // Sub-feature 1's `CaptureKind` (envelope.rs `#[serde(rename_all = "kebab-case")]`
    // → FullArticle/Selection/Bookmark; extension capture.ts/clip.ts mirror).
    // These are the EXACT wire literals — a full clip is `full-article`, a
    // highlight clip is `selection`. We consume them; we do not redefine them.
    expect([...CAPTURE_KINDS].sort()).toEqual(
      ["bookmark", "full-article", "selection"].sort(),
    );
    // A compile-time exhaustiveness check that the type aligns with the runtime
    // set — assigning each literal proves the union has no extra / missing arm.
    const full: CaptureKind = "full-article";
    const selection: CaptureKind = "selection";
    const bookmark: CaptureKind = "bookmark";
    expect(CAPTURE_KINDS).toContain(full);
    expect(CAPTURE_KINDS).toContain(selection);
    expect(CAPTURE_KINDS).toContain(bookmark);
  });

  it("the `ClipInput` field names mirror the envelope's serialization-relevant fields", () => {
    // Envelope (sub-feature 1): markdown_body, capture_kind, source_url,
    // clip_date (+ destination_folder/tags/image_bytes owned elsewhere). The
    // TS contract carries the serialization-relevant subset in camelCase
    // (matching the extension's `CapturedClip`): captureKind, markdownBody,
    // sourceUrl, clipDate.
    const input = fullClip(ARTICLE);
    expect(Object.keys(input).sort()).toEqual(
      ["captureKind", "clipDate", "markdownBody", "sourceUrl"].sort(),
    );
  });

  it("is reachable from the dialect index aggregator", () => {
    expect(serializeClipFromIndex).toBe(serializeClip);
    expect(CAPTURE_KINDS_INDEX).toBe(CAPTURE_KINDS);
  });
});
