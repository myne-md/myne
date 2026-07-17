// Platform-aware attachment URL builders (MYND-519).
//
// `attachmentUrl` delegates to Tauri's `convertFileSrc` at CALL time when
// running inside Tauri — Android WebView and Windows WebView2 cannot
// intercept custom schemes, so the servable form there is
// `http://attachment.localhost/<id>` (macOS/Linux/iOS emit
// `attachment://localhost/<id>`; the Rust `extract_id` accepts every form).
// Outside Tauri (vitest, plain-browser dev) it falls back to the literal
// `attachment://<id>`.
//
// `canonicalAttachmentUrl` is ALWAYS the literal form — the standalone
// HTML-export projection contract: the Rust sidecar rewriter
// (`desktop_commands.rs::html_referenced_attachment_ids`) scans for exactly
// that shape, and exports must not vary by the platform they were written on.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachmentUrl,
  canonicalAttachmentUrl,
} from "../../src/notes/attachmentRef";

const HEX = "ab".repeat(32);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("attachmentUrl (platform-aware, MYND-519)", () => {
  it("falls back to the canonical literal outside Tauri", () => {
    expect(attachmentUrl(HEX)).toBe(`attachment://${HEX}`);
  });

  it("delegates to convertFileSrc inside Tauri (per-platform serving form)", () => {
    vi.stubGlobal("window", {
      __TAURI_INTERNALS__: {
        convertFileSrc: (path: string, protocol: string) =>
          `http://${protocol}.localhost/${path}`,
      },
    });
    expect(attachmentUrl(HEX)).toBe(`http://attachment.localhost/${HEX}`);
  });
});

describe("canonicalAttachmentUrl (export-projection contract)", () => {
  it("stays the literal attachment://<id> form even inside Tauri", () => {
    vi.stubGlobal("window", {
      __TAURI_INTERNALS__: {
        convertFileSrc: () => "http://attachment.localhost/never-this",
      },
    });
    expect(canonicalAttachmentUrl(HEX)).toBe(`attachment://${HEX}`);
  });
});
