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

  it("residual audio/video → placeholder comment + omitted tally", async () => {
    const body = "![[song.mp3]] and ![[clip.mp4]]\n";
    const r = await processImportedMedia(body, ingestExts(new Set(["png"]))); // nothing ingestable
    expect(r.body).toContain("<!-- omitted attachment: song.mp3 -->");
    expect(r.body).toContain("<!-- omitted attachment: clip.mp4 -->");
    expect(r.body).not.toContain("![[song.mp3]]");
    expect(r.counts.omitted.audio).toBe(1);
    expect(r.counts.omitted.video).toBe(1);
    expect(r.counts.ingested.image).toBe(0);
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
