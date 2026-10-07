// Meeting AI task 3: the production write path.
//
// The ordering is the property under test: the pane flush must run BEFORE the
// read, or the pane's autosave clobbers the write (myne-md/myne#520), and the
// update must carry the AI block with the transcript still present. The IO
// modules are mocked so this asserts the orchestration, not the disk.

import { beforeEach, describe, expect, it, vi } from "vitest";

const order: string[] = [];

vi.mock("../../src/notes/flushBeforeFrontmatterWrite", () => ({
  flushBeforeFrontmatterWrite: vi.fn(async () => {
    order.push("flush");
  }),
}));
vi.mock("../../src/notes/readNote", () => ({
  noteRead: vi.fn(async () => {
    order.push("read");
    return "the transcript";
  }),
}));
vi.mock("../../src/notes/updateNote", () => ({
  noteUpdate: vi.fn(async () => {
    order.push("update");
  }),
}));
vi.mock("../../src/notes/vaultIndices", () => ({
  reindexNoteFromBody: vi.fn(),
}));
vi.mock("../../src/dialect", () => ({
  patchUpdatedField: (bytes: Uint8Array): Uint8Array => bytes,
}));

import { flushBeforeFrontmatterWrite } from "../../src/notes/flushBeforeFrontmatterWrite";
import { noteUpdate } from "../../src/notes/updateNote";
import { writeMeetingSectionsToNote } from "../../src/notes/ai/meetingWriteToNote";

describe("writeMeetingSectionsToNote", () => {
  beforeEach(() => {
    order.length = 0;
    vi.clearAllMocks();
  });

  it("flushes, reads, then updates with the AI block appended", async () => {
    await writeMeetingSectionsToNote("n1", { summary: "S" }, "notice");

    expect(flushBeforeFrontmatterWrite).toHaveBeenCalledOnce();
    expect(order).toEqual(["flush", "read", "update"]);
    const body = (noteUpdate as unknown as { mock: { calls: [string, string][] } })
      .mock.calls[0]![1];
    expect(body).toContain("the transcript");
    expect(body).toContain("## Summary");
  });
});
