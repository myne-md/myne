// Extension → human type label for generic attachment file-cards (MYND-173).
// Pure unit tests — no DOM, no IPC.

import { describe, expect, it } from "vitest";
import {
  extensionOf,
  fileTypeLabel,
} from "../../src/editor/attachments/fileKind";

describe("extensionOf", () => {
  it("returns the lowercase extension after the last dot", () => {
    expect(extensionOf("report.docx")).toBe("docx");
    expect(extensionOf("archive.tar.gz")).toBe("gz");
    expect(extensionOf("PHOTO.JPG")).toBe("jpg");
  });

  it("returns null when there is no usable extension", () => {
    expect(extensionOf("README")).toBeNull();
    expect(extensionOf(".gitignore")).toBeNull(); // leading-dot dotfile
    expect(extensionOf("name.")).toBeNull(); // trailing dot
  });

  it("does not treat a dotted folder segment as the extension", () => {
    expect(extensionOf("my.folder/file")).toBeNull();
    expect(extensionOf("my.folder/data.csv")).toBe("csv");
  });
});

describe("fileTypeLabel", () => {
  it("maps common doc extensions to friendly labels", () => {
    expect(fileTypeLabel("q3.docx")).toBe("Word document");
    expect(fileTypeLabel("budget.xlsx")).toBe("Spreadsheet");
    expect(fileTypeLabel("deck.pptx")).toBe("Presentation");
    expect(fileTypeLabel("bundle.zip")).toBe("Archive");
    expect(fileTypeLabel("notes.md")).toBe("Markdown");
  });

  it("is case-insensitive on the extension", () => {
    expect(fileTypeLabel("Report.DOCX")).toBe("Word document");
    expect(fileTypeLabel("DATA.CSV")).toBe("CSV");
  });

  it("falls back to '<EXT> file' for an unknown extension", () => {
    expect(fileTypeLabel("model.sketch")).toBe("SKETCH file");
  });

  it("falls back to the generic 'File' when there is no extension", () => {
    expect(fileTypeLabel("LICENSE")).toBe("File");
    expect(fileTypeLabel(".env")).toBe("File");
  });
});
