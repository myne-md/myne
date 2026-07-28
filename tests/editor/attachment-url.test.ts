// Attachment URL builders — the host-delegating one and the export-projection
// constant (MYND-519; re-pointed by phase3-web-client task 76).
//
// `attachmentUrl` used to call Tauri's `convertFileSrc` itself, feature-detecting
// `window.__TAURI_INTERNALS__` to decide whether it was inside Tauri. Task 76
// moved that decision to the host: `@myne/editor` is compiled by a client that
// is not Tauri at all, and a module-scope `@tauri-apps/*` import lands in the
// bundle whether or not the call fires. So what is under test here changed
// shape — the per-platform serving form is now `src/editor-host.ts`'s business
// (it is the only thing that knows which client it is), and this file asserts
// the two properties that stayed in the package:
//
//   1. it asks the HOST, verbatim — no rewriting, no scheme assumptions;
//   2. with no host installed it degrades to the canonical literal rather than
//      throwing, because a missing image beats a crashed render.
//
// `canonicalAttachmentUrl` is unchanged and unconditional: it is the standalone
// HTML-export projection contract, and the Rust sidecar rewriter
// (`desktop_commands.rs::html_referenced_attachment_ids`) scans for exactly that
// shape, so an export must not vary by the platform that wrote it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { setEditorHost, getHost, type EditorHost } from "@myne/editor/host";
import { attachmentUrl, canonicalAttachmentUrl } from "../../src/notes/attachmentRef";

const HEX = "ab".repeat(32);

/** Swap `attachments.resolveRef` on the globally-installed test host, returning
 *  a restore fn. Keeps every other member intact so nothing else shifts. */
function withResolveRef(fn: (id: string) => string): () => void {
  const host = getHost();
  const patched: EditorHost = {
    ...host,
    attachments: { ...host.attachments, resolveRef: fn },
  };
  setEditorHost(patched);
  return () => setEditorHost(host);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("attachmentUrl (host-delegating, MYND-519 / task 76)", () => {
  it("returns the host's answer verbatim", () => {
    // The per-platform form a WebView that cannot intercept a custom scheme
    // needs (Android, Windows WebView2) — proving nothing here rewrites it.
    const restore = withResolveRef((id) => `http://attachment.localhost/${id}`);
    try {
      expect(attachmentUrl(HEX)).toBe(`http://attachment.localhost/${HEX}`);
    } finally {
      restore();
    }
  });

  it("passes the id through untouched", () => {
    const seen: string[] = [];
    const restore = withResolveRef((id) => {
      seen.push(id);
      return "x";
    });
    try {
      attachmentUrl(HEX);
      expect(seen).toEqual([HEX]);
    } finally {
      restore();
    }
  });

  it("accepts an object URL — the browser's answer, which has no scheme in common with the desktop's", () => {
    const restore = withResolveRef(() => "blob:http://localhost:1421/9f2c-…");
    try {
      expect(attachmentUrl(HEX)).toBe("blob:http://localhost:1421/9f2c-…");
    } finally {
      restore();
    }
  });

  it("falls back to the canonical literal when a host throws rather than taking the render down", () => {
    const restore = withResolveRef(() => {
      throw new Error("no host");
    });
    try {
      expect(attachmentUrl(HEX)).toBe(`attachment://${HEX}`);
    } finally {
      restore();
    }
  });
});

describe("canonicalAttachmentUrl (export-projection contract)", () => {
  it("stays the literal attachment://<id> form whatever the host answers", () => {
    const restore = withResolveRef(() => "http://attachment.localhost/never-this");
    try {
      expect(canonicalAttachmentUrl(HEX)).toBe(`attachment://${HEX}`);
    } finally {
      restore();
    }
  });
});
