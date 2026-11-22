// The directory import (myne-md/myne#1075).
//
// The walk is TS over the path-validating read seam, so the three properties
// worth holding are: it recurses, one bad file does not abort the batch, and a
// cancel keeps what already landed. All three are asserted here against a fake
// seam, because a real directory tree in a test is a fixture nobody maintains.

import { beforeEach, describe, expect, it, vi } from "vitest";

const readDir = vi.fn();
const importFile = vi.fn();
const setFolders = vi.fn();

vi.mock("../../src/notes/import/ports", () => ({
  importReadDir: (...args: unknown[]) => readDir(...args),
}));
vi.mock("../../src/lib/attachments", () => ({
  attachmentImport: (...args: unknown[]) => importFile(...args),
  attachmentSetFolders: (...args: unknown[]) => setFolders(...args),
}));

import { importFolderTree } from "../../src/notes/attachments/folderImport";

const file = (name: string) => ({ name, isDir: false, link: null });
const dir = (name: string) => ({ name, isDir: true, link: null });

beforeEach(() => {
  readDir.mockReset();
  importFile.mockReset();
  setFolders.mockReset();
  setFolders.mockResolvedValue(undefined);
});

describe("importFolderTree", () => {
  it("recurses and imports every file it finds", async () => {
    readDir.mockImplementation((_root: string, path: string) => {
      if (path === "/picked") return Promise.resolve([file("a.pdf"), dir("Hafta 1")]);
      return Promise.resolve([file("b.pdf")]);
    });
    importFile.mockResolvedValue({ id: "1".repeat(64), deduplicated: false });

    const summary = await importFolderTree("/picked");

    expect(summary.imported).toBe(2);
    expect(summary.cancelled).toBe(false);
    expect(importFile).toHaveBeenCalledTimes(2);
  });

  it("skips a file the importer refuses, with the reason it gave, and keeps going", async () => {
    readDir.mockResolvedValue([file("a.pdf"), file("b.exe"), file("c.pdf")]);
    importFile
      .mockResolvedValueOnce({ id: "1".repeat(64), deduplicated: false })
      .mockRejectedValueOnce({ kind: "UnsupportedType" })
      .mockResolvedValueOnce({ id: "2".repeat(64), deduplicated: false });

    const summary = await importFolderTree("/picked");

    expect(summary.imported).toBe(2);
    expect(summary.skipped).toEqual({ UnsupportedType: 1 });
  });

  it("does not follow a link, so the walk cannot leave the picked root", async () => {
    readDir.mockResolvedValue([
      { name: "escape", isDir: true, link: { status: "outside" } },
      file("a.pdf"),
    ]);
    importFile.mockResolvedValue({ id: "1".repeat(64), deduplicated: false });

    await importFolderTree("/picked");

    // One call for the root, and no call for the linked directory.
    expect(readDir).toHaveBeenCalledTimes(1);
    expect(importFile).toHaveBeenCalledTimes(1);
  });

  it("keeps what landed when the person cancels", async () => {
    readDir.mockResolvedValue([file("a.pdf"), file("b.pdf"), file("c.pdf")]);
    let done = 0;
    importFile.mockImplementation(() => {
      done += 1;
      return Promise.resolve({ id: `${done}`.repeat(64), deduplicated: false });
    });

    const summary = await importFolderTree("/picked", {
      // Cancel after the first file has been asked about.
      shouldCancel: () => done >= 1,
    });

    expect(summary.cancelled).toBe(true);
    expect(summary.imported).toBe(1);
  });

  it("files the tree into matching folders in one write", async () => {
    readDir.mockImplementation((_root: string, path: string) =>
      path === "/picked"
        ? Promise.resolve([dir("Hafta 1"), file("root.pdf")])
        : Promise.resolve([file("slides.pdf")]),
    );
    importFile.mockImplementation((source: { path: string }) =>
      Promise.resolve({
        id: source.path.endsWith("slides.pdf") ? "1".repeat(64) : "2".repeat(64),
        deduplicated: false,
      }),
    );

    await importFolderTree("/picked", {
      folderFor: (rel) => {
        const slash = rel.lastIndexOf("/");
        return slash === -1 ? "" : `Ders/${rel.slice(0, slash)}/`;
      },
    });

    expect(setFolders).toHaveBeenCalledTimes(1);
    const [assignments] = setFolders.mock.calls[0] as [Array<{ id: string; folder: string }>];
    expect(assignments).toEqual([
      { id: "1".repeat(64), folder: "Ders/Hafta 1/" },
      { id: "2".repeat(64), folder: "" },
    ]);
  });
});
