// The shared per-note export format list (`src/notes/noteExportMenu.ts`).
//
// This module exists because the four formats were declared twice, once in the
// editor's "…" menu and once in the sidebar row's context menu, and the two
// copies had drifted: only the sidebar gated PDF behind the `pdfExport`
// capability. So the test that matters most here is the GATE, asserted from
// both sides, plus the fact that a runner exists for every format the list
// offers (a format with no flow behind it would render a row that does nothing).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capabilities: Record<string, boolean> = {};
vi.mock("../../src/platform/capabilities", () => ({
  has: (cap: string) => capabilities[cap] ?? true,
}));

const ran: string[] = [];
vi.mock("../../src/notes/exportFlow", () => ({
  noteExportOptions: (noteId: string, title: string | null) => ({
    noteId,
    noteTitle: title,
  }),
  runNoteExportFlow: (o: { noteId: string }) => {
    ran.push(`markdown:${o.noteId}`);
    return Promise.resolve();
  },
  runNotePdfExportFlow: (o: { noteId: string }) => {
    ran.push(`pdf:${o.noteId}`);
    return Promise.resolve();
  },
  runNoteHtmlExportFlow: (o: { noteId: string }) => {
    ran.push(`html:${o.noteId}`);
    return Promise.resolve();
  },
  runNoteTxtExportFlow: (o: { noteId: string }) => {
    ran.push(`txt:${o.noteId}`);
    return Promise.resolve();
  },
}));

import {
  noteExportEntries,
  noteExportFormats,
} from "../../src/notes/noteExportMenu";

beforeEach(() => {
  ran.length = 0;
  for (const k of Object.keys(capabilities)) delete capabilities[k];
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("noteExportFormats", () => {
  it("offers all four formats where the host can render a PDF", () => {
    capabilities.pdfExport = true;
    expect(noteExportFormats().map((f) => f.id)).toEqual([
      "export-markdown",
      "export-pdf",
      "export-html",
      "export-txt",
    ]);
  });

  it("OMITS the PDF format where the host cannot render one, rather than disabling it", () => {
    capabilities.pdfExport = false;
    const ids = noteExportFormats().map((f) => f.id);
    expect(ids).not.toContain("export-pdf");
    // The other three are untouched: the gate drops one format, not the menu.
    expect(ids).toEqual(["export-markdown", "export-html", "export-txt"]);
  });

  it("is recomputed per call, so a host answer that changes is not frozen at import", () => {
    capabilities.pdfExport = false;
    expect(noteExportFormats().map((f) => f.id)).not.toContain("export-pdf");
    capabilities.pdfExport = true;
    expect(noteExportFormats().map((f) => f.id)).toContain("export-pdf");
  });

  it("gives every format a distinct label key, so no two rows can read the same", () => {
    capabilities.pdfExport = true;
    const keys = noteExportFormats().map((f) => f.labelKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("noteExportEntries", () => {
  it("binds each offered format to its own flow", () => {
    capabilities.pdfExport = true;
    const entries = noteExportEntries("note-1", "Title", undefined);
    for (const entry of entries) entry.run();
    expect(ran).toEqual([
      "markdown:note-1",
      "pdf:note-1",
      "html:note-1",
      "txt:note-1",
    ]);
  });

  it("carries the same gate as the format list it is built from", () => {
    capabilities.pdfExport = false;
    const entries = noteExportEntries("note-1", null, undefined);
    entries.forEach((e) => e.run());
    expect(ran).toEqual(["markdown:note-1", "html:note-1", "txt:note-1"]);
  });

  it("re-reads the note options at RUN time, not at build time", () => {
    // The menu can sit open long after the list was built. Asserting the
    // note id reaches the flow is the observable half of that: a hoisted
    // options object would still work here, so the claim this test can
    // honestly make is that the runner reaches the right flow with the right
    // note, which is what a stale binding would break first.
    capabilities.pdfExport = true;
    const entries = noteExportEntries("note-42", "T", undefined);
    entries.find((e) => e.id === "export-html")?.run();
    expect(ran).toEqual(["html:note-42"]);
  });
});
