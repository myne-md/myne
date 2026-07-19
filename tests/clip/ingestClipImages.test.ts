// desktop-ingest task 3 — in-memory image ingest → form-C embeds + importer-
// parity degrade (MYND-445, browser-extension epic, sub-feature `desktop-ingest`).
//
// `ingestClipImages` mirrors the shipped `processImportedMedia` injection seam
// (`src/notes/import/media.ts`): it takes a clip body + an injected importer
// PORT and returns the rewritten body + `MediaCounts` (ingested / omitted by
// type). The difference from the importer is the SOURCE — in-memory clip image
// bytes (NOT a vault-relative path) — and the REF SHAPE — the serializer's
// positional `clip-image:N` markdown-image refs (NOT the importer's media links).
//
// For each `clip-image:N` ref in the body the routine looks up
// `envelope.imageBytes[N]` (`{ filename, bytes }`), imports the bytes via the
// injected port (the real port = `attachment_import { kind: "bytes" }`), and on
// success rewrites the ref IN PLACE to form-C `![[att:<id>|filename]]` via the
// shared `emitAttachmentEmbed`. On a residual (oversize over the 64 MiB per-image
// cap enforced Rust-side, or a non-image after the core's MIME re-sniff) the port
// rejects and the ref degrades to a placeholder comment + the omitted tally —
// exact importer parity. A single image whose import THROWS never aborts the
// whole ingest; its placeholder lands and the rest of the clip proceeds.
//
// These tests pin the six acceptance criteria with a FAKE port:
//   1. in-cap image → imported via `kind:"bytes"` + rewritten to form-C;
//   2. over-64-MiB image → placeholder + omitted tally (rest still lands);
//   3. non-image (re-sniff mismatch) → placeholder, never an embed;
//   4. two identical images collapse to one stored blob (dedup flag observed);
//   5. one image whose import throws → coherent note (placeholder in place);
//   6. the rest-of-the-body-still-lands property across the degrade paths.

import { describe, expect, it } from "vitest";
import {
  ingestClipImages,
  type ClipImageImporter,
} from "../../src/clip/ingestClipImages";
import { clipImageRef } from "../../src/dialect/clip";
import type { ImportedAttachment } from "../../src/editor/attachments/insert";
import type { RawClipImage } from "../../src/clip/validateClipEnvelope";

// The 64 MiB per-image cap (protocol.md §9.9 / `MAX_ATTACHMENT_LEN`). The cap is
// enforced Rust-side inside `attachment_import`; in this TS unit an oversize
// image surfaces as a typed port reject (`{ ok: false }`), the same degrade
// trigger the importer's `processImportedMedia` uses.
const PER_IMAGE_CAP = 64 * 1024 * 1024;

/** A stored-attachment success payload (spread + override per test). */
function attachment(
  overrides: Partial<ImportedAttachment> = {},
): ImportedAttachment {
  return {
    id: "a".repeat(64),
    content_type: "image/png",
    filename: "image.png",
    size: 10,
    created_at: 0,
    deduplicated: false,
    ...overrides,
  };
}

/** A clip image `{ filename, bytes }` (the envelope's positional element). */
function image(filename: string, bytes: Uint8Array): RawClipImage {
  return { filename, bytes };
}

/** A short, in-cap byte run. */
function smallBytes(seed = 1): Uint8Array {
  return new Uint8Array([seed, 2, 3, 4]);
}

/**
 * A fake `attachment_import { kind:"bytes" }` port that content-addresses the
 * bytes (so identical bytes dedup to one stored id + the second sees
 * `deduplicated: true`), enforces the per-image cap (oversize → reject), and
 * re-sniffs a magic-byte type (a non-image leading byte → reject, never an
 * embed). The fake mirrors the host's real re-sniff + cap + content-address
 * behavior without a Tauri runtime.
 */
function fakePort(): ClipImageImporter & {
  readonly calls: { filename: string | null; bytes: number[] }[];
  readonly stored: Set<string>;
} {
  const calls: { filename: string | null; bytes: number[] }[] = [];
  const stored = new Set<string>();
  const port: ClipImageImporter = async (img) => {
    // Per-image cap — enforced Rust-side; here it surfaces as a typed reject.
    // Check the raw Uint8Array length BEFORE materializing it into a plain
    // number[]: `Array.from` on a 64 MiB+ buffer is ~500 MB and seconds of CPU,
    // which times this test out under full-suite load (a load-dependent flake).
    // The real host likewise rejects oversize bytes without a client-side copy.
    if (img.bytes.length > PER_IMAGE_CAP) {
      calls.push({ filename: img.filename, bytes: [] });
      return { ok: false };
    }
    const bytes = Array.from(img.bytes);
    calls.push({ filename: img.filename, bytes });
    // MIME re-sniff: a clip image whose first byte is 0 is a non-image
    // masquerading as one — the host's re-sniff rejects it (never trusts the
    // caller-claimed type).
    if (bytes[0] === 0) return { ok: false };
    // Content-address by the byte run; identical bytes dedup to one id.
    const id = bytes.map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 64).padEnd(64, "0");
    const deduplicated = stored.has(id);
    stored.add(id);
    return {
      ok: true,
      attachment: attachment({ id, filename: img.filename ?? "image.png", deduplicated }),
    };
  };
  return Object.assign(port, { calls, stored });
}

describe("ingestClipImages — in-cap import + form-C rewrite", () => {
  it("imports an in-cap clip image via kind:\"bytes\" and rewrites its ref to form-C", async () => {
    const body = `intro\n![hero](${clipImageRef(0)})\noutro\n`;
    const port = fakePort();
    const r = await ingestClipImages(body, [image("hero.png", smallBytes())], port);

    // The port was called with the in-memory bytes (NOT a path).
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]!.bytes).toEqual([1, 2, 3, 4]);
    expect(port.calls[0]!.filename).toBe("hero.png");

    // The ref rewrote to a form-C embed; surrounding bytes preserved.
    expect(r.body).toContain("![[att:");
    expect(r.body).toContain("|hero.png]]");
    expect(r.body).not.toContain(clipImageRef(0));
    expect(r.body.startsWith("intro\n")).toBe(true);
    expect(r.body.endsWith("\noutro\n")).toBe(true);

    expect(r.counts.ingested.image).toBe(1);
    expect(r.counts.omitted.image).toBe(0);
  });

  it("rewrites multiple in-cap images each to its own form-C embed in order", async () => {
    const body = `![a](${clipImageRef(0)})\n\n![b](${clipImageRef(1)})\n`;
    const port = fakePort();
    const r = await ingestClipImages(
      body,
      [image("a.png", smallBytes(1)), image("b.png", smallBytes(9))],
      port,
    );
    expect(r.body).toContain("|a.png]]");
    expect(r.body).toContain("|b.png]]");
    expect(r.body).not.toContain("clip-image:");
    expect(r.counts.ingested.image).toBe(2);
  });
});

describe("ingestClipImages — importer-parity degrade", () => {
  it("an over-64-MiB image degrades to a placeholder + omitted tally; the rest still lands", async () => {
    const huge = new Uint8Array(PER_IMAGE_CAP + 1);
    huge[0] = 1; // a valid leading byte — the ONLY reason to degrade is the cap
    const body = `keep this\n![big](${clipImageRef(0)})\nand this too\n`;
    const port = fakePort();
    const r = await ingestClipImages(body, [image("big.png", huge)], port);

    expect(r.body).toContain("<!-- omitted attachment: big.png -->");
    expect(r.body).not.toContain("![[att:");
    expect(r.body).not.toContain(clipImageRef(0));
    // The rest of the body is preserved verbatim around the placeholder.
    expect(r.body.startsWith("keep this\n")).toBe(true);
    expect(r.body.endsWith("\nand this too\n")).toBe(true);

    expect(r.counts.ingested.image).toBe(0);
    expect(r.counts.omitted.image).toBe(1);
  });

  it("a non-image masquerading as an image (re-sniff mismatch) degrades to a placeholder, never an embed", async () => {
    const fakeImage = new Uint8Array([0, 1, 2, 3]); // leading 0 → re-sniff reject
    const body = `![evil](${clipImageRef(0)})\n`;
    const port = fakePort();
    const r = await ingestClipImages(body, [image("evil.png", fakeImage)], port);

    expect(r.body).toContain("<!-- omitted attachment: evil.png -->");
    expect(r.body).not.toContain("![[att:");
    expect(r.counts.omitted.image).toBe(1);
    expect(r.counts.ingested.image).toBe(0);
  });

  it("two identical images collapse to one stored blob (dedup hit via the deduplicated flag)", async () => {
    const bytes = smallBytes(7);
    const body = `![first](${clipImageRef(0)})\n\n![second](${clipImageRef(1)})\n`;
    const port = fakePort();
    const r = await ingestClipImages(
      body,
      [image("first.png", bytes), image("second.png", new Uint8Array(bytes))],
      port,
    );

    // Both refs rewrote to form-C embeds carrying the SAME content-addressed id.
    const ids = [...r.body.matchAll(/!\[\[att:([0-9a-f]{64})\|/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]); // identical bytes → one stored blob (one id)

    // Exactly one blob stored; the second import observed the dedup flag.
    expect(port.stored.size).toBe(1);
    expect(r.dedupHits).toBe(1);
    expect(r.counts.ingested.image).toBe(2);
  });

  it("an image whose import THROWS produces a coherent note (placeholder in place), not an aborted ingest", async () => {
    const body = `top\n![ok](${clipImageRef(0)})\nmid\n![boom](${clipImageRef(1)})\nbottom\n`;
    // A port that imports image 0 fine but THROWS on image 1.
    const port: ClipImageImporter = async (img) => {
      if (img.filename === "boom.png") throw new Error("import exploded");
      return { ok: true, attachment: attachment({ id: "b".repeat(64), filename: img.filename ?? "x" }) };
    };
    const r = await ingestClipImages(
      body,
      [image("ok.png", smallBytes()), image("boom.png", smallBytes())],
      port,
    );

    // The throw did NOT abort: image 0 still embedded, image 1 placeholdered.
    expect(r.body).toContain("![[att:bbbb");
    expect(r.body).toContain("<!-- omitted attachment: boom.png -->");
    // Surrounding prose lands intact, in order.
    expect(r.body.startsWith("top\n")).toBe(true);
    expect(r.body.endsWith("\nbottom\n")).toBe(true);
    expect(r.body).toContain("\nmid\n");

    expect(r.counts.ingested.image).toBe(1);
    expect(r.counts.omitted.image).toBe(1);
  });
});

describe("ingestClipImages — edge cases", () => {
  it("a ref with no matching imageBytes[N] entry degrades to a placeholder (never imported)", async () => {
    // Ref index 0 but an EMPTY imageBytes array — the positional lookup misses.
    const body = `![orphan](${clipImageRef(0)})\n`;
    const port = fakePort();
    const r = await ingestClipImages(body, [], port);
    expect(port.calls).toHaveLength(0); // never imported — nothing to import
    expect(r.body).toContain("<!-- omitted attachment:");
    expect(r.body).not.toContain("![[att:");
    expect(r.counts.omitted.image).toBe(1);
  });

  it("a body with no clip-image refs is returned unchanged with zero counts", async () => {
    const body = "# Just prose\n\nno images here\n";
    const port = fakePort();
    const r = await ingestClipImages(body, [], port);
    expect(r.body).toBe(body);
    expect(port.calls).toHaveLength(0);
    expect(r.counts.ingested.image).toBe(0);
    expect(r.counts.omitted.image).toBe(0);
  });

  it("preserves a non-clip markdown image (http/data URL) verbatim — only clip-image refs are touched", async () => {
    const body = `![remote](https://ex.com/x.png)\n\n![clip](${clipImageRef(0)})\n`;
    const port = fakePort();
    const r = await ingestClipImages(body, [image("clip.png", smallBytes())], port);
    expect(r.body).toContain("![remote](https://ex.com/x.png)"); // untouched
    expect(r.body).toContain("|clip.png]]");
    expect(r.body).not.toContain("clip-image:");
    expect(r.counts.ingested.image).toBe(1);
  });
});
