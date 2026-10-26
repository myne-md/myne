// The bytes a photo-to-note capture lands in the note, pinned (myne-md/myne#926
// task 5).
//
// This shape is load-bearing in three directions at once, which is why it is a
// pure module with its own spec rather than an inline template in the flow:
//
//   * the image stays and the text sits directly under it, so a later engine
//     can re-read the original;
//   * the text can never open a frontmatter block, so a photographed `---`
//     cannot move the note between folders or out of an AI-excluded folder;
//   * the new-note title comes from the corrected text, not from the cached
//     reading, so a user who fixed the first line gets the title they fixed.

import { describe, expect, it } from "vitest";
import {
  buildPhotoNoteBlock,
  localDateStamp,
  photoNoteTitle,
  shouldDiscardPhotoDraft,
} from "../src/lib/photoNoteBody";

const EMBED = "![[att:abc123|IMG_0042.jpg]]";

describe("buildPhotoNoteBlock", () => {
  it("puts the embed first and the text directly below it", () => {
    expect(buildPhotoNoteBlock(EMBED, "Toplantı notları\nyarın 14:00")).toBe(
      `${EMBED}\n\nToplantı notları\nyarın 14:00`,
    );
  });

  it("adds the image alone when there is no text", () => {
    // A blank page and a skipped read are both legitimate; neither owes the note
    // an empty paragraph under the image.
    expect(buildPhotoNoteBlock(EMBED, "")).toBe(EMBED);
    expect(buildPhotoNoteBlock(EMBED, "   \n\n ")).toBe(EMBED);
  });

  it("keeps interior paragraphs and drops the trailing gap", () => {
    expect(buildPhotoNoteBlock(EMBED, "\n\nbirinci\n\nikinci\n\n")).toBe(
      `${EMBED}\n\nbirinci\n\nikinci`,
    );
  });

  it("cannot be read as frontmatter", () => {
    // The composed block starts with the embed, so this is defence in depth:
    // a caller that later inserts the TEXT without an embed inherits a hole
    // otherwise, and a note whose frontmatter moved changed folder, views and
    // AI-exclusion status without asking anyone.
    const block = buildPhotoNoteBlock(EMBED, "---\ntitle: kaçak\n---\ngövde");
    expect(block).toBe(`${EMBED}\n\n\n---\ntitle: kaçak\n---\ngövde`);
    expect(block.startsWith("---")).toBe(false);
  });
});

describe("photoNoteTitle", () => {
  it("derives the title from the first non-empty line", () => {
    expect(photoNoteTitle("\n\nToplantı notları\nyarın", "fallback")).toBe("Toplantı notları");
  });

  it("strips the markdown that would read as syntax in a title", () => {
    expect(photoNoteTitle("## Alışveriş listesi", "fallback")).toBe("Alışveriş listesi");
    expect(photoNoteTitle("- ekmek, süt", "fallback")).toBe("ekmek, süt");
    expect(photoNoteTitle("3. üçüncü madde", "fallback")).toBe("üçüncü madde");
    expect(photoNoteTitle("> alıntı", "fallback")).toBe("alıntı");
  });

  it("falls back when the page produced nothing", () => {
    expect(photoNoteTitle("", "Fotoğraf notu 2026-10-25")).toBe("Fotoğraf notu 2026-10-25");
    expect(photoNoteTitle("  \n\t ", "Fotoğraf notu 2026-10-25")).toBe("Fotoğraf notu 2026-10-25");
    // A line that is ONLY syntax has no title in it either.
    expect(photoNoteTitle("### ", "Fotoğraf notu")).toBe("Fotoğraf notu");
  });

  it("truncates by code point, never mid-character", () => {
    const long = "ğ".repeat(120);
    const title = photoNoteTitle(long, "fallback");
    expect(Array.from(title)).toHaveLength(80);
    expect(title).toBe("ğ".repeat(80));
  });
});

describe("localDateStamp", () => {
  it("uses the device's own day, not the UTC one", () => {
    // 00:30 on the 25th in a UTC+3 timezone is still the 24th in UTC. The note
    // title is what the user reads, so it has to follow the device.
    const localMidnightish = new Date(2026, 9, 25, 0, 30);
    expect(localDateStamp(localMidnightish)).toBe("2026-10-25");
  });

  it("pads a single-digit month and day", () => {
    expect(localDateStamp(new Date(2026, 0, 5, 12, 0))).toBe("2026-01-05");
  });
});

describe("shouldDiscardPhotoDraft", () => {
  const owned = { id: "a".repeat(64), deduplicated: false };

  it("deletes a draft this flow imported and the user never committed", () => {
    expect(shouldDiscardPhotoDraft(owned, false)).toBe(true);
  });

  it("never deletes one a note already references", () => {
    // The unmount teardown runs after a commit too; deleting here would leave
    // every embed pointing at a tombstone.
    expect(shouldDiscardPhotoDraft(owned, true)).toBe(false);
  });

  it("never deletes a deduplicated import, because the vault already had it", () => {
    // `attachment_import` is content-addressed: picking a photo already in the
    // vault returns the existing entry, and deleting it breaks other notes and
    // pushes a tombstone to every device.
    expect(shouldDiscardPhotoDraft({ id: "a".repeat(64), deduplicated: true }, false)).toBe(false);
  });

  it("deletes nothing while the import is still running", () => {
    expect(shouldDiscardPhotoDraft({ id: null, deduplicated: false }, false)).toBe(false);
  });
});
