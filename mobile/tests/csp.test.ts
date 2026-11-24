import { describe, it, expect } from "vitest";
import { mobileCspDirectives } from "../../tests/lib/_desktopCsp";

// Regression guard for the mobile CSP (mobile/src-tauri/tauri.conf.json).
//
// The Files-tab PDF preview loads the decrypted bytes via `fetch("attachment://…")`
// (editor/src/attachments/pdf-render.ts), which is governed by CSP `connect-src`;
// the pdf.js worker needs `worker-src`. If a future edit drops either, PDF preview
// silently fails-closed to the generic icon — exactly the bug fixed in
// decisions.md 2026-07-12 "Mobile attachment preview parity". The packaged
// WebView is the only place the CSP is actually enforced, so the flow tier
// (mock IPC, Vite dev server, no `attachment://`) cannot catch a regression here;
// this asserts the config string directly, which is the only automated net.

// The shared parser, not a third copy. Its own header says why: this file used
// to inline a loop that disagreed with it about the map's shape (`name -> whole
// directive` here against `name -> value` there), so the same claim read
// differently on the two clients and neither reading was obviously the right one.
const directives = mobileCspDirectives();

describe("mobile CSP", () => {
  it("allows the attachment: scheme for connect-src (pdf.js byte fetch)", () => {
    expect(directives["connect-src"]).toContain("attachment:");
  });

  it("allows blob: workers for worker-src (pdf.js worker)", () => {
    expect(directives["worker-src"]).toContain("blob:");
  });

  it("keeps attachment: on img-src + media-src (image + audio preview)", () => {
    expect(directives["img-src"]).toContain("attachment:");
    expect(directives["media-src"]).toContain("attachment:");
  });

  it("lists http://attachment.localhost wherever attachment: appears (MYND-519)", () => {
    // Android WebView cannot intercept custom schemes — Tauri serves the
    // attachment protocol there as `http://attachment.localhost/<id>` (the
    // form `convertFileSrc` emits), a DIFFERENT origin from the app, so the
    // scheme-source `attachment:` alone does not cover it. Dropping any of
    // these re-breaks Android attachment render (images/audio) and PDF
    // preview (pdf.js byte fetch).
    expect(directives["img-src"]).toContain("http://attachment.localhost");
    expect(directives["media-src"]).toContain("http://attachment.localhost");
    expect(directives["connect-src"]).toContain("http://attachment.localhost");
  });

  it("leaves the defense-in-depth XSS directives intact", () => {
    expect(directives["default-src"]).toBe("'self'");
    expect(directives["object-src"]).toBe("'none'");
    expect(directives["script-src"]).toContain("'self'");
    // script-src must NOT gain 'unsafe-inline' — the primary XSS control is here.
    expect(directives["script-src"]).not.toContain("'unsafe-inline'");
  });

  it("closes the three navigation-shaped directives (myne#453)", () => {
    // `form-action` is the one that is NOT defense-in-depth. A form submission
    // is a navigation, and navigation directives get NO `default-src` fallback
    // (that fallback covers fetch directives only), so omitting it inherits
    // nothing. On Android it is the only control that can see the case at all:
    // the WebViewClient `shouldOverrideUrlLoading` hook the navigation policy
    // installs (`mobile/src-tauri/src/navigation.rs`) is not called for POST requests.
    expect(directives["form-action"]).toBe("'none'");
    // `<base href="https://evil/">` injected by a sanitizer bypass repoints
    // every relative asset URL in the bundle.
    expect(directives["base-uri"]).toBe("'none'");
    // Works only because Tauri serves this policy as an HTTP response header;
    // `frame-ancestors` is ignored in a `<meta http-equiv>` policy. Recorded
    // here so a future move to a meta tag cannot pass silently.
    expect(directives["frame-ancestors"]).toBe("'none'");
  });

  it("does not cargo-cult desktop-only origins that mobile IPC never uses", () => {
    // Mobile IPC routes through the WKWebView/Android bridge, not a CSP-gated
    // fetch, so `ipc:`/`http://ipc.localhost` are deliberately absent (decisions
    // 2026-07-12). frame-src is unneeded — the PDF reader is canvas-based.
    expect(directives["connect-src"]).not.toContain("ipc:");
    expect("frame-src" in directives).toBe(false);
  });
});
