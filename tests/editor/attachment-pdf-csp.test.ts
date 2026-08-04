// CSP regression guard for inline pdf.js render (MYND-164 dogfooding fix #5).
//
// The inline PDF render fetches decrypted bytes from the `attachment://` scheme
// and feeds them to pdf.js as `data`. That fetch is governed by the WebView CSP
// `connect-src`. If `attachment:` is dropped from `connect-src`, the fetch is
// blocked and PDFs silently fall back to the icon again. This test locks the
// directive in place (parsing the canonical tauri.conf.json), so a future CSP
// edit that removes it fails CI rather than silently regressing the feature.
//
// Scope note: `attachment:` is already trusted in img-src / media-src /
// frame-src; widening `connect-src` to the SAME scheme opens no new origin.

import { describe, expect, it } from "vitest";
import { desktopCspDirectives as csp } from "../lib/_desktopCsp";

describe("WebView CSP supports inline pdf.js render", () => {
  it("connect-src allows the attachment: scheme (pdf bytes fetch)", () => {
    const d = csp();
    expect(d["connect-src"]).toBeDefined();
    expect(d["connect-src"].split(/\s+/)).toContain("attachment:");
  });

  it("worker-src still allows 'self' + blob: (module worker)", () => {
    const d = csp();
    const ws = d["worker-src"].split(/\s+/);
    expect(ws).toContain("'self'");
    expect(ws).toContain("blob:");
  });

  it("img-src/media-src already trust attachment: (no new origin widened)", () => {
    const d = csp();
    expect(d["img-src"].split(/\s+/)).toContain("attachment:");
    expect(d["media-src"].split(/\s+/)).toContain("attachment:");
  });

  it("every attachment: directive also lists http://attachment.localhost (Windows http-mapped form, MYND-519)", () => {
    // WebView2 (and Android WebView) cannot intercept custom schemes — Tauri
    // serves registered protocols there as `http://<scheme>.localhost`, so
    // the runtime `convertFileSrc` form needs the dual origin, exactly like
    // the existing `ipc: http://ipc.localhost` pair in connect-src.
    const d = csp();
    for (const dir of ["img-src", "media-src", "connect-src", "frame-src"]) {
      expect(d[dir].split(/\s+/)).toContain("http://attachment.localhost");
    }
  });
});
