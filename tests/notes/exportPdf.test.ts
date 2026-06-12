// MYND-255 task 4: the `exportNotePdf` IPC wrapper — pins the exact
// invoke contract (plugin route + camelCase arg names matching the Rust
// `pdf_export_render` signature) and the closed `PdfExportError` mirror
// helpers, the same way exportFlow.test.ts pins the markdown-export
// wrappers. The UI flow that composes `emitNoteHtml` → wrapper lands
// with task 5; this only covers the seam itself.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { exportNotePdf } from "../../src/notes/exportPdf";
import {
  isPdfCaptureError,
  isPdfExportIoError,
  type PdfExportError,
} from "../../src/types/pdf-export-error";

beforeEach(() => {
  invokeMock.mockReset();
});
afterEach(() => {
  invokeMock.mockReset();
});

describe("exportNotePdf", () => {
  it("invokes pdf-export:pdf_export_render with the exact arg shape", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await exportNotePdf(
      "<h1 class=\"note-title\">T</h1><p>body</p>",
      "T",
      "/tmp/out/Note.pdf",
      false,
    );

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(
      "plugin:pdf-export|pdf_export_render",
      {
        html: "<h1 class=\"note-title\">T</h1><p>body</p>",
        title: "T",
        targetPath: "/tmp/out/Note.pdf",
        overwrite: false,
      },
    );
  });

  it("passes title null for an untitled note and overwrite true verbatim", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await exportNotePdf("<p>x</p>", null, "/tmp/out/Note.pdf", true);

    expect(invokeMock).toHaveBeenCalledWith(
      "plugin:pdf-export|pdf_export_render",
      {
        html: "<p>x</p>",
        title: null,
        targetPath: "/tmp/out/Note.pdf",
        overwrite: true,
      },
    );
  });

  it("propagates the backend rejection untouched (closed-enum payload)", async () => {
    const err: PdfExportError = { kind: "TargetAlreadyExists" };
    invokeMock.mockRejectedValueOnce(err);

    await expect(
      exportNotePdf("<p>x</p>", null, "/tmp/out/Note.pdf", false),
    ).rejects.toEqual({ kind: "TargetAlreadyExists" });
  });
});

describe("PdfExportError narrowing helpers", () => {
  it("isPdfCaptureError narrows only the CaptureFailed variant", () => {
    const capture: PdfExportError = {
      kind: "CaptureFailed",
      detail: { capture_failure_kind: "NativePrintFailed" },
    };
    const unit: PdfExportError = { kind: "RenderTimeout" };

    expect(isPdfCaptureError(capture)).toBe(true);
    expect(isPdfCaptureError(unit)).toBe(false);
    if (isPdfCaptureError(capture)) {
      expect(capture.detail.capture_failure_kind).toBe("NativePrintFailed");
    }
  });

  it("isPdfExportIoError narrows only the Io variant", () => {
    const io: PdfExportError = {
      kind: "Io",
      detail: { io_error_kind: "NoSpace" },
    };
    const unit: PdfExportError = { kind: "PayloadMissing" };

    expect(isPdfExportIoError(io)).toBe(true);
    expect(isPdfExportIoError(unit)).toBe(false);
    if (isPdfExportIoError(io)) {
      expect(io.detail.io_error_kind).toBe("NoSpace");
    }
  });
});
