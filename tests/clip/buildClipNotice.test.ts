// desktop-ingest task 7 — unit tests for the clip success-notice builder
// (MYND-442). Covers the no-omission shape (bare root notice, no tally) and the
// with-omission shape (prominent per-type tally driven off `MediaCounts`).

import { describe, expect, it } from "vitest";

import { buildClipNotice, noticeFromResult } from "../../src/clip/buildClipNotice";
import { emptyMediaByType, type MediaByType, type MediaCounts } from "../../src/notes/import/media";
import {
  CLIP_NOTICE_ROOT_MESSAGE,
  CLIP_NOTICE_VIEW_ACTION,
} from "../../src/lib/load-bearing-copy";

function counts(omitted: Partial<MediaByType>): MediaCounts {
  return {
    ingested: emptyMediaByType(),
    omitted: { ...emptyMediaByType(), ...omitted },
  };
}

describe("buildClipNotice", () => {
  it("carries the load-bearing root message + view label + the note id", () => {
    const notice = buildClipNotice({ noteId: "note-123", counts: counts({}) });
    expect(notice.message).toBe(CLIP_NOTICE_ROOT_MESSAGE);
    expect(notice.viewLabel).toBe(CLIP_NOTICE_VIEW_ACTION);
    expect(notice.noteId).toBe("note-123");
  });

  describe("no-omission shape", () => {
    it("emits no tally when nothing was omitted", () => {
      const notice = buildClipNotice({ noteId: "n1", counts: counts({}) });
      expect(notice.tally).toBeNull();
    });

    it("emits no tally even when images WERE ingested (only omissions tally)", () => {
      const notice = buildClipNotice({
        noteId: "n1",
        counts: { ingested: { ...emptyMediaByType(), image: 3 }, omitted: emptyMediaByType() },
      });
      expect(notice.tally).toBeNull();
    });
  });

  describe("with-omission shape", () => {
    it("emits a prominent per-type tally with a singular line for one omission", () => {
      const notice = buildClipNotice({ noteId: "n1", counts: counts({ image: 1 }) });
      expect(notice.tally).not.toBeNull();
      expect(notice.tally).toEqual([
        { mediaClass: "image", count: 1, line: "1 image omitted" },
      ]);
    });

    it("pluralises the line when more than one of a class is omitted", () => {
      const notice = buildClipNotice({ noteId: "n1", counts: counts({ image: 2 }) });
      expect(notice.tally?.[0].line).toBe("2 images omitted");
    });

    it("renders one entry per omitted class, image first, others after", () => {
      const notice = buildClipNotice({
        noteId: "n1",
        counts: counts({ image: 1, pdf: 3, video: 2, other: 1 }),
      });
      expect(notice.tally?.map((e) => e.line)).toEqual([
        "1 image omitted",
        "3 PDFs omitted",
        "2 videos omitted",
        "1 attachment omitted",
      ]);
    });

    it("pluralises the audio noun head word correctly", () => {
      const notice = buildClipNotice({ noteId: "n1", counts: counts({ audio: 2 }) });
      expect(notice.tally?.[0].line).toBe("2 audio files omitted");
    });

    it("includes only the non-zero classes, in stable order", () => {
      const notice = buildClipNotice({ noteId: "n1", counts: counts({ pdf: 1, image: 1 }) });
      expect(notice.tally?.map((e) => e.mediaClass)).toEqual(["image", "pdf"]);
    });
  });
});

describe("noticeFromResult", () => {
  it("builds a notice from an accepted result", () => {
    const notice = noticeFromResult({
      kind: "accepted",
      noteId: "n9",
      counts: counts({ image: 1 }),
    });
    expect(notice?.noteId).toBe("n9");
    expect(notice?.tally?.[0].line).toBe("1 image omitted");
  });

  it("returns null for a locked result", () => {
    expect(noticeFromResult({ kind: "locked" })).toBeNull();
  });

  it("returns null for an error result", () => {
    expect(noticeFromResult({ kind: "error", reason: "PlaintextTooLarge" })).toBeNull();
  });
});

describe("buildClipNotice — ingest-time compression disclosure", () => {
  // A clipped image goes through the same shared-core transform a pasted one
  // does, and the original bytes are not kept. `decisions.md` 2026-07-30 makes
  // a notice at import the thing that stands in for a consent gate, so the
  // clip notice owes it on the same terms the paste toast does.
  // The explicit zero tally is what `ingestClipImages` actually produces on a
  // clip where nothing shrank — distinct from the absent-tally case below, and
  // the one a real caller hits.
  it("emits no line when nothing compressed", () => {
    const notice = buildClipNotice({
      noteId: "n1",
      counts: counts({}),
      compression: { count: 0, originalBytes: 0, finalBytes: 0 },
    });
    expect(notice.compressionLine).toBeNull();
  });

  it("emits no line when the tally is absent entirely (pre-feature callers)", () => {
    const notice = buildClipNotice({ noteId: "n1", counts: counts({}) });
    expect(notice.compressionLine).toBeNull();
  });

  it("discloses the before/after bytes when images were compressed", () => {
    const notice = buildClipNotice({
      noteId: "n1",
      counts: counts({}),
      compression: { count: 2, originalBytes: 2400, finalBytes: 300 },
    });
    expect(notice.compressionLine).toBe("2 images compressed: 2.3 KiB → 300 B");
  });

  it("keeps the omitted tally AND the compression line — they report different losses", () => {
    const notice = buildClipNotice({
      noteId: "n1",
      counts: counts({ image: 1 }),
      compression: { count: 1, originalBytes: 2400, finalBytes: 300 },
    });
    expect(notice.tally).not.toBeNull();
    expect(notice.compressionLine).toBe("1 image compressed: 2.3 KiB → 300 B");
  });
});
