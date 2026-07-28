// The opaque picked-file handle, from both sides (phase3-web-client task 76).
//
// # Why this is its own file rather than a `seam-contract.ts` subject
//
// `tests/platform/seam-contract.ts` drives both seam implementations against
// one behavioural contract, and every operation it models is TRANSPORT-backed:
// it programs "the thing underneath resolves X" and asserts what the seam did
// with it. The picker is not that shape. Desktop's goes through a native
// dialog; web's is a DOM `<input type="file">` that never touches `invoke` at
// all, so there is no shared transport to program.
//
// What the two arms DO share is the handle's contract, and that is what this
// file pins: each host mints handles only it can read, and a foreign one is a
// loud failure rather than a silent wrong answer. The shape itself is pinned
// separately, at compile time, by the whole-module assignment in
// `web/src/platform/conformance.ts`.
//
// # The bug this exists for
//
// `handle` is `unknown` on purpose — that opacity is what stops `@myne/editor`
// from ever seeing a path. The cost of opacity is that a wrong handle is not a
// type error, so it has to be a runtime one. Two hosts installed at once is a
// startup bug; unwrapping the wrong handle silently would present it as a failed
// import, at the point furthest from the cause.

import { describe, expect, it } from "vitest";
import { pickedFromPath, importSourceFor } from "../../src/lib/picked-file";
import { pickedFromFile, fileFor } from "../../web/src/platform/filePicker";

describe("desktop handle (path)", () => {
  it("round-trips into the IPC source the Rust side already takes", () => {
    // The wire is byte-unchanged by this task: `{ kind: "path", path }` is what
    // `plugin:attachments|attachment_import` received before the seam existed,
    // which is what keeps Rust doing the read inside its root-confined seam
    // instead of 64 MiB crossing IPC.
    const picked = pickedFromPath("/abs/dir/photo.png");
    expect(importSourceFor(picked)).toEqual({ kind: "path", path: "/abs/dir/photo.png" });
  });

  it("derives a display name from the final component, on both separators", () => {
    expect(pickedFromPath("/abs/dir/photo.png").name).toBe("photo.png");
    expect(pickedFromPath("C:\\Users\\me\\photo.png").name).toBe("photo.png");
  });

  it("leaves size and MIME unknown rather than probing for them", () => {
    // Learning either would take an extra `fs` capability for information
    // nothing needs: the cap is enforced host-side during import, and the
    // content type is always re-sniffed from the decrypted bytes (§9.9).
    const picked = pickedFromPath("/abs/photo.png");
    expect(picked.size).toBeNull();
    expect(picked.mimeHint).toBeNull();
  });

  it("rejects a handle it did not mint instead of guessing", () => {
    const foreign = pickedFromFile(new File([new Uint8Array([1])], "a.png", { type: "image/png" }));
    expect(() => importSourceFor(foreign)).toThrow(/not minted by this host/);
  });

  it("rejects a hand-built lookalike whose path is not a string", () => {
    const forged = { name: "x", size: null, mimeHint: null, handle: { kind: "path", path: 7 } };
    expect(() => importSourceFor(forged)).toThrow(/not minted by this host/);
  });
});

describe("web handle (File)", () => {
  it("carries the size and MIME a File already knows", () => {
    const picked = pickedFromFile(
      new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" }),
    );
    expect(picked.name).toBe("shot.png");
    expect(picked.size).toBe(3);
    expect(picked.mimeHint).toBe("image/png");
  });

  it("reports an empty File type as no hint at all, not as an empty string", () => {
    // `File.type` is `""` when the browser cannot guess. Passing that through
    // would look like a claim; `null` says there is none.
    expect(pickedFromFile(new File([], "unknown.bin")).mimeHint).toBeNull();
  });

  it("round-trips back to its File", () => {
    const file = new File([new Uint8Array([9])], "a.bin");
    expect(fileFor(pickedFromFile(file))).toBe(file);
  });

  it("returns null for a handle it did not mint", () => {
    // The web arm's unwrap is total rather than throwing: its caller streams
    // bytes and can fall through to a typed refusal, whereas the desktop arm
    // has an IPC payload to build and nothing sensible to put in it.
    expect(fileFor(pickedFromPath("/abs/photo.png"))).toBeNull();
  });
});
