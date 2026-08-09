// Obsidian importer — media-ref hybrid auto-ingest (MYND-52, tasks 1–3, unit half of 6).
// The end-to-end round-trip is MYND-90 (sub-feature 6).

import { describe, it, expect } from "vitest";
import {
  processImportedMedia,
  classifyMediaType,
  applyTextRewrites,
  type RefImporter,
} from "../../src/notes/import/media";
import type {
  ImportedImageRef,
  ImportedAttachment,
} from "../../src/editor/attachments/insert";

const attachment = (
  id: string,
  filename: string,
  content_type = "image/png",
): ImportedAttachment => ({
  id,
  content_type,
  filename,
  size: 10,
  created_at: 0,
  deduplicated: false,
});

/** A RefImporter that ingests refs whose extension is in `okExts`, else fails. */
const ingestExts =
  (okExts: Set<string>): RefImporter =>
  async (ref: ImportedImageRef) => {
    const ext = (ref.source.split(".").pop() ?? "").toLowerCase();
    if (okExts.has(ext)) {
      return {
        ok: true,
        attachment: attachment(`id-${ext}`, ref.source.split("/").pop() ?? ref.source),
      };
    }
    return { ok: false };
  };

/** A RefImporter that ingests every ref and reports it as compressed. */
const ingestCompressed =
  (originalSize: number, storedSize: number): RefImporter =>
  async (ref: ImportedImageRef) => ({
    ok: true,
    attachment: {
      ...attachment("id-c", ref.source, "image/webp"),
      size: storedSize,
      original_size: originalSize,
      container_changed: true,
    },
  });

describe("classifyMediaType", () => {
  it("maps extensions to user-meaningful classes (SVG under image)", () => {
    expect(classifyMediaType("a.png")).toBe("image");
    expect(classifyMediaType("dir/b.svg")).toBe("image");
    expect(classifyMediaType("c.pdf")).toBe("pdf");
    expect(classifyMediaType("d.mp3")).toBe("audio");
    expect(classifyMediaType("e.MP4")).toBe("video");
    expect(classifyMediaType("f.zip")).toBe("other");
  });
});

describe("processImportedMedia — hybrid ingest + residual fallback", () => {
  it("rewrites an ingestable image ref to form C, preserving surrounding bytes", async () => {
    const body = "intro\n![[image.png]]\noutro\n";
    const r = await processImportedMedia(body, ingestExts(new Set(["png"])));
    expect(r.body).toContain("att:id-png");
    expect(r.body).not.toContain("![[image.png]]");
    expect(r.body.startsWith("intro\n")).toBe(true);
    expect(r.body.endsWith("\noutro\n")).toBe(true);
    expect(r.counts.ingested.image).toBe(1);
    expect(r.counts.omitted.image).toBe(0);
  });

  it("ingests a PDF (markdown-image form) and counts it under pdf", async () => {
    const body = "![doc](assets/report.pdf)\n";
    const r = await processImportedMedia(body, ingestExts(new Set(["pdf"])));
    expect(r.body).toContain("att:id-pdf");
    expect(r.counts.ingested.pdf).toBe(1);
  });

  it("audio/video carry through (form-C rewrite) when the importer ingests them — MYND-173, not placeholder'd", async () => {
    // Since MYND-173 the importer ingests ANY resolvable in-cap media ref (via
    // attachment_import's byte re-sniff), so audio/video are NOT dropped on
    // import; MP4/WebM then classify as video/* and play inline (myne#168). The
    // injected importer stands in for "resolvable + in-cap"; real video/*
    // classification through the Rust sniffer is E2E-covered by
    // e2e/video-attachment.e2e.ts. A ref the importer DECLINES still falls to a
    // placeholder — see the missing/unresolvable case below.
    const body = "![[song.mp3]] and ![[clip.mp4]]\n";
    const r = await processImportedMedia(body, ingestExts(new Set(["mp3", "mp4"])));
    expect(r.body).toContain("att:id-mp3");
    expect(r.body).toContain("att:id-mp4");
    expect(r.body).not.toContain("![[song.mp3]]");
    expect(r.body).not.toContain("<!-- omitted attachment:");
    expect(r.counts.ingested.audio).toBe(1);
    expect(r.counts.ingested.video).toBe(1);
    expect(r.counts.omitted.audio).toBe(0);
    expect(r.counts.omitted.video).toBe(0);
  });

  it("a missing/unresolvable local ref → placeholder, not rewritten on a guess", async () => {
    const body = "![[gone.png]]\n";
    const failAll: RefImporter = async () => ({ ok: false });
    const r = await processImportedMedia(body, failAll);
    expect(r.body).toContain("<!-- omitted attachment: gone.png -->");
    expect(r.counts.omitted.image).toBe(1);
  });

  it("remote-URL refs are left raw (never fetched, never placeholdered)", async () => {
    const body = "![remote](https://example.com/x.png)\n";
    const r = await processImportedMedia(body, ingestExts(new Set(["png"])));
    expect(r.body).toBe(body); // untouched
    expect(r.counts.ingested.image).toBe(0);
    expect(r.counts.omitted.image).toBe(0);
  });

  it("mixed body: ingest one, placeholder another, preserve the rest byte-for-byte", async () => {
    const body = "# Note\n\n![[a.png]]\n\nkept **text**\n\n![[b.mp3]]\n";
    const r = await processImportedMedia(body, ingestExts(new Set(["png"])));
    expect(r.counts.ingested.image).toBe(1);
    expect(r.counts.omitted.audio).toBe(1);
    expect(r.body).toContain("# Note\n");
    expect(r.body).toContain("kept **text**");
    expect(r.body).toContain("att:id-png");
    expect(r.body).toContain("<!-- omitted attachment: b.mp3 -->");
  });
});

// myne-md/myne#223 defect 3. A `![[…]]` embed pointing at a NOTE is not a media
// ref: it never enters this pipeline, so it is neither ingested, nor omitted,
// nor rewritten. The failing shape was that every non-`att:` embed matched, the
// resolver missed, and the whole span became `<!-- omitted attachment: … -->` —
// destroying the embed, its graph edge, and reporting it as missing media.
describe("processImportedMedia — note embeds are not media", () => {
  const failAll: RefImporter = async () => ({ ok: false });

  it.each([
    ["a plain note embed", "![[Meeting Notes]]\n"],
    ["a heading anchor", "![[Meeting Notes#Agenda]]\n"],
    ["a block anchor", "![[Meeting Notes^abc123]]\n"],
    ["an explicit .md target", "![[Meeting Notes.md]]\n"],
    ["a dotted note title", "![[2024.review]]\n"],
    ["an aliased note embed", "![[Meeting Notes|Last week]]\n"],
  ])("leaves %s byte-for-byte and counts nothing", async (_label, body) => {
    const r = await processImportedMedia(body, failAll);
    expect(r.body).toBe(body);
    expect(r.body).not.toContain("<!-- omitted attachment");
    expect(r.counts.omitted).toEqual(emptyByType());
    expect(r.counts.ingested).toEqual(emptyByType());
  });

  it("still ingests a media embed sitting next to a note embed", async () => {
    const body = "![[Meeting Notes]]\n\n![[a.png]]\n";
    const r = await processImportedMedia(body, ingestExts(new Set(["png"])));
    expect(r.body).toContain("![[Meeting Notes]]"); // untouched
    expect(r.body).toContain("att:id-png");
    expect(r.counts.ingested.image).toBe(1);
    expect(r.counts.omitted.other).toBe(0);
  });
});

function emptyByType() {
  return { image: 0, pdf: 0, audio: 0, video: 0, other: 0 };
}

describe("applyTextRewrites", () => {
  it("applies edits back-to-front, preserving non-edited bytes", () => {
    const body = "0123456789";
    const out = applyTextRewrites(body, [
      { from: 2, to: 4, replacement: "XX" },
      { from: 6, to: 8, replacement: "Y" },
    ]);
    expect(out).toBe("01XX45Y89");
  });
});

describe("processImportedMedia — ingest-time compression tally", () => {
  // Compression is gated in shared core, so an import ingests through the same
  // transform a paste does. `decisions.md` 2026-07-30 makes disclosure at
  // import the thing that stands in for a consent gate, so the importer has to
  // carry the fact out to its summary rather than swallow it — a bulk route is
  // where silently discarding pixels would be LEAST noticed.
  it("sums the compressed subset across a note's refs", async () => {
    const body = "![[a.png]]\n![[b.png]]\n";
    const r = await processImportedMedia(body, ingestCompressed(2400, 300));
    expect(r.compression).toEqual({ count: 2, originalBytes: 4800, finalBytes: 600 });
  });

  it("stays at zero when nothing compressed, so the summary line stays silent", async () => {
    const body = "![[a.png]]\n";
    const r = await processImportedMedia(body, ingestExts(new Set(["png"])));
    expect(r.compression).toEqual({ count: 0, originalBytes: 0, finalBytes: 0 });
  });

  it("counts nothing for refs that were omitted rather than ingested", async () => {
    const body = "![[a.mp3]]\n";
    const r = await processImportedMedia(body, ingestExts(new Set(["png"])));
    expect(r.compression.count).toBe(0);
  });
});
