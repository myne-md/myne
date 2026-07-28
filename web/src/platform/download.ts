// Web implementation of the download seam (phase3-web-client task 48).
//
// The browser's own download flow: an object URL, a synthetic `<a download>`,
// and an immediate revoke. That is the whole mechanism, and its shape is what
// preserves `threat-model.md` TB3's two export properties:
//
//   - **user-initiated** — the browser's download UI is a second confirmation on
//     top of the export action the user clicked. A page cannot write anywhere
//     the user did not accept, and cannot start this without a gesture in the
//     chain.
//   - **one-shot** — the URL is revoked in the same turn. Nothing is retained:
//     no handle that could deliver again, and no `Blob` pinning plaintext for
//     the life of the page (an object URL is a GC root, so an unrevoked one
//     would do exactly that — the lesson task 44 paid for).
//
// # Why not `showSaveFilePicker`
//
// The File System Access API would give a real handle and a real overwrite
// prompt, which is closer to the desktop affordance. It is **Chromium-only** —
// Firefox and Safari implement neither `showSaveFilePicker` nor
// `showDirectoryPicker` — and this client targets all four desktop browsers
// (`prd.md` §1). Building the export on it would make export a per-browser
// capability inside the web client, which is a worse shape than a mechanism that
// works everywhere. Revisit if the API lands broadly; nothing here forecloses it.

/** Deliver `bytes` to the user as a download named `suggestedName`. */
export async function deliverFile(
  suggestedName: string,
  bytes: Uint8Array,
  mimeType: string,
): Promise<void> {
  // Copied explicitly, for the reason task 44 measured: under cross-origin
  // isolation (which this client requires for the sync backoff's
  // `Atomics.wait`) a `Uint8Array` may be backed by a `SharedArrayBuffer`, and
  // `BlobPart` does not accept one. `slice()` always yields an
  // `ArrayBuffer`-backed copy.
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: mimeType }));
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = suggestedName;
    // Not appended to the document: a detached anchor's `click()` starts the
    // download in every target browser, and appending would put a hidden
    // element in the tree that a later render could trip over.
    a.click();
  } finally {
    // Revoked immediately rather than on a timer. The browser has already taken
    // its own reference by the time `click()` returns, so the download completes;
    // what revoking ends is THIS page's handle on the decrypted bytes.
    URL.revokeObjectURL(url);
  }
}
