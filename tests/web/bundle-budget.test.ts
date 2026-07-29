// The first-load budget ratchet (phase3-web-client task 68).
//
// The script's job is to fail a build that grew. The failure mode a test has to
// rule out is the opposite of the usual one: a scanner that matches NOTHING
// reports a 0-byte bundle, passes forever, and looks exactly like a bundle that
// never grows. So the assertions below are mostly about the scan finding the
// right things, and about the comparison biting at the right point.

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  initialAssetsFrom,
  measure,
  wasmOnCriticalPath,
  withinBudget,
} from "../../scripts/check-web-bundle-budget.mjs";

/**
 * The built bundle's entry document, when one exists.
 *
 * Two assertions below read it, and in CI it is NOT there: `vitest` runs before
 * `web-build`, so nothing has produced `web/dist` yet. They failed there with a
 * bare ENOENT — a defect that shipped with MYND-574 and stayed invisible because
 * the pipeline erred at config-compile from that day on, so this suite never ran
 * remotely.
 *
 * **Skipping is safe here specifically, and it is worth saying why rather than
 * assuming it.** The property those two guard — a scan that matches NOTHING
 * reports a 0-byte bundle and passes forever — is enforced against the real
 * build by `check-web-bundle-budget.mjs` itself, which refuses an empty asset
 * list and runs in `web-build` where a bundle is guaranteed. So the coverage
 * lives at the point that has the artefact, and these two are the local
 * convenience of getting the same answer before a build.
 */
const REAL_HTML = join(process.cwd(), "web", "dist", "index.html");
const hasBuild = existsSync(REAL_HTML);
/** Skipped, never silently passed: a skip is REPORTED, and an absent bundle is a
 *  fact about the run rather than a result. A guard that returned early instead
 *  would render as a pass and be indistinguishable from one that ran. */
const itWithBuild = it.skipIf(!hasBuild);

const HTML = `<!doctype html>
<html><head>
<script type="module" crossorigin src="/assets/index-abc.js"></script>
<link rel="modulepreload" crossorigin href="/assets/chunk-def.js">
<link rel="stylesheet" crossorigin href="/assets/index-ghi.css">
</head><body><div id="root"></div></body></html>`;

describe("what counts as first load", () => {
  it("takes the entry, its static graph and the stylesheet", () => {
    expect(initialAssetsFrom(HTML)).toEqual([
      "assets/index-abc.js",
      "assets/chunk-def.js",
      "assets/index-ghi.css",
    ]);
  });

  it("ignores anything not fetched from this origin's root", () => {
    // Nothing should ever be here — the zero-third-party rule and cross-origin
    // isolation both forbid it — but a scan that silently counted an absolute
    // URL as a local path would crash on read rather than report the violation.
    expect(initialAssetsFrom('<script src="https://cdn.example/x.js"></script>')).toEqual([]);
  });

  it("does not count a lazily-imported chunk", () => {
    // Code-splitting is the whole reason the 24 locale catalogues and the
    // drawing canvas do not appear here. A budget that counted them would be
    // indifferent to whether splitting works.
    const html = `${HTML}\n<link rel="prefetch" href="/assets/mermaid-xyz.js">`;
    expect(initialAssetsFrom(html)).not.toContain("assets/mermaid-xyz.js");
  });

  itWithBuild("finds something in the REAL built HTML", () => {
    // The regexes above are tested against a fixture; this is the one that
    // catches Vite changing how it emits the entry.
    const real = readFileSync(REAL_HTML, "utf8");
    const assets = initialAssetsFrom(real);
    expect(assets.length).toBeGreaterThan(0);
    expect(assets.some((a) => a.endsWith(".js"))).toBe(true);
    expect(assets.some((a) => a.endsWith(".css"))).toBe(true);
  });
});

describe("the wasm assertion", () => {
  it("names the wasm core when it reaches the entry graph", () => {
    expect(wasmOnCriticalPath(["assets/index-abc.js", "assets/myne_web_wasm-1.js"])).toEqual([
      "assets/myne_web_wasm-1.js",
    ]);
    expect(wasmOnCriticalPath(["assets/core-x.wasm"])).toEqual(["assets/core-x.wasm"]);
  });

  it("is quiet for an entry graph that keeps it behind the Worker", () => {
    expect(wasmOnCriticalPath(["assets/index-abc.js", "assets/index-ghi.css"])).toEqual([]);
  });

  itWithBuild("holds for the real build", () => {
    const real = readFileSync(REAL_HTML, "utf8");
    expect(wasmOnCriticalPath(initialAssetsFrom(real))).toEqual([]);
  });
});

describe("the ratchet", () => {
  it("passes at the baseline and at the margin, fails one byte past it", () => {
    expect(withinBudget(1000, 1000, 10)).toBe(true);
    expect(withinBudget(1100, 1000, 10)).toBe(true);
    expect(withinBudget(1101, 1000, 10)).toBe(false);
  });

  it("passes when the bundle SHRINKS — a ratchet is one-directional", () => {
    expect(withinBudget(10, 1000, 10)).toBe(true);
  });

  it("measures gzip, not just raw", () => {
    // The origin serves compressed (`web/container/Caddyfile`), so the transfer
    // size is what a budget about first load is actually about.
    const bytes = Buffer.from("a".repeat(10_000));
    const { rawBytes, gzipBytes } = measure(["x.js"], () => bytes);
    expect(rawBytes).toBe(10_000);
    expect(gzipBytes).toBeLessThan(rawBytes);
  });
});
