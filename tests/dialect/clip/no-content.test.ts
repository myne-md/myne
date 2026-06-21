// Clip serializer — task 10 (capture-extraction): surface the "no extractable
// content" outcome to the popup.
//
// When the handed-off markdown is empty / Defuddle found no readable article (a
// pure web app, an empty page), the extraction path must surface a STRUCTURED
// "no-content" outcome rather than producing an empty or garbage note. This
// slice owns the SERIALIZER-SIDE signal: a typed no-content result from the
// public `serializeClip` entry, DISTINCT from a valid-but-short clip.
//
// Boundary alignment: the no-content outcome is the desktop-serializer analogue
// of the extension's `error.reason === "nothing_to_clip"` (myne-clipper/src/
// background/clip.ts) — the popup (sub-feature 4) renders its "nothing was
// saved" body from either signal. This slice does NOT own the popup wording
// (sub-feature 4's UX) or the lock/unlocked gating (sub-features 1/4) — only the
// typed signal + the guarantee the serializer never fabricates a body.

import { describe, expect, it } from "vitest";
import {
  serializeClip,
  type ClipInput,
  type ClipSerializeResult,
} from "../../../src/dialect/clip/captureKind";
import { serializeClip as serializeClipFromIndex } from "../../../src/dialect/index";

function clip(body: string): ClipInput {
  return {
    captureKind: "full-article",
    markdownBody: body,
    sourceUrl: "https://example.com/whatever",
    clipDate: "2026-06-20T12:00:00Z",
  };
}

describe("serializeClip — no-content outcome (empty / no readable article)", () => {
  it("yields a structured `no-content` outcome for empty input (not a throw, not an empty note)", () => {
    const result = serializeClip(clip(""));
    expect(result.kind).toBe("no-content");
    // It is NOT an `ok` with an empty body — the serializer fabricates nothing.
    expect("markdown" in result).toBe(false);
  });

  it("yields `no-content` for whitespace-only input", () => {
    const result = serializeClip(clip("   \n\n  \t\n"));
    expect(result.kind).toBe("no-content");
  });

  it("yields `no-content` for input the walker emits nothing from (a comment-only body)", () => {
    // A `%%…%%` comment is full-dropped (§6), so a body that is ONLY a comment
    // re-emits to nothing — that is no extractable content, not a garbage note.
    const result = serializeClip(clip("%%just an editor comment%%"));
    expect(result.kind).toBe("no-content");
  });

  it("never returns an `ok` result carrying an empty or whitespace-only body", () => {
    for (const body of ["", "   ", "\n\n\n", "\t \n \t", "%%c%%"]) {
      const result = serializeClip(clip(body));
      if (result.kind === "ok") {
        expect(result.markdown.trim()).not.toBe("");
      } else {
        expect(result.kind).toBe("no-content");
      }
    }
  });
});

describe("serializeClip — a valid SHORT clip is `ok`, distinguishable from no-content", () => {
  it("a one-word clip is `ok` with that content (NOT no-content)", () => {
    const result = serializeClip(clip("Hello"));
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.markdown).toContain("Hello");
    }
  });

  it("a single short paragraph is `ok` with its content", () => {
    const result = serializeClip(clip("One short sentence."));
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.markdown).toBe("One short sentence.");
    }
  });

  it("an images-only article is `ok` (it emits image references, task 9 — NOT no-content)", () => {
    const result = serializeClip(clip("![a photo](https://example.com/p.png)"));
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      // Task 9: emits the canonical `clip-image:N` seam reference — real content.
      expect(result.markdown).toContain("clip-image:0");
    }
  });

  it("no-content and a valid-short clip are DISTINGUISHABLE by the discriminant", () => {
    const empty = serializeClip(clip("   "));
    const short = serializeClip(clip("x"));
    expect(empty.kind).not.toBe(short.kind);
    expect(empty.kind).toBe("no-content");
    expect(short.kind).toBe("ok");
  });
});

describe("serializeClip — the outcome is a typed shape the popup can switch on", () => {
  it("the result is a discriminated union the caller switches on (`kind`)", () => {
    // The popup (sub-feature 4) renders by switching on `kind`: an `ok` carries
    // the body to ingest, a `no-content` drives the "nothing to clip here"
    // message. Exhaustive switch — every branch is reachable + typed.
    const cases: ClipInput[] = [clip("real content"), clip("   ")];
    for (const input of cases) {
      const result: ClipSerializeResult = serializeClip(input);
      switch (result.kind) {
        case "ok":
          expect(typeof result.markdown).toBe("string");
          expect(result.markdown.trim()).not.toBe("");
          break;
        case "no-content":
          // No body field on this branch — there is nothing to ingest.
          expect("markdown" in result).toBe(false);
          break;
        default: {
          // Exhaustiveness: the union has exactly these two arms.
          const _never: never = result;
          throw new Error(`unexpected outcome ${JSON.stringify(_never)}`);
        }
      }
    }
  });

  it("is reachable from the dialect index aggregator", () => {
    expect(serializeClipFromIndex).toBe(serializeClip);
  });
});

describe("serializeClip — the signal is independent of capture kind", () => {
  it("a `selection` highlight with no content is also `no-content`", () => {
    const result = serializeClip({
      captureKind: "selection",
      markdownBody: "",
      sourceUrl: "https://example.com",
      clipDate: "2026-06-20T12:00:00Z",
    });
    expect(result.kind).toBe("no-content");
  });

  it("a `bookmark` with a real body is `ok`", () => {
    const result = serializeClip({
      captureKind: "bookmark",
      markdownBody: "[https://example.com](https://example.com)",
      sourceUrl: "https://example.com",
      clipDate: "2026-06-20T12:00:00Z",
    });
    expect(result.kind).toBe("ok");
  });
});
