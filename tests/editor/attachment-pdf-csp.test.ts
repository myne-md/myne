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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const confPath = resolve(here, "../../src-tauri/tauri.conf.json");

function csp(): Record<string, string> {
  const conf = JSON.parse(readFileSync(confPath, "utf8")) as {
    app: { security: { csp: string } };
  };
  const directives: Record<string, string> = {};
  for (const part of conf.app.security.csp.split(";")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const sp = trimmed.indexOf(" ");
    const name = sp === -1 ? trimmed : trimmed.slice(0, sp);
    directives[name] = sp === -1 ? "" : trimmed.slice(sp + 1);
  }
  return directives;
}

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
