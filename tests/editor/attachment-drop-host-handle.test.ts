// @vitest-environment jsdom
//
// Drop / paste ingest when the HOST can move the file itself
// (phase3-web-client task 67).
//
// The editor used to read every dropped file into a `number[]` — one JS number
// per byte — before handing it to the host. On desktop that is merely wasteful
// (the picker path avoids it entirely; Rust opens the path). In a browser the
// same array is structured-cloned to a Worker and `JSON.stringify`d on the way,
// so a 64 MiB attachment — the documented cap, i.e. a size the product says is
// fine — becomes a ~200 MB string on the main thread.
//
// So a host may now offer `pickedFromDropped`, take the `File` HANDLE, and read
// the content wherever it likes. These tests pin the branch both ways, because
// the desktop half is a criterion of its own: "desktop OS-drop path unaffected".

import { afterEach, describe, expect, it, vi } from "vitest";

const showAttachmentToast = vi.fn();
vi.mock("../../src/editor/attachments/toast", () => ({
  showAttachmentToast: (...a: unknown[]) => showAttachmentToast(...a),
  dismissAttachmentToast: vi.fn(),
}));

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  setEditorHost,
  getHost,
  type EditorHost,
  type PickedFile,
} from "@myne/editor/host";
import {
  type ImportSource,
  type ImportedAttachment,
  setImportFn,
} from "../../src/editor/attachments/insert";
import { attachmentPasteDropExtension } from "../../src/editor/attachments/paste-drop";
import { setCatalogLoader } from "../../src/editor/attachments/catalog";

const ID = "c".repeat(64);
const restores: Array<() => void> = [];

function imported(filename: string): ImportedAttachment {
  return {
    id: ID,
    content_type: "image/png",
    filename,
    size: 4,
    created_at: 0,
    deduplicated: false,
  };
}

/** Install `pickedFromDropped` on the global test host for one test. */
function withDroppedMint(
  fn: ((file: File, nameOverride?: string) => PickedFile | null) | undefined,
): () => void {
  const host = getHost();
  const patched: EditorHost = {
    ...host,
    attachments: { ...host.attachments, pickedFromDropped: fn },
  };
  setEditorHost(patched);
  return () => setEditorHost(host);
}

function mount(): EditorView {
  restores.push(setCatalogLoader(() => new Promise<never>(() => {})));
  const host = document.createElement("div");
  document.body.appendChild(host);
  return new EditorView({
    state: EditorState.create({ extensions: [attachmentPasteDropExtension()] }),
    parent: host,
  });
}

function fakeDataTransfer(files: File[]): DataTransfer {
  return {
    items: files.map((f) => ({ kind: "file", getAsFile: () => f })),
    files: files as unknown as FileList,
    types: [],
    getData: () => "",
  } as unknown as DataTransfer;
}

/** Record every source the import saw, and settle. */
function recordSources(): { seen: ImportSource[] } {
  const seen: ImportSource[] = [];
  restores.push(
    setImportFn(async (s: ImportSource) => {
      seen.push(s);
      return imported(s.kind === "bytes" ? s.filename ?? "x" : s.file.name);
    }),
  );
  return { seen };
}

/** Let the handler's floating promise chain settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  restores.splice(0).forEach((r) => r());
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("a host that can take the File handle", () => {
  it("never reads the bytes on this thread", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
    // If the editor read the content, this spy would fire. It is the whole
    // assertion: the page must not allocate the file.
    const arrayBuffer = vi.spyOn(file, "arrayBuffer");
    restores.push(
      withDroppedMint((f) => ({ name: f.name, size: f.size, mimeHint: f.type, handle: { f } })),
    );
    const { seen } = recordSources();

    const view = mount();
    view.contentDOM.dispatchEvent(
      Object.assign(new Event("drop", { bubbles: true, cancelable: true }), {
        dataTransfer: fakeDataTransfer([file]),
        clientX: 0,
        clientY: 0,
      }),
    );
    await settle();

    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.kind).toBe("picked");
    view.destroy();
  });

  it("relays the auto-generated name for a pasted screenshot", async () => {
    // A pasted screenshot's `File.name` is empty. The naming convention belongs
    // to the editor, so the host only carries it — a host that invented its own
    // would name the same paste differently on each platform.
    const file = new File([new Uint8Array([1])], "", { type: "image/png" });
    let relayed: string | undefined;
    restores.push(
      withDroppedMint((f, nameOverride) => {
        relayed = nameOverride;
        return { name: nameOverride ?? f.name, size: f.size, mimeHint: f.type, handle: { f } };
      }),
    );
    recordSources();

    const view = mount();
    view.contentDOM.dispatchEvent(
      Object.assign(new Event("paste", { bubbles: true, cancelable: true }), {
        clipboardData: fakeDataTransfer([file]),
      }),
    );
    await settle();

    expect(relayed).toMatch(/\.png$/);
    expect(relayed).not.toBe("");
    view.destroy();
  });

  it("falls back to the byte path when the host declines this file", async () => {
    // `null` means "I have no handle for this one" — the import must still
    // happen rather than being silently dropped.
    const file = new File([new Uint8Array([7, 8])], "x.png", { type: "image/png" });
    restores.push(withDroppedMint(() => null));
    const { seen } = recordSources();

    const view = mount();
    view.contentDOM.dispatchEvent(
      Object.assign(new Event("drop", { bubbles: true, cancelable: true }), {
        dataTransfer: fakeDataTransfer([file]),
        clientX: 0,
        clientY: 0,
      }),
    );
    await settle();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ kind: "bytes", bytes: [7, 8], filename: "x.png" });
    view.destroy();
  });
});

describe("a host that cannot — the desktop shape", () => {
  it("still sends bytes, exactly as before", async () => {
    // The criterion "desktop OS-drop path unaffected", as a test: with the
    // member absent the editor takes the same branch it always took.
    const file = new File([new Uint8Array([4, 5, 6])], "pic.png", { type: "image/png" });
    restores.push(withDroppedMint(undefined));
    const { seen } = recordSources();

    const view = mount();
    view.contentDOM.dispatchEvent(
      Object.assign(new Event("drop", { bubbles: true, cancelable: true }), {
        dataTransfer: fakeDataTransfer([file]),
        clientX: 0,
        clientY: 0,
      }),
    );
    await settle();

    expect(seen).toEqual([{ kind: "bytes", bytes: [4, 5, 6], filename: "pic.png" }]);
    view.destroy();
  });
});
