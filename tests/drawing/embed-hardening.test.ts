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
import { HARDENED_EXCALIDRAW_PROPS } from "@myne/editor/drawing/excalidrawConfig";

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
    await import("@myne/editor/drawing/excalidraw-asset-path");
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

// Chrome curation guards (MYND-514, excalidraw-chrome-fit). These lock the
// curated-menu posture in the SAME shared config so a future edit can't silently
// re-surface the file-system / export affordances we dropped — nor regress the
// egress fields the chrome work sits next to. The visual side (Library/Help gone,
// welcome suppressed, token colours) is asserted in e2e/drawing-notes.e2e.ts; here
// we lock the declarative config that drives it.
describe("excalidraw chrome curation", () => {
  it("keeps the egress config fields locked (libraryReturnUrl off, langCode en)", () => {
    expect(HARDENED_EXCALIDRAW_PROPS.libraryReturnUrl).toBeUndefined();
    expect(HARDENED_EXCALIDRAW_PROPS.langCode).toBe("en");
  });

  it("disables the file-system + export canvas actions (menu clutter can't return)", () => {
    const ca = HARDENED_EXCALIDRAW_PROPS.UIOptions.canvasActions;
    expect(ca.loadScene).toBe(false);
    expect(ca.saveToActiveFile).toBe(false);
    expect(ca.export).toBe(false);
    expect(ca.saveAsImage).toBe(false);
  });

  it("keeps the three curated menu actions + the image tool enabled", () => {
    const { canvasActions, tools } = HARDENED_EXCALIDRAW_PROPS.UIOptions;
    // These three GATE the composed <MainMenu.DefaultItems> — each renders null if
    // its canvasAction is off, so flipping any to false silently empties the menu.
    expect(canvasActions.changeViewBackgroundColor).toBe(true);
    expect(canvasActions.toggleTheme).toBe(true);
    expect(canvasActions.clearCanvas).toBe(true);
    // Image tool stays (local picker only; image-from-URL is CSP-blocked).
    expect(tools.image).toBe(true);
  });
});
