// Attachment INSERT core logic (epic MYND-164, sub-feature attachment-insert).
//
// Pure unit tests for the insert orchestration that needs no DOM: auto-name
// format, MIME→extension, multi-file partial-success accounting + toast
// summary, error→skip-reason mapping, and the imported-ref parser + rewrite
// planner the import-&-convert command feeds into the diff preview.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ImportSource,
  type ImportedAttachment,
  type ImportOutcome,
  autoPasteName,
  compressionNoticeMessage,
  displayNameForRef,
  extensionForMime,
  findImportedImageRefs,
  importMany,
  importOne,
  importToastMessage,
  planRewrite,
  setImportFn,
  skipReasonFromError,
  summarizeBatch,
  summarizeCompression,
  summarizeCompressedAttachments,
  tallyCompression,
  compressionTallyMessage,
  emptyCompressionTally,
  addCompressionTally,
} from "../../src/editor/attachments/insert";

function imported(id: string, filename: string): ImportedAttachment {
  return {
    id,
    content_type: "image/png",
    filename,
    size: 10,
    created_at: 0,
    deduplicated: false,
  };
}

const ID_A = "a".repeat(64);
const ID_B = "b".repeat(64);

describe("autoPasteName", () => {
  it("formats `Pasted image YYYY-MM-DD HH-MM-SS.<ext>` with zero-padding", () => {
    // 2026-06-08 09:03:07 local
    const now = new Date(2026, 5, 8, 9, 3, 7);
    expect(autoPasteName("image/png", now)).toBe("Pasted image 2026-06-08 09-03-07.png");
  });

  it("derives the extension from the MIME (jpeg → jpg)", () => {
    const now = new Date(2026, 0, 1, 0, 0, 0);
    expect(autoPasteName("image/jpeg", now)).toBe("Pasted image 2026-01-01 00-00-00.jpg");
  });

  it("defaults unknown MIME to png (clipboard images are usually png)", () => {
    const now = new Date(2026, 0, 1, 0, 0, 0);
    expect(autoPasteName("application/octet-stream", now)).toMatch(/\.png$/);
  });
});

describe("extensionForMime", () => {
  it("maps the allowlist", () => {
    expect(extensionForMime("image/png")).toBe("png");
    expect(extensionForMime("image/jpeg")).toBe("jpg");
    expect(extensionForMime("image/gif")).toBe("gif");
    expect(extensionForMime("image/webp")).toBe("webp");
    expect(extensionForMime("image/svg+xml")).toBe("svg");
    expect(extensionForMime("application/pdf")).toBe("pdf");
  });
});

describe("skipReasonFromError", () => {
  it("maps the backend error taxonomy to coarse reasons", () => {
    expect(skipReasonFromError({ kind: "Oversize", detail: { cap_bytes: 1 } })).toBe("too-large");
    expect(skipReasonFromError({ kind: "UnsupportedType" })).toBe("unsupported");
    expect(skipReasonFromError({ kind: "Locked" })).toBe("locked");
    expect(skipReasonFromError({ kind: "Io", detail: { io_error_kind: "Other" } })).toBe("error");
    expect(skipReasonFromError(new Error("boom"))).toBe("error");
    expect(skipReasonFromError(null)).toBe("error");
  });
});

describe("summarizeBatch (multi-file partial-success toast)", () => {
  const ok: ImportOutcome = { ok: true, attachment: imported(ID_A, "x.png") };
  const tooLarge: ImportOutcome = { ok: false, reason: "too-large" };
  const unsupported: ImportOutcome = { ok: false, reason: "unsupported" };

  it("is silent for a single clean success (the embed is the feedback)", () => {
    expect(summarizeBatch([ok])).toBeNull();
  });

  it("announces a count when multiple succeed", () => {
    expect(summarizeBatch([ok, ok])).toBe("2 added");
  });

  it("summarizes partial success: 2 added · 1 skipped: too large", () => {
    expect(summarizeBatch([ok, ok, tooLarge])).toBe("2 added · 1 skipped: too large");
  });

  it("groups multiple skip reasons in a stable order", () => {
    expect(summarizeBatch([ok, tooLarge, unsupported])).toBe(
      "1 added · 1 skipped: too large · 1 skipped: unsupported type",
    );
  });

  it("handles an all-skipped batch (no 'added' segment)", () => {
    expect(summarizeBatch([tooLarge, tooLarge])).toBe("2 skipped: too large");
  });
});

describe("summarizeCompression / compressionNoticeMessage (insert-time notice)", () => {
  const uncompressed: ImportOutcome = { ok: true, attachment: imported(ID_A, "x.png") };
  const dedupHit: ImportOutcome = {
    ok: true,
    attachment: { ...imported(ID_A, "x.png"), deduplicated: true },
  };
  const compressedNoContainerChange: ImportOutcome = {
    ok: true,
    attachment: { ...imported(ID_A, "shot.webp"), size: 300, original_size: 2400 },
  };
  const compressedWithContainerChange: ImportOutcome = {
    ok: true,
    attachment: {
      ...imported(ID_B, "shot.webp"),
      content_type: "image/webp",
      size: 300,
      original_size: 2400,
      container_changed: true,
    },
  };

  it("is silent when nothing compressed (unchanged import)", () => {
    expect(summarizeCompression([uncompressed])).toBeNull();
  });

  it("is silent on a dedup hit, even though the id was compressed originally", () => {
    expect(summarizeCompression([dedupHit])).toBeNull();
  });

  it("is silent for a skipped outcome mixed into the batch", () => {
    expect(summarizeCompression([{ ok: false, reason: "too-large" }])).toBeNull();
  });

  it("summarizes a single compressed import with both sizes", () => {
    const summary = summarizeCompression([compressedNoContainerChange]);
    expect(summary).toEqual({
      originalBytes: 2400,
      finalBytes: 300,
      containerChanged: false,
      contentType: "image/png",
    });
    expect(compressionNoticeMessage(summary!)).toBe("Compressed: 2.3 KiB → 300 B");
  });

  it("mentions the container change when one occurred", () => {
    const summary = summarizeCompression([compressedWithContainerChange]);
    expect(summary?.containerChanged).toBe(true);
    expect(compressionNoticeMessage(summary!)).toBe("Compressed to WebP: 2.3 KiB → 300 B");
  });

  it("aggregates multiple compressed imports in one batch", () => {
    const summary = summarizeCompression([
      compressedNoContainerChange,
      compressedWithContainerChange,
      uncompressed,
    ]);
    expect(summary).toEqual({
      originalBytes: 4800,
      finalBytes: 600,
      containerChanged: true,
      contentType: "image/webp",
    });
  });

  it("names the format of an import that actually swapped container, not the last one", () => {
    // Order matters: the container-changed import comes FIRST, and a
    // same-container import follows it. The notice names a destination
    // format, so it must come from the outcome that has one.
    const summary = summarizeCompression([
      compressedWithContainerChange,
      compressedNoContainerChange,
    ]);
    expect(summary?.contentType).toBe("image/webp");
    expect(compressionNoticeMessage(summary!)).toBe("Compressed to WebP: 4.7 KiB → 600 B");
  });
});

describe("summarizeCompressedAttachments / the bulk tally (non-editor import routes)", () => {
  // Compression is gated in shared core, so it fires on EVERY import route —
  // the cover picker, import-&-convert, the vault importer, the browser
  // clipper. `decisions.md` 2026-07-30 makes disclosure at import the thing
  // that stands in for a consent gate, so routes that never build an
  // `ImportOutcome` need the same fold reachable from an attachment alone.
  const compressed: ImportedAttachment = {
    ...imported(ID_A, "shot.webp"),
    content_type: "image/webp",
    size: 300,
    original_size: 2400,
    container_changed: true,
  };

  it("summarizes attachments directly, matching the outcome-shaped entry point", () => {
    expect(summarizeCompressedAttachments([compressed])).toEqual(
      summarizeCompression([{ ok: true, attachment: compressed }]),
    );
  });

  it("is silent when nothing compressed", () => {
    expect(summarizeCompressedAttachments([imported(ID_A, "x.png")])).toBeNull();
    expect(summarizeCompressedAttachments([])).toBeNull();
  });

  it("tallies count + both byte totals, ignoring uncompressed imports", () => {
    expect(tallyCompression([compressed, imported(ID_B, "x.png"), compressed])).toEqual({
      count: 2,
      originalBytes: 4800,
      finalBytes: 600,
    });
  });

  it("adds tallies, so a bulk route can fold across many notes", () => {
    const a = tallyCompression([compressed]);
    expect(addCompressionTally(a, emptyCompressionTally())).toEqual(a);
    expect(addCompressionTally(a, a)).toEqual({
      count: 2,
      originalBytes: 4800,
      finalBytes: 600,
    });
  });

  it("renders nothing for the zero tally — a notice for a no-op teaches users to ignore notices", () => {
    expect(compressionTallyMessage(emptyCompressionTally())).toBeNull();
  });

  it("renders singular and plural bulk lines", () => {
    expect(compressionTallyMessage({ count: 1, originalBytes: 2400, finalBytes: 300 })).toBe(
      "1 image compressed: 2.3 KiB → 300 B",
    );
    expect(compressionTallyMessage({ count: 3, originalBytes: 4800, finalBytes: 600 })).toBe(
      "3 images compressed: 4.7 KiB → 600 B",
    );
  });
});

describe("importToastMessage (one toast per batch)", () => {
  const compressed: ImportOutcome = {
    ok: true,
    attachment: {
      ...imported(ID_A, "shot.webp"),
      content_type: "image/webp",
      size: 300,
      original_size: 2400,
      container_changed: true,
    },
  };

  it("is silent for a single clean uncompressed success", () => {
    expect(importToastMessage([{ ok: true, attachment: imported(ID_A, "x.png") }])).toBeNull();
  });

  it("falls back to the batch summary when nothing compressed", () => {
    expect(importToastMessage([{ ok: false, reason: "too-large" }])).toBe(
      "1 skipped: too large",
    );
  });

  it("keeps BOTH parts when a batch compressed something and skipped something", () => {
    // Only one toast can show, and these two answer different questions: the
    // disclosure is the irreversible half, the skip count is the actionable
    // one. Dropping either would make a true sentence that hides a fact the
    // user needs — four files that never arrived, or pixels that are gone.
    expect(importToastMessage([compressed, { ok: false, reason: "too-large" }])).toBe(
      "Compressed to WebP: 2.3 KiB → 300 B · 1 added · 1 skipped: too large",
    );
  });

  it("shows the disclosure alone when nothing was skipped", () => {
    expect(importToastMessage([compressed])).toBe("Compressed to WebP: 2.3 KiB → 300 B");
  });
});

describe("importOne / importMany (never throw; preserve order)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("folds a rejection into a skip outcome", async () => {
    const restore = setImportFn(async () => {
      throw { kind: "Oversize", detail: { cap_bytes: 1 } };
    });
    const outcome = await importOne({ kind: "bytes", bytes: [1], filename: "a.png" });
    restore();
    expect(outcome).toEqual({ ok: false, reason: "too-large" });
  });

  it("imports many in document order, mixing success + skip", async () => {
    const restore = setImportFn(async (s: ImportSource) => {
      if (s.kind === "bytes" && s.filename === "bad") {
        throw { kind: "UnsupportedType" };
      }
      return imported(ID_A, "ok.png");
    });
    const outcomes = await importMany([
      { kind: "bytes", bytes: [1], filename: "good" },
      { kind: "bytes", bytes: [2], filename: "bad" },
      { kind: "bytes", bytes: [3], filename: "good2" },
    ]);
    restore();
    expect(outcomes.map((o) => o.ok)).toEqual([true, false, true]);
  });
});

describe("findImportedImageRefs", () => {
  it("finds `![[image.png]]` wikilink embeds (not form-C att: embeds)", () => {
    const body = "before ![[diagram.png]] after ![[att:" + ID_A + "|x.png]]";
    const refs = findImportedImageRefs(body);
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("wikilink-embed");
    expect(refs[0].source).toBe("diagram.png");
    expect(refs[0].raw).toBe("![[diagram.png]]");
  });

  it("carries a wikilink alias", () => {
    const refs = findImportedImageRefs("![[diagram.png|My Diagram]]");
    expect(refs[0].alias).toBe("My Diagram");
  });

  it("finds `![alt](path)` markdown images with local paths", () => {
    const refs = findImportedImageRefs("![A cat](images/cat.jpg)");
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe("markdown-image");
    expect(refs[0].source).toBe("images/cat.jpg");
    expect(refs[0].alias).toBe("A cat");
  });

  it("excludes remote/data URL markdown images (nothing to import)", () => {
    const body =
      "![x](https://example.com/a.png) ![y](data:image/png;base64,AAA) ![z](attachment://" +
      ID_A +
      ")";
    expect(findImportedImageRefs(body)).toHaveLength(0);
  });

  it("returns refs in document order across both forms", () => {
    const body = "![alt](a.png)\n![[b.png]]\n![alt2](c.png)";
    const refs = findImportedImageRefs(body);
    expect(refs.map((r) => r.source)).toEqual(["a.png", "b.png", "c.png"]);
  });

  it("leaves a note with no imported refs empty", () => {
    expect(findImportedImageRefs("just text ![[att:" + ID_A + "|x]]")).toHaveLength(0);
  });
});

describe("displayNameForRef / planRewrite", () => {
  it("prefers the alias, else the final path component", () => {
    const [ref1] = findImportedImageRefs("![[folder/diagram.png|Nice]]");
    expect(displayNameForRef(ref1)).toBe("Nice");
    const [ref2] = findImportedImageRefs("![[folder/diagram.png]]");
    expect(displayNameForRef(ref2)).toBe("diagram.png");
  });

  it("plans a form-C rewrite using the host's stored filename", () => {
    const [ref] = findImportedImageRefs("![[diagram.png]]");
    const plan = planRewrite(ref, imported(ID_B, "diagram.png"));
    expect(plan.replacement).toBe(`![[att:${ID_B}|diagram.png]]`);
    expect(plan.ref).toBe(ref);
  });
});
