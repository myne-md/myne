// Per-bundle scoping of the shared vendored-origin list (myne-md/myne#832).
//
// The regression this pins: `check-web-third-party.mjs` and
// `check-stories-bundle.mjs` both read the UNION of both clients' origins, so
// the web guard pre-approved entries only the catalogue can carry, and a
// genuinely new web origin matching one would ship with no human reading it —
// the one review that guard exists to force. The split gives each guard a scoped
// view of the same reasons.
//
// The guard modules run top-level I/O on import (they `process.exit` when their
// bundle is absent), so this asserts the MAPS directly and the wiring by reading
// each script's source rather than importing it.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  VENDORED_ORIGINS,
  WEB_VENDORED_ORIGINS,
  STORIES_VENDORED_ORIGINS,
} from "../../scripts/lib/vendored-origins.mjs";

const read = (name: string): string =>
  readFileSync(new URL(`../../scripts/${name}`, import.meta.url), "utf8");

describe("vendored-origin scoping", () => {
  it("keeps the web set a subset of the union, with the same reasons", () => {
    expect(WEB_VENDORED_ORIGINS.size).toBeLessThanOrEqual(VENDORED_ORIGINS.size);
    for (const [origin, reason] of WEB_VENDORED_ORIGINS) {
      expect(VENDORED_ORIGINS.get(origin)).toBe(reason);
    }
  });

  it("does not pre-approve the font licence origins for web", () => {
    // The concrete leak: `public/fonts/LICENSE.txt` carries these, the web scan
    // ignores `.txt`, and the catalogue's scan reads it. They belong to the
    // catalogue's set and not the web's.
    expect(WEB_VENDORED_ORIGINS.has("https://scripts.sil.org")).toBe(false);
    expect(WEB_VENDORED_ORIGINS.has("http://scripts.sil.org")).toBe(false);
    expect(STORIES_VENDORED_ORIGINS.has("https://scripts.sil.org")).toBe(true);
    expect(STORIES_VENDORED_ORIGINS.has("http://scripts.sil.org")).toBe(true);
  });

  it("keeps an origin the web bundle genuinely carries", () => {
    // `sync.myne.md` is in `web/src` and shared `src/`; dropping it from the web
    // set would fail the guard's unknown-origin arm on the next web build.
    expect(WEB_VENDORED_ORIGINS.has("https://sync.myne.md")).toBe(true);
  });

  it("wires each guard to its scoped map", () => {
    const web = read("check-web-third-party.mjs");
    const stories = read("check-stories-bundle.mjs");
    expect(web).toContain('import { WEB_VENDORED_ORIGINS } from "./lib/vendored-origins.mjs"');
    expect(web).toContain("export const KNOWN = WEB_VENDORED_ORIGINS");
    expect(stories).toContain(
      'import { STORIES_VENDORED_ORIGINS } from "./lib/vendored-origins.mjs"',
    );
    expect(stories).toContain("export const KNOWN_ORIGINS = STORIES_VENDORED_ORIGINS");
  });
});
