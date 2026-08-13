import { describe, it, expect } from "vitest";
import tauriConf from "../src-tauri/tauri.conf.json";

// Regression guard for the mobile CSP (mobile/src-tauri/tauri.conf.json).
//
// The Files-tab PDF preview loads the decrypted bytes via `fetch("attachment://…")`
// (editor/src/attachments/pdf-render.ts), which is governed by CSP `connect-src`;
// the pdf.js worker needs `worker-src`. If a future edit drops either, PDF preview
// silently fails-closed to the generic icon — exactly the bug fixed in
// design-notes.md 2026-07-12 "Mobile attachment preview parity". The packaged
// WebView is the only place the CSP is actually enforced, so the flow tier
// (mock IPC, Vite dev server, no `attachment://`) cannot catch a regression here;
// this asserts the config string directly, which is the only automated net.

const directives = new Map<string, string>();
for (const part of tauriConf.app.security.csp.split(";")) {
  const trimmed = part.trim();
  if (trimmed === "") continue;
  directives.set(trimmed.split(/\s+/)[0], trimmed);
}

describe("mobile CSP", () => {
  it("allows the attachment: scheme for connect-src (pdf.js byte fetch)", () => {
    expect(directives.get("connect-src")).toContain("attachment:");
  });

  it("allows blob: workers for worker-src (pdf.js worker)", () => {
    expect(directives.get("worker-src")).toContain("blob:");
  });

  it("keeps attachment: on img-src + media-src (image + audio preview)", () => {
    expect(directives.get("img-src")).toContain("attachment:");
    expect(directives.get("media-src")).toContain("attachment:");
  });

  it("lists http://attachment.localhost wherever attachment: appears (MYND-519)", () => {
    // Android WebView cannot intercept custom schemes — Tauri serves the
    // attachment protocol there as `http://attachment.localhost/<id>` (the
    // form `convertFileSrc` emits), a DIFFERENT origin from the app, so the
    // scheme-source `attachment:` alone does not cover it. Dropping any of
    // these re-breaks Android attachment render (images/audio) and PDF
    // preview (pdf.js byte fetch).
    expect(directives.get("img-src")).toContain("http://attachment.localhost");
    expect(directives.get("media-src")).toContain("http://attachment.localhost");
    expect(directives.get("connect-src")).toContain("http://attachment.localhost");
  });

  it("leaves the defense-in-depth XSS directives intact", () => {
    expect(directives.get("default-src")).toBe("default-src 'self'");
    expect(directives.get("object-src")).toBe("object-src 'none'");
    expect(directives.get("script-src")).toContain("'self'");
    // script-src must NOT gain 'unsafe-inline' — the primary XSS control is here.
    expect(directives.get("script-src")).not.toContain("'unsafe-inline'");
  });

  it("does not cargo-cult desktop-only origins that mobile IPC never uses", () => {
    // Mobile IPC routes through the WKWebView/Android bridge, not a CSP-gated
    // fetch, so `ipc:`/`http://ipc.localhost` are deliberately absent (decisions
    // 2026-07-12). frame-src is unneeded — the PDF reader is canvas-based.
    expect(directives.get("connect-src")).not.toContain("ipc:");
    expect(directives.has("frame-src")).toBe(false);
  });
});
