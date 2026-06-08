// @vitest-environment jsdom
//
// File-picker insert + the import-&-convert picker-backed importer fallback
// (epic MYND-164, sub-feature attachment-insert; decisions 4 + 5).
//
// `@tauri-apps/plugin-dialog` / `plugin-fs` are mocked at the module level so
// the picker + fallback wiring is exercised without a Tauri runtime.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Tauri dialog before importing the modules under test.
const openMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...a: unknown[]) => openMock(...a) }));

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  type ImportedAttachment,
  type ImportSource,
  setImportFn,
} from "../../src/editor/attachments/insert";
import { pickAndInsert, setPickerFn } from "../../src/editor/attachments/picker";
import { pickerBackedImporter, setPickOneFn } from "../../src/editor/attachments/convert-command";
import { dismissAttachmentToast } from "../../src/editor/attachments/toast";

const ID = "d".repeat(64);

function imported(filename: string): ImportedAttachment {
  return {
    id: ID,
    content_type: "image/png",
    filename,
    size: 1,
    created_at: 0,
    deduplicated: false,
  };
}

function mount(doc = ""): EditorView {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return new EditorView({
    state: EditorState.create({ doc, selection: { anchor: doc.length, head: doc.length } }),
    parent: host,
  });
}

const restores: Array<() => void> = [];
afterEach(() => {
  restores.splice(0).forEach((r) => r());
  dismissAttachmentToast();
  vi.clearAllMocks();
});

describe("pickAndInsert (/attach picker)", () => {
  it("inserts a form-C embed per picked path, in order", async () => {
    restores.push(
      setPickerFn(async () => ["/abs/one.png", "/abs/two.png"]),
      setImportFn(async (s: ImportSource) => {
        const name = s.kind === "path" ? s.path.split("/").pop()! : "x";
        return imported(name);
      }),
    );
    const view = mount("");
    await pickAndInsert(view);
    expect(view.state.doc.toString()).toBe(
      `![[att:${ID}|one.png]]\n![[att:${ID}|two.png]]`,
    );
    view.destroy();
  });

  it("is a silent no-op when the picker is cancelled (null)", async () => {
    restores.push(setPickerFn(async () => null));
    const view = mount("keep");
    await pickAndInsert(view);
    expect(view.state.doc.toString()).toBe("keep");
    view.destroy();
  });

  it("skips an invalid file and still inserts the valid one (partial success)", async () => {
    restores.push(
      setPickerFn(async () => ["/abs/big.png", "/abs/ok.png"]),
      setImportFn(async (s: ImportSource) => {
        if (s.kind === "path" && s.path.includes("big")) {
          throw { kind: "Oversize", detail: { cap_bytes: 1 } };
        }
        return imported("ok.png");
      }),
    );
    const view = mount("");
    await pickAndInsert(view);
    expect(view.state.doc.toString()).toBe(`![[att:${ID}|ok.png]]`);
    view.destroy();
  });
});

describe("pickerBackedImporter (auto-resolve → picker fallback)", () => {
  const ref = {
    kind: "wikilink-embed" as const,
    from: 0,
    to: 10,
    raw: "![[a.png]]",
    source: "a.png",
    alias: null,
  };

  it("auto-resolves the literal path when the host can read it", async () => {
    let importedPaths: string[] = [];
    restores.push(
      setImportFn(async (s: ImportSource) => {
        if (s.kind === "path") importedPaths.push(s.path);
        return imported("a.png");
      }),
    );
    const result = await pickerBackedImporter(ref);
    expect(result.ok).toBe(true);
    expect(importedPaths).toEqual(["a.png"]); // literal path, no picker
  });

  it("falls back to the picker when the literal path can't be read (Io)", async () => {
    const pickOne = vi.fn(async () => "/chosen/a.png");
    restores.push(
      setPickOneFn(pickOne),
      setImportFn(async (s: ImportSource) => {
        if (s.kind === "path" && s.path === "a.png") {
          throw { kind: "Io", detail: { io_error_kind: "NotFound" } };
        }
        return imported("a.png");
      }),
    );
    const result = await pickerBackedImporter(ref);
    expect(pickOne).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
  });

  it("reports skipped (not picker) when the file is found but unsupported", async () => {
    const pickOne = vi.fn(async () => "/chosen/a.png");
    restores.push(
      setPickOneFn(pickOne),
      setImportFn(async () => {
        throw { kind: "UnsupportedType" };
      }),
    );
    const result = await pickerBackedImporter(ref);
    // Found but not importable → do NOT re-prompt; report it.
    expect(pickOne).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, note: "unsupported type" });
  });

  it("reports 'source not found' when the picker fallback is cancelled", async () => {
    restores.push(
      setPickOneFn(async () => null),
      setImportFn(async () => {
        throw { kind: "Io", detail: { io_error_kind: "NotFound" } };
      }),
    );
    const result = await pickerBackedImporter(ref);
    expect(result).toEqual({ ok: false, note: "source not found" });
  });
});

// Keep the dialog mock referenced so the import isn't tree-shaken in strict
// builds; openMock is unused directly because the seams override the calls.
beforeEach(() => {
  void openMock;
});
