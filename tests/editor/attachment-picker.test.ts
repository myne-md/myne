// @vitest-environment jsdom
//
// File-picker insert + the import-&-convert picker-backed importer fallback
// (epic MYND-164, sub-feature attachment-insert; decisions 4 + 5).
//
// The Tauri dialog mock is gone (phase3-web-client task 76): the picker reaches
// the host now, and the SHAPE it receives changed with it. A picked file is an
// opaque `PickedFile` — a name, an optional size, a MIME hint and a host-private
// `handle` — never a path string, because a browser picker produces a `File` and
// a path-shaped seam is one of the few things that compiles on web and fails at
// runtime. So these tests build handles the way a host would and assert that the
// package passes them straight through without inspecting them.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PickedFile } from "@myne/editor/host";
import { setEditorHost, getHost, type EditorHost } from "@myne/editor/host";

/** A picked file shaped like the desktop host's: the handle carries the path,
 *  and only the host ever looks inside it. */
function picked(path: string): PickedFile {
  return {
    name: path.split("/").pop() ?? path,
    size: null,
    mimeHint: null,
    handle: { kind: "path", path },
  };
}

/** The path inside a desktop-shaped handle — the unwrap `src/lib/picked-file.ts`
 *  does for real. Used here to assert WHICH file reached the import. */
function pathOf(file: PickedFile): string {
  return (file.handle as { path: string }).path;
}

/** Install `resolveLiteralSource` on the global test host for one test. */
function withLiteralSource(fn: ((source: string) => PickedFile | null) | undefined): () => void {
  const host = getHost();
  const patched: EditorHost = {
    ...host,
    attachments: { ...host.attachments, resolveLiteralSource: fn },
  };
  setEditorHost(patched);
  return () => setEditorHost(host);
}

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
  it("inserts a form-C embed per picked file, in order", async () => {
    restores.push(
      setPickerFn(async () => [picked("/abs/one.png"), picked("/abs/two.png")]),
      setImportFn(async (s: ImportSource) => {
        const name = s.kind === "picked" ? s.file.name : "x";
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
      setPickerFn(async () => [picked("/abs/big.png"), picked("/abs/ok.png")]),
      setImportFn(async (s: ImportSource) => {
        if (s.kind === "picked" && pathOf(s.file).includes("big")) {
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

  it("auto-resolves the literal source when the host can reach it", async () => {
    const importedPaths: string[] = [];
    restores.push(
      withLiteralSource((source) => picked(source)),
      setImportFn(async (s: ImportSource) => {
        if (s.kind === "picked") importedPaths.push(pathOf(s.file));
        return imported("a.png");
      }),
    );
    const result = await pickerBackedImporter(ref);
    expect(result.ok).toBe(true);
    expect(importedPaths).toEqual(["a.png"]); // literal source, no picker
  });

  it("goes straight to the picker on a host that cannot reach a named source", async () => {
    // The browser's answer: file access needs a user gesture, so a path in a
    // document is not openable. The fallback needs no web-specific branch — the
    // user-visible outcome is the same as a literal path that did not read.
    const pickOne = vi.fn(async () => picked("/chosen/a.png"));
    restores.push(
      withLiteralSource(() => null),
      setPickOneFn(pickOne),
      setImportFn(async () => imported("a.png")),
    );
    const result = await pickerBackedImporter(ref);
    expect(pickOne).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
  });

  it("goes straight to the picker on a host that omits the resolver entirely", async () => {
    const pickOne = vi.fn(async () => picked("/chosen/a.png"));
    restores.push(
      withLiteralSource(undefined),
      setPickOneFn(pickOne),
      setImportFn(async () => imported("a.png")),
    );
    const result = await pickerBackedImporter(ref);
    expect(pickOne).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
  });

  it("falls back to the picker when the literal source can't be read (Io)", async () => {
    const pickOne = vi.fn(async () => picked("/chosen/a.png"));
    restores.push(
      withLiteralSource((source) => picked(source)),
      setPickOneFn(pickOne),
      setImportFn(async (s: ImportSource) => {
        if (s.kind === "picked" && pathOf(s.file) === "a.png") {
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
    const pickOne = vi.fn(async () => picked("/chosen/a.png"));
    restores.push(
      withLiteralSource((source) => picked(source)),
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
      withLiteralSource((source) => picked(source)),
      setPickOneFn(async () => null),
      setImportFn(async () => {
        throw { kind: "Io", detail: { io_error_kind: "NotFound" } };
      }),
    );
    const result = await pickerBackedImporter(ref);
    expect(result).toEqual({ ok: false, note: "source not found" });
  });
});
