// CSP + security-header generation for the self-host container
// (phase3-web-client tasks 49, 50, 55).

import { describe, expect, it } from "vitest";
import {
  buildCsp,
  InvalidSyncOriginError,
  normaliseSyncOrigin,
  securityHeaders,
} from "../../web/csp";

const HOSTED = "https://sync.myne.md";
const SELF = "https://sync.example.org:8443";

describe("sync-origin validation", () => {
  it("accepts an https origin and normalises it", () => {
    expect(normaliseSyncOrigin(HOSTED)).toBe(HOSTED);
    expect(normaliseSyncOrigin(`  ${HOSTED}/  `)).toBe(HOSTED);
    expect(normaliseSyncOrigin(SELF)).toBe(SELF);
  });

  it("allows http ONLY for loopback", () => {
    expect(normaliseSyncOrigin("http://localhost:8080")).toBe("http://localhost:8080");
    expect(normaliseSyncOrigin("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(() => normaliseSyncOrigin("http://sync.example.org")).toThrow(InvalidSyncOriginError);
  });

  // A wildcard cannot be combined with the credentialed requests the client
  // makes, and accepting one would turn an operator typo into an open policy.
  it("refuses wildcards outright", () => {
    for (const bad of ["*", "https://*", "https://*.example.org"]) {
      expect(() => normaliseSyncOrigin(bad)).toThrow(InvalidSyncOriginError);
    }
  });

  // A CSP source with a path means something narrower and different from an
  // origin; silently accepting one would produce a policy the operator did not
  // write.
  it("refuses anything that is not an origin", () => {
    for (const bad of ["https://sync.example.org/api", "https://sync.example.org/?a=1", "https://sync.example.org/#x"]) {
      expect(() => normaliseSyncOrigin(bad)).toThrow(InvalidSyncOriginError);
    }
  });

  it("refuses empty and unparseable values, naming the reason", () => {
    expect(() => normaliseSyncOrigin("")).toThrow(/empty/);
    expect(() => normaliseSyncOrigin("   ")).toThrow(/empty/);
    expect(() => normaliseSyncOrigin("sync.example.org")).toThrow(/not a URL/);
  });
});

describe("CSP", () => {
  const csp = buildCsp({ syncOrigin: SELF });

  it("names exactly the configured sync origin in connect-src, and no wildcard", () => {
    expect(csp).toContain(`connect-src 'self' ${SELF}`);
    expect(csp).not.toContain("connect-src *");
    expect(csp).not.toMatch(/connect-src[^;]*\*/);
  });

  it("is as tight for a self-hoster as for the hosted instance", () => {
    // The ONLY difference between the two policies is the sync origin. If any
    // other directive ever diverged, a self-hoster would be running a weaker
    // client without being told.
    const hosted = buildCsp({ syncOrigin: HOSTED });
    expect(hosted.replace(HOSTED, "ORIGIN")).toBe(csp.replace(SELF, "ORIGIN"));
  });

  it("starts from nothing", () => {
    expect(csp.startsWith("default-src 'none'")).toBe(true);
  });

  it("permits no inline or eval'd script", () => {
    const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"))!;
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    // `wasm-unsafe-eval` permits WebAssembly compilation and nothing else. The
    // wasm core cannot instantiate without it; it does NOT enable eval.
    expect(scriptSrc).toContain("'wasm-unsafe-eval'");
  });

  it("allows no third-party origin anywhere", () => {
    // Every source in every directive must be the app's own origin, the
    // configured sync origin, or a keyword/scheme. A CDN slipping into a
    // directive is exactly what this asserts against.
    // `data:` is deliberately NOT in this set (phase3-web-client task 97): the
    // two surfaces that needed it — the share-card rasterisation and the
    // device-join QR — mint object URLs now, so any `data:` source reappearing
    // is a regression, not a new feature's cost.
    //
    // ONE directive is exempted by name rather than by loosening the set:
    // `font-src`, which carries `data:` for the woff2 face
    // `@excalidraw/excalidraw` embeds inline in its production JavaScript and
    // registers at runtime. A base64 string in a vendored bundle cannot be
    // extracted to an emitted asset the way task 99's stylesheet PNG can. The
    // exemption is per-directive on purpose: a font executes nothing and is not
    // a navigation target, so the grant does not carry `img-src data:`'s cost —
    // and naming the directive here means re-admitting `data:` anywhere ELSE
    // still fails this test.
    const allowed = new Set(["'self'", "'none'", "'wasm-unsafe-eval'", "'unsafe-inline'", "blob:", SELF]);
    const dataUriExempt = new Set(["font-src"]);
    for (const directive of csp.split("; ")) {
      const [name, ...sources] = directive.split(" ");
      if (name === "upgrade-insecure-requests") continue;
      for (const src of sources) {
        if (src === "data:" && dataUriExempt.has(name)) continue;
        expect(allowed.has(src), `${name} allows unexpected source ${src}`).toBe(true);
      }
    }
  });

  it("admits `data:` in font-src and NOWHERE else", () => {
    // The exemption above, asserted as its own property so its scope is a test
    // rather than a comment. If a future change widens `data:` to `img-src`,
    // `script-src` or `connect-src`, this fails — which is the whole point of
    // granting it by directive instead of by keyword.
    for (const directive of csp.split("; ")) {
      const [name] = directive.split(" ");
      if (name === "font-src") {
        expect(directive).toContain("data:");
        continue;
      }
      expect(directive, `${name} must not admit data:`).not.toContain("data:");
    }
  });

  it("admits object URLs for images and NOT `data:` (task 44's criterion, kept by task 97)", () => {
    // Task 44 requires the policy admit object URLs "without admitting remote or
    // `data:` content". That criterion was true of the attachment path and false
    // of the POLICY, because an unrelated feature's `data:` SVG kept the source
    // alive. Both assertions belong together: dropping `blob:` would break
    // attachments, and re-adding `data:` would re-admit any bytes any script can
    // construct.
    const imgSrc = csp.split("; ").find((d) => d.startsWith("img-src")) ?? "";
    expect(imgSrc).toContain("blob:");
    expect(imgSrc).not.toContain("data:");
    // The whole-policy assertion this used to make now lives in "admits `data:`
    // in font-src and NOWHERE else" — narrowed rather than dropped, because the
    // one directive that gained `data:` gained it for a vendored font, and
    // asserting its absence everywhere else is the property worth keeping.
  });

  it("closes the injection vectors that cost nothing to close", () => {
    for (const d of ["object-src 'none'", "base-uri 'none'", "form-action 'none'"]) {
      expect(csp).toContain(d);
    }
  });

  // Clickjacking an unlocked vault is a real attack; this is its whole defence.
  it("cannot be framed", () => {
    expect(csp).toContain("frame-ancestors 'none'");
  });
});

describe("security headers", () => {
  const h = securityHeaders({ syncOrigin: HOSTED });

  it("sets the cross-origin isolation pair — both, or neither works", () => {
    expect(h["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(h["Cross-Origin-Embedder-Policy"]).toBe("require-corp");
  });

  it("sets HSTS on the origin where a MITM would be fatal", () => {
    // A MITM on the sync origin sees only ciphertext; a MITM on the bundle
    // origin serves the code. So this is the origin that gets the strongest
    // transport posture.
    expect(h["Strict-Transport-Security"]).toContain("includeSubDomains");
    expect(h["Strict-Transport-Security"]).toContain("preload");
  });

  it("denies every device permission the app does not use", () => {
    for (const feature of ["camera", "microphone", "geolocation", "usb", "payment"]) {
      expect(h["Permissions-Policy"]).toContain(`${feature}=()`);
    }
  });

  it("leaks no referrer and permits no MIME sniffing", () => {
    expect(h["Referrer-Policy"]).toBe("no-referrer");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("refuses to produce a header set at all for a bad sync origin", () => {
    // Fail-closed: a misconfigured origin must stop the container, not yield a
    // header set with a hole in it.
    expect(() => securityHeaders({ syncOrigin: "" })).toThrow(InvalidSyncOriginError);
    expect(() => securityHeaders({ syncOrigin: "*" })).toThrow(InvalidSyncOriginError);
  });
});
