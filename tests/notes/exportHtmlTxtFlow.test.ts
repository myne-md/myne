// note-export MYND-340 task 3: the shared per-note "Export as HTML…" +
// "Export as Plain Text…" flows
// (`src/notes/exportFlow.ts::runNoteHtmlExportFlow` /
// `runNoteTxtExportFlow`). Mirrors `exportPdfFlow.test.ts` /
// `exportFlow.test.ts`.
//
// Both trigger surfaces (sidebar context menu + palette action) call the
// shared flow — these tests pin the contract once: body read; HTML
// image-attachment pre-flight gating via the cheap `scanImageAttachments`
// scan (no images → no modal → no-attachments command; images opted in →
// the sidecar command; cancel = free exit, nothing invoked, ASSEMBLER
// NEVER IMPORTED); dialog dismissed → silent no-op; destination confirmed
// → lazy projection → the write IPC with overwrite=true + a
// "Exported to <basename>" toast; failure → mapped copy. The heavy
// modules are mocked at the dynamic-import seam.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saveMock = vi.fn();
const invokeMock = vi.fn();
const revealMock = vi.fn();
const emitHtmlMock = vi.hoisted(() => vi.fn());
const emitTextMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => saveMock(...args),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: (...args: unknown[]) => revealMock(...args),
}));
vi.mock("../../src/dialect/html/htmlDocument", () => ({
  emitStandaloneHtml: (...args: unknown[]) => emitHtmlMock(...args),
}));
vi.mock("../../src/dialect/text/emitNoteText", () => ({
  emitNoteText: (...args: unknown[]) => emitTextMock(...args),
}));

import {
  runNoteHtmlExportFlow,
  runNoteTxtExportFlow,
} from "../../src/notes/exportFlow";
import {
  EXPORT_PLAIN_HTML_SENTENCE,
  EXPORT_PLAIN_TEXT_SENTENCE,
} from "../../src/lib/load-bearing-copy";

beforeEach(() => {
  saveMock.mockReset();
  invokeMock.mockReset();
  revealMock.mockReset();
  emitHtmlMock.mockReset();
  emitTextMock.mockReset();
});
afterEach(() => {
  saveMock.mockReset();
  invokeMock.mockReset();
  revealMock.mockReset();
  emitHtmlMock.mockReset();
  emitTextMock.mockReset();
});

const NOTE_ID = "0190a5e2-3333-7000-8000-000000000003";
const ATT_IMG = "c".repeat(64);
const BODY_PLAIN = "# Title\n\nplain body";
const BODY_IMAGE = `pic ![[att:${ATT_IMG}|photo.png]]`;
const DOC = "<!DOCTYPE html><html><body><p>x</p></body></html>";

describe("runNoteHtmlExportFlow — no images (plain note)", () => {
  it("no modal; dialog title carries the egress sentence; note_export_html with overwrite=true; toast + reveal", async () => {
    saveMock.mockResolvedValue("/tmp/out.html");
    emitHtmlMock.mockResolvedValue({ document: DOC, title: "Title" });
    invokeMock.mockResolvedValue(undefined);
    const showToast = vi.fn();
    const confirmAttachments = vi.fn();

    await runNoteHtmlExportFlow({
      noteId: NOTE_ID,
      noteTitle: "Title",
      showToast,
      confirmAttachments,
      getBody: async () => BODY_PLAIN,
    });

    // No image refs → the modal is never asked.
    expect(confirmAttachments).not.toHaveBeenCalled();
    // The egress sentence rides the dialog title (SYNC-6).
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock.mock.calls[0]![0]).toMatchObject({
      title: EXPORT_PLAIN_HTML_SENTENCE,
    });
    // Wrote via the no-attachments command with the composed doc.
    expect(invokeMock).toHaveBeenCalledWith(
      "plugin:notes|note_export_html",
      { html: DOC, targetPath: "/tmp/out.html", overwrite: true },
    );
    expect(showToast).toHaveBeenCalledWith({
      message: "Exported to out.html",
      revealPath: "/tmp/out.html",
    });
  });

  it("dialog dismissed → silent no-op, assembler never imported/invoked", async () => {
    saveMock.mockResolvedValue(null);
    const showToast = vi.fn();
    await runNoteHtmlExportFlow({
      noteId: NOTE_ID,
      noteTitle: null,
      showToast,
      getBody: async () => BODY_PLAIN,
    });
    expect(emitHtmlMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });
});

describe("runNoteHtmlExportFlow — images opted in", () => {
  it("shows the modal (no dialog title), then the sidecar command; toast counts images", async () => {
    saveMock.mockResolvedValue("/exports/out.html");
    emitHtmlMock.mockResolvedValue({ document: DOC, title: null });
    invokeMock.mockResolvedValue(2);
    const showToast = vi.fn();
    const confirmAttachments = vi
      .fn()
      .mockResolvedValue({ includeAttachments: true });

    await runNoteHtmlExportFlow({
      noteId: NOTE_ID,
      noteTitle: "Pics",
      showToast,
      confirmAttachments,
      getBody: async () => BODY_IMAGE,
    });

    // One image ref → the modal is asked with the count AND the note id
    // (MYND-643: so the modal's Copy targets this note, not the open one).
    expect(confirmAttachments).toHaveBeenCalledWith(1, NOTE_ID);
    // Modal showed the egress sentence, so the dialog title is omitted.
    expect(saveMock.mock.calls[0]![0]).not.toHaveProperty("title");
    expect(invokeMock).toHaveBeenCalledWith(
      "plugin:notes|note_export_html_attachments",
      {
        noteId: NOTE_ID,
        html: DOC,
        targetDir: "/exports",
        noteFilename: "out.html",
        overwrite: true,
      },
    );
    expect(showToast).toHaveBeenCalledWith({
      message: "Exported to out.html + 2 images",
      revealPath: "/exports/out.html",
    });
  });

  it("modal cancel = free exit: no dialog, no assembler, nothing invoked", async () => {
    const confirmAttachments = vi.fn().mockResolvedValue(null);
    const showToast = vi.fn();
    await runNoteHtmlExportFlow({
      noteId: NOTE_ID,
      noteTitle: null,
      showToast,
      confirmAttachments,
      getBody: async () => BODY_IMAGE,
    });
    expect(saveMock).not.toHaveBeenCalled();
    expect(emitHtmlMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("opted OUT → the no-attachments command (HTML-only)", async () => {
    saveMock.mockResolvedValue("/exports/out.html");
    emitHtmlMock.mockResolvedValue({ document: DOC, title: null });
    invokeMock.mockResolvedValue(undefined);
    const showToast = vi.fn();
    await runNoteHtmlExportFlow({
      noteId: NOTE_ID,
      noteTitle: null,
      showToast,
      confirmAttachments: vi.fn().mockResolvedValue({ includeAttachments: false }),
      getBody: async () => BODY_IMAGE,
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "plugin:notes|note_export_html",
      expect.objectContaining({ targetPath: "/exports/out.html" }),
    );
  });
});

describe("runNoteTxtExportFlow", () => {
  it("dialog title carries the egress sentence; note_export_html with the stripped text + newline; toast", async () => {
    saveMock.mockResolvedValue("/tmp/out.txt");
    emitTextMock.mockReturnValue("Title\n\nplain body");
    invokeMock.mockResolvedValue(undefined);
    const showToast = vi.fn();

    await runNoteTxtExportFlow({
      noteId: NOTE_ID,
      noteTitle: "Title",
      showToast,
      getBody: async () => BODY_PLAIN,
    });

    expect(saveMock.mock.calls[0]![0]).toMatchObject({
      title: EXPORT_PLAIN_TEXT_SENTENCE,
    });
    // The stripped text is written verbatim (with a trailing newline) via
    // the shared text-write command.
    expect(invokeMock).toHaveBeenCalledWith(
      "plugin:notes|note_export_html",
      {
        html: "Title\n\nplain body\n",
        targetPath: "/tmp/out.txt",
        overwrite: true,
      },
    );
    expect(showToast).toHaveBeenCalledWith({
      message: "Exported to out.txt",
      revealPath: "/tmp/out.txt",
    });
  });

  it("dialog dismissed → silent no-op, emitter never invoked", async () => {
    saveMock.mockResolvedValue(null);
    const showToast = vi.fn();
    await runNoteTxtExportFlow({
      noteId: NOTE_ID,
      noteTitle: null,
      showToast,
      getBody: async () => BODY_PLAIN,
    });
    expect(emitTextMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("read failure → error toast, dialog never opened", async () => {
    const showToast = vi.fn();
    await runNoteTxtExportFlow({
      noteId: NOTE_ID,
      noteTitle: null,
      showToast,
      getBody: async () => {
        throw new Error("read failed");
      },
    });
    expect(saveMock).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith({
      message: "This note could not be read.",
    });
  });
});
