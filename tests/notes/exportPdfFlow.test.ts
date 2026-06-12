// MYND-255 task 5: the shared per-note "Export as PDF…" flow
// (`src/notes/exportFlow.ts::runNotePdfExportFlow`) + the closed-enum →
// copy mapping (`src/lib/note-export-errors.ts::notePdfExportErrorMessage`;
// exportFlow.test.ts is the markdown precedent).
//
// Both trigger surfaces (sidebar context menu + palette action) call
// `runNotePdfExportFlow` — these tests pin the flow's contract once:
// body read; exclusion-notice gating via the CHEAP pre-flight scan
// (`scanExcludedAttachments` — the emitter's classification without the
// emitter; nothing excluded → no notice; excluded → the hook is asked
// with the scanned list; cancel = free exit, nothing invoked, EMITTER
// NEVER IMPORTED); dialog dismissed → silent no-op (emitter never
// imported); destination confirmed → ONLY THEN the lazy emitter
// projection → `pdf_export_render` with the EMITTED html/title +
// overwrite=true and a "Exported to <basename>" toast (full path rides
// `revealPath` only); failure → mapped plain-English copy. The emitter
// module is mocked at the module seam — the dynamic `import()` in the
// flow resolves to the mock, so the heavy renderers never load here
// (their goldens live in tests/dialect/html).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saveMock = vi.fn();
const invokeMock = vi.fn();
const revealMock = vi.fn();
const emitMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => saveMock(...args),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: (...args: unknown[]) => revealMock(...args),
}));
vi.mock("../../src/dialect/html/emitNoteHtml", () => ({
  emitNoteHtml: (...args: unknown[]) => emitMock(...args),
}));

import {
  defaultExportFilename,
  runNotePdfExportFlow,
} from "../../src/notes/exportFlow";
import {
  noteExportErrorMessage,
  notePdfExportErrorMessage,
} from "../../src/lib/note-export-errors";
import { EXPORT_PDF_PLAIN_SENTENCE } from "../../src/lib/load-bearing-copy";
import type { PdfExportError } from "../../src/types/pdf-export-error";

beforeEach(() => {
  saveMock.mockReset();
  invokeMock.mockReset();
  revealMock.mockReset();
  emitMock.mockReset();
});
afterEach(() => {
  saveMock.mockReset();
  invokeMock.mockReset();
  revealMock.mockReset();
  emitMock.mockReset();
});

const NOTE_ID = "0190a5e2-2222-7000-8000-000000000002";

/** A projection with nothing excluded (image-only / plain note). */
const EMITTED_CLEAN = {
  html: '<h1 class="note-title">Clean</h1>\n<p>body</p>',
  title: "Clean",
  excludedAttachments: [],
};

/** Bodies for the pre-flight scan: a PDF + an unknown-type embed (both
 *  excluded, in document order) and an image embed (inlined, never in
 *  the notice). */
const ATT_PDF = "a".repeat(64);
const ATT_BIN = "b".repeat(64);
const ATT_IMG = "c".repeat(64);
const EXCLUDED = [
  { id: ATT_PDF, filename: "report.pdf" },
  { id: ATT_BIN, filename: "data.bin" },
];
const BODY_WITH_EXCLUSIONS = [
  `intro ![[att:${ATT_PDF}|report.pdf]]`,
  `then ![[att:${ATT_BIN}|data.bin]] and ![[att:${ATT_IMG}|photo.png]]`,
].join("\n");
const BODY_IMAGE_ONLY = `just ![[att:${ATT_IMG}|photo.png]]`;

describe("defaultExportFilename — pdf extension", () => {
  it("derives <title>.pdf when ext is 'pdf'", () => {
    expect(defaultExportFilename("Weekly review", "pdf")).toBe(
      "Weekly review.pdf",
    );
  });

  it("falls back to Untitled.pdf for null / empty titles", () => {
    expect(defaultExportFilename(null, "pdf")).toBe("Untitled.pdf");
    expect(defaultExportFilename("   ", "pdf")).toBe("Untitled.pdf");
  });

  it("default ext stays 'md' (markdown callers unchanged)", () => {
    expect(defaultExportFilename("Weekly review")).toBe("Weekly review.md");
  });
});

describe("runNotePdfExportFlow", () => {
  it("opens the save dialog with the title-derived .pdf default + PDF filter + the egress sentence as the dialog title (no-notice path)", async () => {
    emitMock.mockResolvedValue(EMITTED_CLEAN);
    saveMock.mockResolvedValue(null);
    await runNotePdfExportFlow({
      noteId: NOTE_ID,
      noteTitle: "My note",
      showToast: vi.fn(),
      getBody: async () => "body",
    });
    // Full-literal args: on the common no-notice path the load-bearing
    // egress sentence rides the dialog title (SYNC-6 — said once at the
    // decision point; 116-M1's PDF twin).
    expect(saveMock).toHaveBeenCalledWith({
      title: EXPORT_PDF_PLAIN_SENTENCE,
      defaultPath: "My note.pdf",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
  });

  it("null IPC rejection → generic fallback copy, never a throw (never-throws contract)", async () => {
    emitMock.mockResolvedValue(EMITTED_CLEAN);
    saveMock.mockResolvedValue("/home/u/Desktop/x.pdf");
    invokeMock.mockRejectedValue(null);
    const showToast = vi.fn();
    await expect(
      runNotePdfExportFlow({
        noteId: NOTE_ID,
        noteTitle: "x",
        showToast,
        getBody: async () => "body",
      }),
    ).resolves.toBeUndefined();
    expect(showToast).toHaveBeenCalledWith({
      message: "Export failed unexpectedly. Try again.",
    });
  });

  it("projects the body through the emitter (lazy module seam) only AFTER a destination is confirmed", async () => {
    emitMock.mockResolvedValue(EMITTED_CLEAN);
    saveMock.mockImplementation(async () => {
      // The dialog precedes the projection — no wasted renders.
      expect(emitMock).not.toHaveBeenCalled();
      return "/home/u/Desktop/x.pdf";
    });
    invokeMock.mockResolvedValue(undefined);
    await runNotePdfExportFlow({
      noteId: NOTE_ID,
      noteTitle: "x",
      showToast: vi.fn(),
      getBody: async () => "the body bytes",
    });
    expect(emitMock).toHaveBeenCalledWith("the body bytes");
  });

  it("default body provider is the note_read IPC", async () => {
    emitMock.mockResolvedValue(EMITTED_CLEAN);
    saveMock.mockResolvedValue(null);
    invokeMock.mockResolvedValue("body");
    await runNotePdfExportFlow({
      noteId: NOTE_ID,
      noteTitle: "x",
      showToast: vi.fn(),
    });
    expect(invokeMock).toHaveBeenCalledWith("plugin:notes|note_read", {
      noteId: NOTE_ID,
    });
  });

  it("body read failure → read-failure toast; no emit, no dialog, no export IPC", async () => {
    const showToast = vi.fn();
    await runNotePdfExportFlow({
      noteId: NOTE_ID,
      noteTitle: "x",
      showToast,
      getBody: async () => Promise.reject({ kind: "CannotDecrypt" }),
    });
    expect(emitMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith({
      message: "This note could not be read.",
    });
  });

  it("dialog dismissed → silent no-op: no emitter import, no IPC, no toast", async () => {
    emitMock.mockResolvedValue(EMITTED_CLEAN);
    saveMock.mockResolvedValue(null);
    const showToast = vi.fn();
    await runNotePdfExportFlow({
      noteId: NOTE_ID,
      noteTitle: "x",
      showToast,
      getBody: async () => "body",
    });
    expect(emitMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("path chosen → pdf_export_render with the EMITTED html/title and overwrite=true; toast carries the basename + revealPath", async () => {
    emitMock.mockResolvedValue(EMITTED_CLEAN);
    saveMock.mockResolvedValue("/home/u/Desktop/My note.pdf");
    invokeMock.mockResolvedValue(undefined);
    const showToast = vi.fn();
    await runNotePdfExportFlow({
      noteId: NOTE_ID,
      noteTitle: "My note",
      showToast,
      getBody: async () => "body",
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "plugin:pdf-export|pdf_export_render",
      {
        html: EMITTED_CLEAN.html,
        title: EMITTED_CLEAN.title,
        targetPath: "/home/u/Desktop/My note.pdf",
        overwrite: true,
      },
    );
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith({
      message: "Exported to My note.pdf",
      revealPath: "/home/u/Desktop/My note.pdf",
    });
  });

  it("untitled note → emitted title null rides the IPC as null", async () => {
    emitMock.mockResolvedValue({ ...EMITTED_CLEAN, title: null });
    saveMock.mockResolvedValue("/home/u/Untitled.pdf");
    invokeMock.mockResolvedValue(undefined);
    await runNotePdfExportFlow({
      noteId: NOTE_ID,
      noteTitle: null,
      showToast: vi.fn(),
      getBody: async () => "body",
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "plugin:pdf-export|pdf_export_render",
      expect.objectContaining({ title: null }),
    );
  });

  it("backend rejection → toasts the mapped copy for the variant", async () => {
    emitMock.mockResolvedValue(EMITTED_CLEAN);
    saveMock.mockResolvedValue("/home/u/Desktop/x.pdf");
    invokeMock.mockRejectedValue({ kind: "RenderTimeout" });
    const showToast = vi.fn();
    await runNotePdfExportFlow({
      noteId: NOTE_ID,
      noteTitle: "x",
      showToast,
      getBody: async () => "body",
    });
    expect(showToast).toHaveBeenCalledWith({
      message: notePdfExportErrorMessage({ kind: "RenderTimeout" }),
    });
  });

  it("out-of-contract rejection shape → generic fallback copy", async () => {
    emitMock.mockResolvedValue(EMITTED_CLEAN);
    saveMock.mockResolvedValue("/home/u/Desktop/x.pdf");
    invokeMock.mockRejectedValue("something opaque");
    const showToast = vi.fn();
    await runNotePdfExportFlow({
      noteId: NOTE_ID,
      noteTitle: "x",
      showToast,
      getBody: async () => "body",
    });
    expect(showToast).toHaveBeenCalledWith({
      message: "Export failed unexpectedly. Try again.",
    });
  });
});

describe("runNotePdfExportFlow — exclusion-notice gating (cheap pre-flight scan)", () => {
  it("nothing excluded → hook never asked, straight to the dialog", async () => {
    emitMock.mockResolvedValue(EMITTED_CLEAN);
    saveMock.mockResolvedValue(null);
    const confirmPdfExclusions = vi.fn();
    await runNotePdfExportFlow({
      noteId: NOTE_ID,
      noteTitle: "Plain",
      showToast: vi.fn(),
      confirmPdfExclusions,
      getBody: async () => "no embeds",
    });
    expect(confirmPdfExclusions).not.toHaveBeenCalled();
    expect(saveMock).toHaveBeenCalledTimes(1);
  });

  it("image-only embeds → not excluded, hook never asked", async () => {
    emitMock.mockResolvedValue(EMITTED_CLEAN);
    saveMock.mockResolvedValue(null);
    const confirmPdfExclusions = vi.fn();
    await runNotePdfExportFlow({
      noteId: NOTE_ID,
      noteTitle: "Images",
      showToast: vi.fn(),
      confirmPdfExclusions,
      getBody: async () => BODY_IMAGE_ONLY,
    });
    expect(confirmPdfExclusions).not.toHaveBeenCalled();
    expect(saveMock).toHaveBeenCalledTimes(1);
  });

  it("excluded attachments → hook asked with the scanned list (non-image embeds only), BEFORE the dialog and the emitter import", async () => {
    emitMock.mockResolvedValue(EMITTED_CLEAN);
    const confirmPdfExclusions = vi.fn().mockImplementation(async () => {
      // The notice precedes the dialog AND the heavy projection.
      expect(saveMock).not.toHaveBeenCalled();
      expect(emitMock).not.toHaveBeenCalled();
      return true;
    });
    saveMock.mockResolvedValue(null);
    await runNotePdfExportFlow({
      noteId: NOTE_ID,
      noteTitle: "Atts",
      showToast: vi.fn(),
      confirmPdfExclusions,
      getBody: async () => BODY_WITH_EXCLUSIONS,
    });
    expect(confirmPdfExclusions).toHaveBeenCalledWith(EXCLUDED);
    expect(saveMock).toHaveBeenCalledTimes(1);
  });

  it("notice shown → dialog title omitted (the sentence was already said once at the decision point)", async () => {
    emitMock.mockResolvedValue(EMITTED_CLEAN);
    saveMock.mockResolvedValue(null);
    await runNotePdfExportFlow({
      noteId: NOTE_ID,
      noteTitle: "Atts",
      showToast: vi.fn(),
      confirmPdfExclusions: vi.fn().mockResolvedValue(true),
      getBody: async () => BODY_WITH_EXCLUSIONS,
    });
    // Full-literal args: NO `title` key — the pre-export notice rendered
    // the egress sentence, so the dialog must not say it twice.
    expect(saveMock).toHaveBeenCalledWith({
      defaultPath: "Atts.pdf",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
  });

  it("notice cancel = free exit: no emitter import, no dialog, no export IPC, no toast", async () => {
    emitMock.mockResolvedValue(EMITTED_CLEAN);
    const showToast = vi.fn();
    await runNotePdfExportFlow({
      noteId: NOTE_ID,
      noteTitle: "Atts",
      showToast,
      confirmPdfExclusions: vi.fn().mockResolvedValue(false),
      getBody: async () => BODY_WITH_EXCLUSIONS,
    });
    expect(emitMock).not.toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("no hook supplied → exclusions skip the notice (inert degrade), export proceeds", async () => {
    emitMock.mockResolvedValue(EMITTED_CLEAN);
    saveMock.mockResolvedValue(null);
    await runNotePdfExportFlow({
      noteId: NOTE_ID,
      noteTitle: "Atts",
      showToast: vi.fn(),
      getBody: async () => BODY_WITH_EXCLUSIONS,
    });
    expect(saveMock).toHaveBeenCalledTimes(1);
  });

  it("dialog dismissed after the notice → silent no-op (no emit, no export IPC)", async () => {
    emitMock.mockResolvedValue(EMITTED_CLEAN);
    saveMock.mockResolvedValue(null);
    const showToast = vi.fn();
    await runNotePdfExportFlow({
      noteId: NOTE_ID,
      noteTitle: "Atts",
      showToast,
      confirmPdfExclusions: vi.fn().mockResolvedValue(true),
      getBody: async () => BODY_WITH_EXCLUSIONS,
    });
    expect(emitMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });
});

describe("notePdfExportErrorMessage closed-enum copy map", () => {
  // Every variant (with all reachable Io sub-kinds) → its mapped copy.
  const table: Array<[label: string, e: PdfExportError]> = [
    ["ExportInProgress", { kind: "ExportInProgress" }],
    ["InvalidDestination", { kind: "InvalidDestination" }],
    ["TargetAlreadyExists", { kind: "TargetAlreadyExists" }],
    ["WindowCreateFailed", { kind: "WindowCreateFailed" }],
    ["RenderTimeout", { kind: "RenderTimeout" }],
    ["PayloadMissing", { kind: "PayloadMissing" }],
    [
      "CaptureFailed",
      { kind: "CaptureFailed", detail: { capture_failure_kind: "Timeout" } },
    ],
    ["Io/NoSpace", { kind: "Io", detail: { io_error_kind: "NoSpace" } }],
    [
      "Io/PermissionDenied",
      { kind: "Io", detail: { io_error_kind: "PermissionDenied" } },
    ],
    ["Io/Other", { kind: "Io", detail: { io_error_kind: "Other" } }],
    ["JoinFailure", { kind: "JoinFailure" }],
  ];

  it("covers every PdfExportError variant with non-empty copy", () => {
    for (const [, e] of table) {
      expect(notePdfExportErrorMessage(e).length).toBeGreaterThan(0);
    }
  });

  it("distinct variants read distinctly", () => {
    const messages = table.map(([, e]) => notePdfExportErrorMessage(e));
    expect(new Set(messages).size).toBe(messages.length);
  });

  it("every CaptureFailureKind collapses into the one capture sentence (kinds are log taxonomy, not user copy)", () => {
    const kinds = [
      "Dispatch",
      "ChannelClosed",
      "Timeout",
      "NativePrintFailed",
      "OutputMissing",
      "Unsupported",
    ] as const;
    const messages = new Set(
      kinds.map((k) =>
        notePdfExportErrorMessage({
          kind: "CaptureFailed",
          detail: { capture_failure_kind: k },
        }),
      ),
    );
    expect(messages.size).toBe(1);
  });

  it("destination/IO variants reuse the markdown export's copy verbatim (one export vocabulary)", () => {
    expect(notePdfExportErrorMessage({ kind: "InvalidDestination" })).toBe(
      noteExportErrorMessage({ kind: "InvalidDestination" }),
    );
    expect(notePdfExportErrorMessage({ kind: "TargetAlreadyExists" })).toBe(
      noteExportErrorMessage({ kind: "TargetAlreadyExists" }),
    );
    for (const k of ["NoSpace", "PermissionDenied", "Other"] as const) {
      expect(
        notePdfExportErrorMessage({ kind: "Io", detail: { io_error_kind: k } }),
      ).toBe(noteExportErrorMessage({ kind: "Io", detail: { io_error_kind: k } }));
    }
    expect(notePdfExportErrorMessage({ kind: "JoinFailure" })).toBe(
      noteExportErrorMessage({ kind: "JoinFailure" }),
    );
  });
});
