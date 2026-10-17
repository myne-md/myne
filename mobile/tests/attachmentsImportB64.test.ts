// The mobile file picker's IPC shape, pinned.
//
// `importFile` used to hand the host one JS number per byte (`Array.from`), so a
// 5 MiB file asked the WebView for ~40 MiB of transient heap before a byte left
// the page, and a file at the 64 MiB cap asked for hundreds of MB. It now sends
// STANDARD base64 as a `String`, which is what Tauri's own IPC documentation
// recommends for this case.
//
// The alternative that reads as the obvious fix — Tauri's raw request body — is
// deliberately NOT used, and the reason belongs in a test rather than only in a
// comment: Tauri's `InvokeBody` documentation states that **on Android
// `InvokeBody::Raw` is not supported and the enum always contains `Json`**. A raw
// body would therefore fail every import on Android, the one mobile platform with
// no automated UI coverage in this repository, while passing on iOS.
//
// Two cases, and the second is the one that keeps the first honest: a
// chunk-less encoder (`String.fromCharCode(...bytes)`) passes the small case and
// throws a `RangeError` on the large one.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("../src/platform/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { importFile } from "../src/lib/attachments";

/** The `source` arg of the first (only) `attachment_import` call. */
interface SentSource {
  kind: string;
  bytes?: number[];
  bytes_b64?: string;
  filename: string | null;
}

function sentSource(): SentSource {
  const call = invoke.mock.calls[0] as [string, { source: SentSource }] | undefined;
  if (call === undefined) throw new Error("no attachment_import call was made");
  expect(call[0]).toBe("plugin:attachments|attachment_import");
  return call[1].source;
}

/** A stand-in for a picked `File`: `importFile` reads exactly these two members,
 *  and jsdom's `Blob#arrayBuffer` is not something this case should depend on. */
function pickedFile(name: string, bytes: Uint8Array): File {
  return {
    name,
    arrayBuffer: async () => bytes.buffer as ArrayBuffer,
  } as unknown as File;
}

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({
    id: "a".repeat(64),
    content_type: "image/png",
    filename: "x.png",
    size: 1,
    created_at: 1,
    deduplicated: false,
  });
});

describe("importFile", () => {
  it("sends the bytes as base64, never as an array of numbers", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
    await importFile(pickedFile("şekil.png", bytes));

    const source = sentSource();
    expect(source.kind).toBe("bytes_b64");
    expect(source.bytes).toBeUndefined();
    // The display name survives non-ASCII, which is the whole reason the payload
    // is an encoded STRING rather than a header.
    expect(source.filename).toBe("şekil.png");
    // And the encoding is lossless in both directions, byte for byte.
    expect(source.bytes_b64).toBe(btoa(String.fromCharCode(...bytes)));
    expect([...decodeBase64(source.bytes_b64 ?? "")]).toEqual([...bytes]);
  });

  it("encodes a payload far past the argument-spread limit", async () => {
    // 1 MiB. `String.fromCharCode(...bytes)` raises `RangeError: Maximum call
    // stack size exceeded` well before this, so the case is red for an encoder
    // that skipped the chunking rather than merely slow.
    const bytes = new Uint8Array(1 << 20).fill(0xab);
    await importFile(pickedFile("buyuk.bin", bytes));

    const decoded = decodeBase64(sentSource().bytes_b64 ?? "");
    expect(decoded.length).toBe(bytes.length);
    expect(decoded[0]).toBe(0xab);
    expect(decoded[decoded.length - 1]).toBe(0xab);
  });
});
