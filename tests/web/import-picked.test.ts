// @vitest-environment jsdom
//
// `importPicked` on web — where the attachment bytes actually go
// (phase3-web-client task 67).
//
// The failure this prevents is not a wrong result, it is a wrong RESOURCE
// PROFILE. Reading the file here and sending the shared
// `{ kind: "bytes", bytes: number[] }` payload works perfectly in a test and in
// a demo with a 40 KB screenshot, and turns a 64 MiB import — the documented
// cap, i.e. a size the product promises — into a 64-million-element JS array
// that is structured-cloned and then `JSON.stringify`d on the main thread.
//
// So these assertions are about mechanism: the `File` handle crosses to the
// Worker, the page never reads it, and the JSON that travels alongside carries
// the display name and nothing else.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeWithFile = vi.fn(async () => ({ id: "a".repeat(64) }));
const invoke = vi.fn(async () => null);
vi.mock("../../web/src/worker/host", () => ({
  invokeWithFile: (...a: unknown[]) => invokeWithFile(...(a as [])),
  invoke: (...a: unknown[]) => invoke(...(a as [])),
  subscribe: () => () => {},
  workerFatal: () => null,
}));

const { importPicked, pickedFromDropped, pickedFromFile } = await import(
  "../../web/src/platform/filePicker"
);

beforeEach(() => {
  invokeWithFile.mockClear();
  invoke.mockClear();
});

describe("importPicked", () => {
  it("sends the File itself and never reads it here", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
    const arrayBuffer = vi.spyOn(file, "arrayBuffer");

    await importPicked(pickedFromFile(file));

    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    const [cmd, args, sent] = invokeWithFile.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      File,
    ];
    expect(cmd).toBe("plugin:attachments|attachment_import");
    expect(sent).toBe(file);
    // The JSON carries the display label and NOTHING else — no bytes, and no
    // claimed MIME: the content type is re-sniffed from the actual bytes
    // host-side, and a browser's `File.type` is attacker-influenced input
    // (`protocol.md` §9.9).
    expect(args).toEqual({ filename: "shot.png" });
  });

  it("carries the editor's auto-generated name for a nameless paste", async () => {
    const file = new File([new Uint8Array([1])], "", { type: "image/png" });
    const picked = pickedFromDropped(file, "pasted-image-2026-07-27.png")!;

    await importPicked(picked);

    const [, args] = invokeWithFile.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(args).toEqual({ filename: "pasted-image-2026-07-27.png" });
  });

  it("keeps the File's own name when there is no override", () => {
    const file = new File([new Uint8Array([1])], "diagram.svg", { type: "image/svg+xml" });
    expect(pickedFromDropped(file)!.name).toBe("diagram.svg");
    expect(pickedFromDropped(file, "")!.name).toBe("diagram.svg");
  });

  it("refuses a handle it did not mint, loudly", async () => {
    // A foreign handle means two hosts are installed at once — a startup bug.
    // Surfacing it as itself beats presenting it as a failed import of a file
    // that is perfectly fine.
    await expect(
      importPicked({ name: "x.png", size: null, mimeHint: null, handle: { kind: "path", path: "/x" } }),
    ).rejects.toThrow(/not minted by this host/);
    expect(invokeWithFile).not.toHaveBeenCalled();
  });
});
