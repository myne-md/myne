// The mobile extracted-text read, pinned at the boundary the photo-to-note sheet
// switches on (myne-md/myne#926).
//
// The desktop binding answers `AttachmentExtractedText | null`. Mobile cannot:
// the sheet has to tell "this page has no text" apart from "the vault locked
// while the sheet was open", and `null` collapses them. So the mobile binding
// owns a four-arm union, and this spec is what holds the arms to the two things
// the Rust command can actually say: a payload, or `{ kind: "Locked" }`.
//
// The failure arms are the ones worth asserting. A `Locked` mapped to `none`
// would render "no text found" over a vault that had merely locked, which reads
// as a blank page and invites the user to add an image-only note from a surface
// that no longer has the right to read it.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("../src/platform/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { attachmentReadExtractedText } from "../src/lib/attachments";

const ID = "a".repeat(64);

beforeEach(() => {
  invoke.mockReset();
});

describe("attachmentReadExtractedText", () => {
  it("reads the command by attachment id and returns the entry", async () => {
    invoke.mockResolvedValue({
      text: "Toplantı notları\nyarın 14:00",
      source_format: "image",
      truncated: false,
    });

    const out = await attachmentReadExtractedText(ID);

    expect(invoke).toHaveBeenCalledWith(
      "plugin:attachments|attachment_read_extracted_text",
      { id: ID },
    );
    expect(out).toEqual({
      kind: "text",
      entry: {
        text: "Toplantı notları\nyarın 14:00",
        source_format: "image",
        truncated: false,
      },
    });
  });

  it("treats a null payload as no text, not as an error", async () => {
    invoke.mockResolvedValue(null);
    expect(await attachmentReadExtractedText(ID)).toEqual({ kind: "none" });
  });

  it("treats a whitespace-only payload as no text", async () => {
    // The import OCRs a blank photo into an EMPTY cached entry. Showing the user
    // an editable field of spaces would look like a read that found something.
    invoke.mockResolvedValue({ text: "   \n\t", source_format: "image", truncated: false });
    expect(await attachmentReadExtractedText(ID)).toEqual({ kind: "none" });
  });

  it("separates a locked vault from a failed read", async () => {
    invoke.mockRejectedValueOnce({ kind: "Locked" });
    expect(await attachmentReadExtractedText(ID)).toEqual({ kind: "locked" });

    // A bare identifier is the other spelling a unit variant can arrive as.
    invoke.mockRejectedValueOnce("Locked");
    expect(await attachmentReadExtractedText(ID)).toEqual({ kind: "locked" });

    invoke.mockRejectedValueOnce({ kind: "Io" });
    expect(await attachmentReadExtractedText(ID)).toEqual({ kind: "failed" });

    invoke.mockRejectedValueOnce(new Error("socket closed"));
    expect(await attachmentReadExtractedText(ID)).toEqual({ kind: "failed" });
  });
});
