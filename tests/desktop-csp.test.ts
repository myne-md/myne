// Desktop WebView CSP — the injection vectors that cost nothing to close
// (myne#383).
//
// Deliberately the twin of `tests/web/csp.test.ts:143,150`, down to the test
// names: the two clients ship ONE posture, and the desktop policy was missing
// three directives the web policy has carried since it was written
// (`web/csp.ts:26-28` — "each of these is a documented injection vector that
// costs nothing to close"). Naming them identically is what makes a future
// reader notice when only one side moves.
//
// `frame-ancestors` is load-bearing here in a way that is easy to get wrong:
// the directive is IGNORED when a CSP arrives via `<meta http-equiv>`, and it
// only works because Tauri serves this one as an HTTP response header on the
// `tauri://` protocol. If a future change moves the desktop CSP into a meta
// tag, this assertion keeps passing while the protection disappears — so the
// header delivery is the thing to re-check, not this file.

import { describe, expect, it } from "vitest";
import { desktopCspDirectives } from "./lib/_desktopCsp";

describe("desktop WebView CSP", () => {
  it("closes the injection vectors that cost nothing to close", () => {
    const d = desktopCspDirectives();
    expect(d["object-src"]).toBe("'none'");
    // `<base href="https://evil/">` injected by a sanitizer bypass repoints
    // every relative asset URL in the bundle. Neither entry HTML carries a
    // `<base>` element and `vite.config.ts` sets no `base` option, so 'none'
    // costs nothing.
    expect(d["base-uri"]).toBe("'none'");
    // The app has six real <form> elements and one of them — Unlock.tsx — has
    // a single `type="password"` input holding the master password. Its
    // onSubmit calls preventDefault() today; the day a refactor drops that
    // call, the browser GET-submits to the current document URL with
    // `?password=…`, putting the master password in the WebView's URL and its
    // session history. `form-action 'none'` makes that structurally
    // impossible rather than conventionally avoided.
    expect(d["form-action"]).toBe("'none'");
  });

  it("cannot be framed", () => {
    // The reverse direction from `frame-src`: that one says the app may frame
    // `attachment:` documents, this one says no document may frame the app's
    // own pages. Nothing frames them today, so 'none' is free — note that it
    // also forbids SAME-ORIGIN framing, so a future feature that wants to
    // iframe an app page must relax this to 'self' deliberately.
    expect(desktopCspDirectives()["frame-ancestors"]).toBe("'none'");
  });

  it("still carries every directive the render surfaces depend on", () => {
    // The three additions above were appended, not inserted — this pins that
    // nothing was displaced on the way in.
    const d = desktopCspDirectives();
    for (const name of [
      "default-src",
      "img-src",
      "media-src",
      "object-src",
      "connect-src",
      "script-src",
      "style-src",
      "font-src",
      "frame-src",
      "worker-src",
    ]) {
      expect(d[name], `${name} directive`).toBeDefined();
    }
  });
});
