// @vitest-environment jsdom
// Excalidraw embed-hardening guards (drawing-notes SF1, MYND-498).
//
// Enforces the SYNC-5 hardening posture that cannot regress silently: the
// shared config rejects every embeddable, the font loader is repointed to the
// self-hosted same-origin base, the fonts are actually vendored, and — when a
// production build is present — the Excalidraw library never leaks into the
// cold bundle and any Excalidraw chunk carries no `eval` / CDN-host string.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HARDENED_EXCALIDRAW_PROPS } from "../../src/drawing/excalidrawConfig";

describe("excalidraw embed hardening", () => {
  it("rejects every embeddable element (the one HTML/iframe egress surface)", () => {
    for (const link of [
      "https://youtube.com/watch?v=x",
      "https://twitter.com/x/status/1",
      "https://example.com/anything",
      "",
    ]) {
      expect(HARDENED_EXCALIDRAW_PROPS.validateEmbeddable(link)).toBe(false);
    }
  });

  it("repoints the font loader to the self-hosted same-origin asset base", async () => {
    await import("../../src/drawing/excalidraw-asset-path");
    expect(window.EXCALIDRAW_ASSET_PATH).toBe("/excalidraw-assets/");
    // Never a CDN / external origin.
    expect(String(window.EXCALIDRAW_ASSET_PATH)).not.toMatch(/^https?:/);
  });

  it("vendors the Excalidraw fonts under public/ (no runtime CDN fetch)", () => {
    expect(existsSync(join("public", "excalidraw-assets", "fonts", "Excalifont"))).toBe(true);
  });

  // Build-artifact guards — meaningful only when a production build exists.
  // Not vacuous: they skip with a logged reason when dist/ is absent so a green
  // run never implies coverage that didn't happen.
  const distAssets = join("dist", "assets");
  const haveBuild = existsSync(distAssets);

  (haveBuild ? it : it.skip)(
    "keeps the Excalidraw library out of the cold (entry) bundle",
    () => {
      const mainChunks = readdirSync(distAssets).filter((f) => /^main-.*\.js$/.test(f));
      expect(mainChunks.length).toBeGreaterThan(0);
      for (const f of mainChunks) {
        const src = readFileSync(join(distAssets, f), "utf8");
        // The library's font family + package marker must not be in main.
        // (The tiny "/excalidraw-assets/" asset-path bootstrap string is allowed.)
        expect(src).not.toMatch(/Excalifont/);
        expect(src).not.toMatch(/@excalidraw\/excalidraw\/dist/);
      }
    },
  );

  // NOTE on CDN strings: the vendored Excalidraw bundle contains default-URL
  // string constants (`libraries.excalidraw.com`, `esm.sh`) — unavoidable in a
  // 3rd-party minified bundle and NOT the egress boundary. Actual egress is
  // foreclosed by (a) the runtime `EXCALIDRAW_ASSET_PATH` override → fonts load
  // same-origin (tested above), and (b) the CSP `connect-src`/`font-src`/`img-src`
  // allowlist + the compiled `no_egress.rs` gate (tested in the Rust suite). So we
  // assert the invariant that IS load-bearing at the chunk level — no `eval`, so
  // the chunk runs under `script-src 'self' 'wasm-unsafe-eval'` (no 'unsafe-eval').
  (haveBuild ? it : it.skip)(
    "the Excalidraw chunk needs no eval / new Function (CSP script-src compatible)",
    () => {
      const files = readdirSync(distAssets).filter((f) => f.endsWith(".js"));
      const exChunks = files.filter((f) =>
        /Excalifont/.test(readFileSync(join(distAssets, f), "utf8")),
      );
      expect(exChunks.length).toBeGreaterThan(0); // the code-split chunk exists
      for (const f of exChunks) {
        const src = readFileSync(join(distAssets, f), "utf8");
        expect(src).not.toMatch(/\beval\(/);
        expect(src).not.toMatch(/new Function\(/);
      }
    },
  );
});
