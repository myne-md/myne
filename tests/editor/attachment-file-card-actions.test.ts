// @vitest-environment jsdom
//
// File-card overflow-menu action handlers (MYND-173): Export (Save As), Rename,
// Remove-from-note, Reveal-in-library. The Tauri dialog + the attachment IPC
// wrappers + the in-WebView rename prompt + the toast are mocked at module
// scope so each handler's branch logic is exercised without a Tauri runtime.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const save = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: (...a: unknown[]) => save(...a) }));

const attachmentExport = vi.fn();
const attachmentRename = vi.fn();
vi.mock("../../src/lib/attachments", () => ({
  attachmentExport: (...a: unknown[]) => attachmentExport(...a),
  attachmentRename: (...a: unknown[]) => attachmentRename(...a),
}));

const promptForName = vi.fn();
vi.mock("../../src/editor/attachments/renamePrompt", () => ({
  promptForName: (...a: unknown[]) => promptForName(...a),
}));

const showAttachmentToast = vi.fn();
vi.mock("../../src/editor/attachments/toast", () => ({
  showAttachmentToast: (...a: unknown[]) => showAttachmentToast(...a),
}));

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { forceParsing } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Wikilink } from "../../src/dialect/lezer/wikilink";
import {
  REVEAL_ATTACHMENT_EVENT,
  exportAttachment,
  removeFileCard,
  renameFileCard,
  revealFileCard,
} from "../../src/editor/attachments/fileCardActions";
import {
  addCatalogRows,
  attachmentCatalogExtension,
  catalogField,
  setCatalogLoader,
} from "../../src/editor/attachments/catalog";
import { attachmentEmbedDecorations } from "../../src/editor/decorations/attachment-embed";
import { wikilinkChipExtensions } from "../../src/editor/wikilink";

const ID = "a".repeat(64);

const restores: Array<() => void> = [];

function mount(doc: string): EditorView {
  // Pin the catalog loader to a never-resolving promise so the loader plugin's
  // async dispatch can't clobber the rows the tests seed via addCatalogRows.
  restores.push(setCatalogLoader(() => new Promise<never>(() => {})));
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length, head: doc.length },
      extensions: [
        markdown({ base: markdownLanguage, extensions: [Wikilink] }),
        ...attachmentCatalogExtension(),
        ...attachmentEmbedDecorations(),
        ...wikilinkChipExtensions(),
      ],
    }),
    parent: host,
  });
  // The remove path walks the syntax tree; force a full parse synchronously.
  forceParsing(view, view.state.doc.length, 5_000);
  return view;
}

afterEach(() => {
  restores.splice(0).forEach((r) => r());
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("exportAttachment", () => {
  it("exports the picked destination with overwrite=true and toasts success", async () => {
    save.mockResolvedValue("/out/report.docx");
    attachmentExport.mockResolvedValue(undefined);
    await exportAttachment(ID, "report.docx");
    expect(save).toHaveBeenCalledWith({ defaultPath: "report.docx" });
    expect(attachmentExport).toHaveBeenCalledWith(ID, "/out/report.docx", true);
    expect(showAttachmentToast).toHaveBeenCalledWith("Exported report.docx.");
  });

  it("is a silent no-op when the save dialog is cancelled (null)", async () => {
    save.mockResolvedValue(null);
    await exportAttachment(ID, "x.docx");
    expect(attachmentExport).not.toHaveBeenCalled();
    expect(showAttachmentToast).not.toHaveBeenCalled();
  });

  it("toasts a dialog-open failure and does not attempt the export", async () => {
    save.mockRejectedValue(new Error("dialog crashed"));
    await exportAttachment(ID, "x.docx");
    expect(attachmentExport).not.toHaveBeenCalled();
    expect(showAttachmentToast).toHaveBeenCalledWith("Couldn't open the save dialog.");
  });

  it("toasts an export failure when the host write rejects", async () => {
    save.mockResolvedValue("/out/x.docx");
    attachmentExport.mockRejectedValue(new Error("io"));
    await exportAttachment(ID, "x.docx");
    expect(showAttachmentToast).toHaveBeenCalledWith("Couldn't export x.docx.");
  });
});

describe("renameFileCard", () => {
  beforeEach(() => {
    attachmentRename.mockResolvedValue(undefined);
  });

  it("renames via IPC and optimistically updates the catalog row, then toasts", async () => {
    const view = mount(`![[att:${ID}|old.docx]]`);
    addCatalogRows(view, [
      { id: ID, contentType: "application/octet-stream", filename: "old.docx", size: 7 },
    ]);
    promptForName.mockResolvedValue("new.docx");
    await renameFileCard(view, ID, "old.docx");
    expect(attachmentRename).toHaveBeenCalledWith(ID, "new.docx");
    // The cached catalog row reflects the new name without a note reload.
    expect(view.state.field(catalogField)!.get(ID)!.filename).toBe("new.docx");
    expect(showAttachmentToast).toHaveBeenCalledWith("Renamed to new.docx.");
    view.destroy();
  });

  it("is a no-op when the prompt is cancelled (null)", async () => {
    const view = mount(`![[att:${ID}|old.docx]]`);
    promptForName.mockResolvedValue(null);
    await renameFileCard(view, ID, "old.docx");
    expect(attachmentRename).not.toHaveBeenCalled();
    view.destroy();
  });

  it("is a no-op when the trimmed name is empty or unchanged", async () => {
    const view = mount(`![[att:${ID}|old.docx]]`);
    promptForName.mockResolvedValueOnce("   ");
    await renameFileCard(view, ID, "old.docx");
    promptForName.mockResolvedValueOnce("old.docx");
    await renameFileCard(view, ID, "old.docx");
    expect(attachmentRename).not.toHaveBeenCalled();
    view.destroy();
  });

  it("toasts a failure and leaves the catalog untouched when the IPC rejects", async () => {
    const view = mount(`![[att:${ID}|old.docx]]`);
    addCatalogRows(view, [
      { id: ID, contentType: "application/octet-stream", filename: "old.docx", size: 7 },
    ]);
    promptForName.mockResolvedValue("new.docx");
    attachmentRename.mockRejectedValue(new Error("locked"));
    await renameFileCard(view, ID, "old.docx");
    expect(showAttachmentToast).toHaveBeenCalledWith("Couldn't rename the attachment.");
    expect(view.state.field(catalogField)!.get(ID)!.filename).toBe("old.docx");
    view.destroy();
  });
});

describe("removeFileCard", () => {
  it("deletes the whole embed span when the card position resolves to this id", () => {
    const doc = `x ![[att:${ID}|p.png]] y`;
    const view = mount(doc);
    // The card el maps to the embed via posAtDOM; stub it to the embed's start.
    const cardEl = document.createElement("span");
    vi.spyOn(view, "posAtDOM").mockReturnValue(doc.indexOf("![["));
    removeFileCard(view, cardEl, ID);
    expect(view.state.doc.toString()).toBe("x  y");
    view.destroy();
  });

  it("is a no-op when the position no longer resolves to this id's embed", () => {
    const doc = `plain text only`;
    const view = mount(doc);
    const cardEl = document.createElement("span");
    vi.spyOn(view, "posAtDOM").mockReturnValue(3);
    removeFileCard(view, cardEl, ID);
    expect(view.state.doc.toString()).toBe(doc);
    view.destroy();
  });
});

describe("revealFileCard", () => {
  it("dispatches a bubbling reveal-attachment CustomEvent carrying the id", () => {
    const view = mount("");
    const seen: Array<{ id: string }> = [];
    view.dom.addEventListener(REVEAL_ATTACHMENT_EVENT, (e) => {
      seen.push((e as CustomEvent).detail);
    });
    revealFileCard(view, ID);
    expect(seen).toEqual([{ id: ID }]);
    view.destroy();
  });
});
