// No `data:` image survives into the built web CSS (phase3-web-client task 99).
//
// # Why this is a build assertion and not a code review
//
// The offenders are in VENDORED stylesheets — the drawing canvas paints its
// transparent-background checkerboard from an inline PNG and its dropdown arrows
// from inline SVGs — so no amount of care in `src/` prevents them, and a
// dependency bump can reintroduce one at any time.
//
// # Why it matters more than a swatch
//
// `img-src 'self' blob:` is the policy task 97 narrowed to, and task 44's
// criterion is that it admit object URLs **without** admitting `data:`, which
// would admit any bytes any script can construct. Under that policy the browser
// refuses these: the decoration renders flat and a violation is logged on every
// drawing open. **Cosmetic, and therefore quiet** — which is exactly why it needs
// a machine check. It would also trip task 60's "zero CSP violations" assertion,
// where it would read as a mystery rather than as a known decoration.
//
// The check runs against the BUILT bundle and self-skips when there is none, so
// it is a real assertion in CI (which builds) and not a false failure locally.

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ASSETS = join(process.cwd(), "web", "dist", "assets");
const built = existsSync(ASSETS);

describe.skipIf(!built)("built web CSS", () => {
  const cssFiles = built ? readdirSync(ASSETS).filter((f) => f.endsWith(".css")) : [];

  it("has some CSS to check, so a rename cannot make this vacuous", () => {
    // Without this, a bundler change that stopped emitting `.css` files would
    // turn every assertion below into a loop over nothing — passing, and
    // proving less than nothing.
    expect(cssFiles.length).toBeGreaterThan(0);
  });

  it("contains no `data:` image URI at all", () => {
    const offenders: string[] = [];
    for (const f of cssFiles) {
      const css = readFileSync(join(ASSETS, f), "utf8");
      // Both forms, because the vendored stylesheet uses both and only one of
      // them is base64: `data:image/png;base64,…` and `data:image/svg+xml,<svg…>`.
      const hits = css.match(/data:image\/[a-z+]+[;,]/g);
      if (hits) offenders.push(`${f} (${hits.length})`);
    }
    expect(
      offenders,
      "a `data:` image in the built CSS is blocked by `img-src 'self' blob:` — " +
        "extract it to a same-origin asset (web/vite.config.ts's emitCssDataImages), " +
        "never widen the CSP",
    ).toEqual([]);
  });

  it("emitted the extracted images as same-origin files", () => {
    // The positive half. Asserting only the absence would pass if the plugin
    // deleted the rules instead of rewriting them.
    const emitted = readdirSync(ASSETS).filter((f) => f.startsWith("inline-"));
    expect(emitted.length).toBeGreaterThan(0);
    const referenced = cssFiles
      .map((f) => readFileSync(join(ASSETS, f), "utf8"))
      .join("\n");
    for (const f of emitted) {
      expect(referenced, `${f} was emitted but nothing references it`).toContain(f);
    }
  });

  it("references them by absolute same-origin path, never a remote one", () => {
    const referenced = cssFiles
      .map((f) => readFileSync(join(ASSETS, f), "utf8"))
      .join("\n");
    for (const m of referenced.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
      const url = m[1];
      // Same-origin means: a rooted path or a relative one. A scheme-bearing
      // URL in a stylesheet is a third-party origin, which the zero-third-party
      // rule forbids outright and the CSP would block anyway.
      expect(url, `${url} is not same-origin`).not.toMatch(/^[a-z]+:\/\//i);
    }
  });
});
