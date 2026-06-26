// Clip serializer — task 9 (capture-extraction): image reference emission for
// the desktop-ingest attachment seam (story 13 / SYNC-10 / SYNC-14).
//
// The serializer emits ONE canonical markdown image reference per embedded
// image, in a shape sub-feature 3's desktop ingest rewrites into a form-C
// `![[att:<id>|filename]]` embed. The image BYTES are captured in-page by the
// extension and ride the handoff envelope's `image_bytes[]` (SYNC-10, owned by
// sub-feature 1); this serializer emits ONLY the reference, correlated to the
// captured bytes by POSITIONAL INDEX so ingest can match ref→bytes.
//
// Correlation key = the image's 0-based DOCUMENT-ORDER index, emitted as the
// reference URL `clip-image:N` (the seam contract, exported as
// CLIP_IMAGE_SCHEME / clipImageRef / parseClipImageRef). Index, not URL,
// because data-URIs / relative paths / duplicate URLs all collide — only the
// position is a stable 1:1 key into the positional `image_bytes[]` array.
//
// What this slice does NOT do (sub-feature 3, Rust-blocked, owns these):
//   - import attachments / fetch bytes / assign `att:<id>` — asserted by
//     structure (no `att:` in output, no attachmentRef import in the module).

import { describe, expect, it } from "vitest";
import { parser } from "../../../src/dialect/lezer/parser";
import {
  serializeClipMarkdown,
  CLIP_IMAGE_SCHEME,
  clipImageRef,
  parseClipImageRef,
} from "../../../src/dialect/clip";
import { shapeOf } from "./_rig";

/** Count nodes of a given name in a parse of `emitted`. */
function countNodes(emitted: string, name: string): number {
  const tree = parser.parse(emitted);
  let n = 0;
  tree.topNode.cursor().iterate((node) => {
    if (node.name === name) n++;
    return undefined;
  });
  return n;
}

/** True if a parse of `emitted` contains any parser ERROR node. */
function hasParseError(emitted: string): boolean {
  const tree = parser.parse(emitted);
  let bad = false;
  tree.topNode.cursor().iterate((node) => {
    if (node.type.isError) bad = true;
    return undefined;
  });
  return bad;
}

/** Every `clip-image:N` index in `emitted`, in document order. */
function emittedIndices(emitted: string): number[] {
  const re = new RegExp(`\\]\\(${CLIP_IMAGE_SCHEME}(\\d+)\\)`, "g");
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(emitted)) !== null) out.push(Number(m[1]));
  return out;
}

describe("clip serializer — image reference seam contract helpers", () => {
  it("clipImageRef builds a `clip-image:N` URL for a positional index", () => {
    expect(clipImageRef(0)).toBe(`${CLIP_IMAGE_SCHEME}0`);
    expect(clipImageRef(7)).toBe(`${CLIP_IMAGE_SCHEME}7`);
  });

  it("parseClipImageRef recovers the index from a `clip-image:N` URL", () => {
    expect(parseClipImageRef(`${CLIP_IMAGE_SCHEME}0`)).toBe(0);
    expect(parseClipImageRef(`${CLIP_IMAGE_SCHEME}42`)).toBe(42);
  });

  it("parseClipImageRef rejects non-scheme / malformed URLs", () => {
    expect(parseClipImageRef("https://ex.com/a.png")).toBeNull();
    expect(parseClipImageRef(`${CLIP_IMAGE_SCHEME}`)).toBeNull();
    expect(parseClipImageRef(`${CLIP_IMAGE_SCHEME}-1`)).toBeNull();
    expect(parseClipImageRef(`${CLIP_IMAGE_SCHEME}1x`)).toBeNull();
  });

  it("clipImageRef → parseClipImageRef round-trips the index", () => {
    for (const i of [0, 1, 2, 9, 123]) {
      expect(parseClipImageRef(clipImageRef(i))).toBe(i);
    }
  });
});

describe("clip serializer — image reference emission (story 13)", () => {
  it("emits one canonical image reference per image, round-tripping as valid markdown", () => {
    const input = "![a cat](https://ex.com/cat.png)\n";
    const emitted = serializeClipMarkdown(input);
    // Round-trips to the same tree shape (an Image stays an Image).
    expect(shapeOf(emitted)).toBe(shapeOf(input));
    expect(hasParseError(emitted)).toBe(false);
    expect(countNodes(emitted, "Image")).toBe(1);
    // The alt text is preserved; the URL is the positional seam ref.
    expect(emitted).toBe(`![a cat](${CLIP_IMAGE_SCHEME}0)`);
  });

  it("indexes multiple images in document order (one ref per image)", () => {
    const input = "![first](a.png)\n\n![second](b.png)\n\n![third](c.png)\n";
    const emitted = serializeClipMarkdown(input);
    expect(countNodes(emitted, "Image")).toBe(3);
    expect(emittedIndices(emitted)).toEqual([0, 1, 2]);
    expect(emitted).toContain(`![first](${CLIP_IMAGE_SCHEME}0)`);
    expect(emitted).toContain(`![second](${CLIP_IMAGE_SCHEME}1)`);
    expect(emitted).toContain(`![third](${CLIP_IMAGE_SCHEME}2)`);
  });

  it("indexes images inline within prose, preserving surrounding text", () => {
    const input = "See ![one](a.png) then ![two](b.png) done.\n";
    const emitted = serializeClipMarkdown(input);
    expect(emittedIndices(emitted)).toEqual([0, 1]);
    expect(emitted).toContain("See ");
    expect(emitted).toContain(" then ");
    expect(emitted).toContain(" done.");
  });

  it("preserves the alt text as the reference label", () => {
    const input = "![Diagram of the pipeline](https://ex.com/p.svg)\n";
    const emitted = serializeClipMarkdown(input);
    expect(emitted).toBe(`![Diagram of the pipeline](${CLIP_IMAGE_SCHEME}0)`);
  });

  it("emits an empty-alt image with an empty label (still correlatable)", () => {
    const input = "![](https://ex.com/x.png)\n";
    const emitted = serializeClipMarkdown(input);
    expect(emitted).toBe(`![](${CLIP_IMAGE_SCHEME}0)`);
    expect(countNodes(emitted, "Image")).toBe(1);
  });
});

describe("clip serializer — correlation is recoverable (ref→bytes)", () => {
  it("the emitted index is the position in document order ingest matches against image_bytes[]", () => {
    // Three images → bytes captured in the SAME document order in image_bytes[].
    const input = "![p0](u0.png)\n\n![p1](u1.png)\n\n![p2](u2.png)\n";
    const emitted = serializeClipMarkdown(input);
    const indices = emittedIndices(emitted);
    // Each emitted index is a valid 0-based offset into a positional bytes array.
    expect(indices).toEqual([0, 1, 2]);
    // Ingest can recover each index from the ref URL and look up image_bytes[i].
    for (const i of indices) {
      expect(parseClipImageRef(`${CLIP_IMAGE_SCHEME}${i}`)).toBe(i);
    }
  });
});

describe("clip serializer — robustness: index, not URL (the collision cases)", () => {
  it("two images sharing the SAME url still get DISTINCT correlatable refs", () => {
    // URL-keyed correlation would collapse these to one; positional index keeps
    // them distinct so two image_bytes[] entries are addressable.
    const input = "![a](./dup.png) and ![b](./dup.png)\n";
    const emitted = serializeClipMarkdown(input);
    expect(emittedIndices(emitted)).toEqual([0, 1]);
    expect(emitted).toContain(`![a](${CLIP_IMAGE_SCHEME}0)`);
    expect(emitted).toContain(`![b](${CLIP_IMAGE_SCHEME}1)`);
  });

  it("a data-URI image gets a compact positional ref (no giant URL in the body)", () => {
    const input = "![inline data](data:image/png;base64,QUFBQUFBQUE=)\n";
    const emitted = serializeClipMarkdown(input);
    expect(emitted).toBe(`![inline data](${CLIP_IMAGE_SCHEME}0)`);
    // The base64 payload never lands in the canonical body — it rides image_bytes[].
    expect(emitted).not.toContain("base64");
    expect(emitted).not.toContain("data:");
  });

  it("a relative-path image gets a positional ref (no raw path leaks into the body)", () => {
    const input = "![local](../assets/diagram.png)\n";
    const emitted = serializeClipMarkdown(input);
    expect(emitted).toBe(`![local](${CLIP_IMAGE_SCHEME}0)`);
    expect(emitted).not.toContain("../assets");
  });

  it("the emitted reference re-parses as an Image (round-trip-stable) and re-serializes the same ref (idempotent)", () => {
    const input = "![a](./dup.png) and ![b](./dup.png)\n";
    const once = serializeClipMarkdown(input);
    expect(countNodes(once, "Image")).toBe(2);
    // Idempotent: the already-canonical `clip-image:N` refs survive a 2nd pass
    // unchanged (parseClipImageRef recognizes them; index is re-derived, stable).
    const twice = serializeClipMarkdown(once);
    expect(twice).toBe(once);
  });
});

describe("clip serializer — NO attachment import / NO att: assignment (sub-feature 3 owns those)", () => {
  it("never emits an `att:` attachment id — only the positional seam ref", () => {
    const input = "![cat](cat.png)\n\n![dog](dog.png)\n";
    const emitted = serializeClipMarkdown(input);
    expect(emitted).not.toContain("att:");
    expect(emitted).not.toContain("![[");
    // No form-C embed is synthesized here; that is sub-feature 3's rewrite.
    expect(countNodes(emitted, "Wikilink")).toBe(0);
  });

  it("the clip module imports no attachment-import / byte-fetch surface", async () => {
    // Structural proof the serializer performs no import/fetch: it never imports
    // the form-C emitter (notes/attachmentRef), never calls a fetch/network
    // primitive, and never invokes the host attachment-import command. The
    // ingest-seam contract (which DOES mention `att:` and `attachment_import` in
    // prose, describing what sub-feature 3 does downstream) is documentation, so
    // these assert against CODE surface (import statements + call sites), not the
    // appearance of those words in comments.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../../../src/dialect/clip.ts", import.meta.url),
      "utf8",
    );
    // No import of the form-C attachment helpers (the only `att:`-emitting code).
    expect(src).not.toMatch(/from\s+["'][^"']*attachmentRef["']/);
    expect(src).not.toContain("emitAttachmentEmbed(");
    expect(src).not.toContain("ATT_SCHEME");
    // No network / IPC byte fetch.
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/\binvoke\s*\(/);
    // The serializer never emits an `att:` id into its OUTPUT — proven
    // behaviourally by the sibling "never emits an `att:` attachment id" test.
    // (The `att:` token appears here only in the documented ingest-seam prose,
    // describing sub-feature 3's downstream rewrite — not in emitting code.)
  });
});
