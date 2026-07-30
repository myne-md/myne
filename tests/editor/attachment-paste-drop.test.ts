// @vitest-environment jsdom
//
// Paste + WebView-drop insert handlers (MYND-164, attachment-insert): the CM6
// domEventHandlers that hijack a file paste / file drop into the shared
// import→form-C-embed pipeline, and `importAndInsert` / `insertEmbedsForOutcomes`
// underneath. The import fn is overridden via `setImportFn`; the toast is mocked.
// These exercise the real branch logic: text-only paste/drop falls through
// (handler returns false), file paste/drop is consumed (true), multi-file embeds
// are newline-joined in order, all-failure inserts nothing, and the insert
// anchor is clamped to the live doc length.

import { afterEach, describe, expect, it, vi } from "vitest";

const showAttachmentToast = vi.fn();
const dismissAttachmentToast = vi.fn();
vi.mock("../../src/editor/attachments/toast", () => ({
  showAttachmentToast: (...a: unknown[]) => showAttachmentToast(...a),
  dismissAttachmentToast: (...a: unknown[]) => dismissAttachmentToast(...a),
}));

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  type ImportSource,
  type ImportedAttachment,
  setImportFn,
} from "../../src/editor/attachments/insert";
import {
  attachmentPasteDropExtension,
  importAndInsert,
  insertEmbedsForOutcomes,
} from "../../src/editor/attachments/paste-drop";
import { setCatalogLoader } from "../../src/editor/attachments/catalog";

const ID_A = "a".repeat(64);
const ID_B = "b".repeat(64);

function imported(id: string, filename: string): ImportedAttachment {
  return { id, content_type: "image/png", filename, size: 4, created_at: 0, deduplicated: false };
}

const restores: Array<() => void> = [];

function mount(doc = ""): EditorView {
  restores.push(setCatalogLoader(() => new Promise<never>(() => {})));
  const host = document.createElement("div");
  document.body.appendChild(host);
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length, head: doc.length },
      extensions: [attachmentPasteDropExtension()],
    }),
    parent: host,
  });
}

/** A fake clipboard/datatransfer items list with one file item. */
function fileItem(file: File): DataTransferItem {
  return { kind: "file", getAsFile: () => file } as unknown as DataTransferItem;
}
function stringItem(): DataTransferItem {
  return { kind: "string", getAsFile: () => null } as unknown as DataTransferItem;
}

/** A fake DataTransfer that also satisfies CM6's own built-in paste/drop
 *  handler (which reads `getData` / `types` after ours runs). */
function fakeDataTransfer(
  partial: { items?: DataTransferItem[]; files?: File[] },
): DataTransfer {
  return {
    items: partial.items ?? [],
    files: (partial.files ?? []) as unknown as FileList,
    types: [],
    getData: () => "",
  } as unknown as DataTransfer;
}

afterEach(() => {
  restores.splice(0).forEach((r) => r());
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("insertEmbedsForOutcomes", () => {
  it("inserts one form-C embed per success, newline-joined in order, in one undo step", () => {
    const view = mount("seed");
    const before = view.state.doc.length;
    insertEmbedsForOutcomes(
      view,
      [
        { ok: true, attachment: imported(ID_A, "one.png") },
        { ok: false, reason: "too-large" },
        { ok: true, attachment: imported(ID_B, "two.png") },
      ],
      before,
    );
    expect(view.state.doc.toString()).toBe(
      `seed![[att:${ID_A}|one.png]]\n![[att:${ID_B}|two.png]]`,
    );
    view.destroy();
  });

  it("inserts nothing when no import succeeded", () => {
    const view = mount("keep");
    insertEmbedsForOutcomes(view, [{ ok: false, reason: "unsupported" }], 4);
    expect(view.state.doc.toString()).toBe("keep");
    view.destroy();
  });

  it("clamps the insert anchor past the live doc length (async round-trip outlived an edit)", () => {
    const view = mount("ab");
    // insertAt is past the end; it must clamp, never throw an out-of-range pos.
    insertEmbedsForOutcomes(view, [{ ok: true, attachment: imported(ID_A, "x.png") }], 999);
    expect(view.state.doc.toString()).toBe(`ab![[att:${ID_A}|x.png]]`);
    view.destroy();
  });
});

describe("importAndInsert", () => {
  it("imports all pending, inserts embeds in order, and surfaces a partial-success toast", async () => {
    restores.push(
      setImportFn(async (s: ImportSource) => {
        const name = s.kind === "bytes" ? s.filename ?? "x" : "x";
        if (name === "bad.png") throw { kind: "UnsupportedType" };
        return imported(ID_A, name);
      }),
    );
    const view = mount("");
    const outcomes = await importAndInsert(
      view,
      [
        // `PendingFile` carries the import SOURCE since task 67 — the byte
        // shape is one of two, and the host decides which (a browser hands its
        // Worker the `File` instead of reading it on the page).
        { source: { kind: "bytes", bytes: [1], filename: "good.png" }, filename: "good.png" },
        { source: { kind: "bytes", bytes: [2], filename: "bad.png" }, filename: "bad.png" },
      ],
      0,
    );
    expect(outcomes.map((o) => o.ok)).toEqual([true, false]);
    expect(view.state.doc.toString()).toBe(`![[att:${ID_A}|good.png]]`);
    // A mixed batch produces a "1 added · 1 skipped: …" toast.
    expect(showAttachmentToast).toHaveBeenCalledWith("1 added · 1 skipped: unsupported type");
    view.destroy();
  });

  it("stays silent (no toast) for a single clean success — the embed is the feedback", async () => {
    restores.push(setImportFn(async () => imported(ID_A, "one.png")));
    const view = mount("");
    await importAndInsert(
      view,
      [{ source: { kind: "bytes", bytes: [1], filename: "one.png" }, filename: "one.png" }],
      0,
    );
    expect(showAttachmentToast).not.toHaveBeenCalled();
    view.destroy();
  });

  it("shows the compression notice (story 4) for a single compressed import", async () => {
    restores.push(
      setImportFn(async () => ({
        ...imported(ID_A, "shot.webp"),
        content_type: "image/webp",
        size: 300,
        original_size: 2400,
        container_changed: true,
      })),
    );
    const view = mount("");
    await importAndInsert(
      view,
      [{ source: { kind: "bytes", bytes: [1], filename: "shot.png" }, filename: "shot.png" }],
      0,
    );
    // A single clean success is otherwise silent — the notice is the ONE
    // exception, and it must mention the container swap.
    expect(showAttachmentToast).toHaveBeenCalledTimes(1);
    expect(showAttachmentToast).toHaveBeenCalledWith("Compressed to WebP: 2.3 KiB → 300 B");
    view.destroy();
  });

  it("stays silent when compression made no improvement (no `original_size`)", async () => {
    restores.push(setImportFn(async () => imported(ID_A, "unchanged.png")));
    const view = mount("");
    await importAndInsert(
      view,
      [{ source: { kind: "bytes", bytes: [1], filename: "unchanged.png" }, filename: "x" }],
      0,
    );
    expect(showAttachmentToast).not.toHaveBeenCalled();
    view.destroy();
  });
});

// Flush the import→insert async chain (arrayBuffer read + importMany + dispatch).
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("paste handler (domEventHandlers)", () => {
  function firePaste(view: EditorView, clipboardData: DataTransfer | null): void {
    const ev = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(ev, "clipboardData", { value: clipboardData, configurable: true });
    view.contentDOM.dispatchEvent(ev);
  }

  it("does not import for a text-only paste — normal text paste is left untouched", async () => {
    const imp = vi.fn(async () => imported(ID_A, "x.png"));
    restores.push(setImportFn(imp));
    const view = mount("");
    firePaste(view, fakeDataTransfer({ items: [stringItem()] }));
    await flush();
    expect(imp).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("");
    view.destroy();
  });

  it("does not import when there is no clipboardData at all", async () => {
    const imp = vi.fn(async () => imported(ID_A, "x.png"));
    restores.push(setImportFn(imp));
    const view = mount("");
    firePaste(view, null);
    await flush();
    expect(imp).not.toHaveBeenCalled();
    view.destroy();
  });

  it("imports a pasted file item and inserts its form-C embed", async () => {
    let importCalls = 0;
    restores.push(
      setImportFn(async () => {
        importCalls++;
        return imported(ID_A, "pasted.png");
      }),
    );
    const view = mount("");
    const file = new File([new Uint8Array([1, 2, 3])], "pasted.png", { type: "image/png" });
    firePaste(view, fakeDataTransfer({ items: [fileItem(file)], files: [file] }));
    await flush();
    expect(importCalls).toBe(1);
    expect(view.state.doc.toString()).toBe(`![[att:${ID_A}|pasted.png]]`);
    view.destroy();
  });
});

describe("drop handler (domEventHandlers)", () => {
  function fireDrop(view: EditorView, dataTransfer: DataTransfer | null): void {
    const ev = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(ev, "dataTransfer", { value: dataTransfer, configurable: true });
    Object.defineProperty(ev, "clientX", { value: 0, configurable: true });
    Object.defineProperty(ev, "clientY", { value: 0, configurable: true });
    view.contentDOM.dispatchEvent(ev);
  }

  it("does not import for a drop with no files (dragged text / sidebar note-reorder)", async () => {
    const imp = vi.fn(async () => imported(ID_B, "x.png"));
    restores.push(setImportFn(imp));
    const view = mount("");
    fireDrop(view, fakeDataTransfer({ files: [] }));
    await flush();
    expect(imp).not.toHaveBeenCalled();
    view.destroy();
  });

  it("does not import when there is no dataTransfer", async () => {
    const imp = vi.fn(async () => imported(ID_B, "x.png"));
    restores.push(setImportFn(imp));
    const view = mount("");
    fireDrop(view, null);
    await flush();
    expect(imp).not.toHaveBeenCalled();
    view.destroy();
  });

  it("imports a dropped file and inserts its embed at the cursor", async () => {
    restores.push(setImportFn(async () => imported(ID_B, "dropped.png")));
    const view = mount("");
    const file = new File([new Uint8Array([9])], "dropped.png", { type: "image/png" });
    fireDrop(view, fakeDataTransfer({ files: [file] }));
    await flush();
    expect(view.state.doc.toString()).toBe(`![[att:${ID_B}|dropped.png]]`);
    view.destroy();
  });
});
