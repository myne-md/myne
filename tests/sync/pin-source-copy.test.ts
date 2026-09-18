// The endpoint screen's pin-source copy map (phase3-web-client task 84).
//
// `EndpointConfig` renders its pin explanation through `t(PIN_SOURCE_COPY[src])`
// — a dynamic key, which is the pattern `src/AGENTS.md` prescribes for
// module-level data, and which `scripts/check-i18n.mjs` cannot see: that guard
// only detects static `t("…")` literals. So a typo in the map would render the
// raw key string and no guard would notice.
//
// This is that guard, and it also pins the property the map exists for: a
// `PinSource` variant with no copy is a compile error (the `Record` is total),
// and a variant whose copy is missing from the catalog is a test failure.
//
// The third variant is the one that matters. `platform_trust_store` is NOT the
// same as "no pin": a browser cannot see a leaf certificate, so it has no
// fingerprint to show, but the connection is verified — by the browser's own
// trust store. Before it existed this screen read a missing fingerprint as
// "connected to a local server", which it would have said about a real
// `https://` server.

import { describe, expect, it } from "vitest";
import en from "../../locales/en/common.json";
import { PIN_SOURCE_COPY } from "../../src/components/sync/EndpointConfig";

/** Resolve a dotted i18n key against the raw catalog → the string, or undefined. */
function lookup(key: string): string | undefined {
  const v = key
    .split(".")
    .reduce<unknown>(
      (o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
      en as unknown,
    );
  return typeof v === "string" ? v : undefined;
}

describe("PIN_SOURCE_COPY", () => {
  it("covers every pin source the backend can report", () => {
    // Mirrors `myne_core::plugins::sync::config::PinSource`'s serde names. A
    // variant added there without a `PinSource` union member here fails to
    // compile; one added to the union without copy fails the `Record`; one that
    // reaches neither fails this list.
    expect(Object.keys(PIN_SOURCE_COPY).sort()).toEqual([
      "platform_trust_store",
      "static",
      "tofu",
    ]);
  });

  it("resolves every entry to non-empty English copy", () => {
    for (const [source, key] of Object.entries(PIN_SOURCE_COPY)) {
      const copy = lookup(key);
      expect(copy, `${source} → ${key} is missing from locales/en/common.json`).toBeTruthy();
      expect(copy!.length, `${source} → ${key} is empty`).toBeGreaterThan(0);
    }
  });

  it("says the browser is VERIFIED rather than unpinned", () => {
    // The wording is the point of the variant. A line that read like a warning
    // ("no certificate pinned") would describe the same fact and give the user
    // the opposite impression of their actual security posture — the browser
    // did verify the certificate, using the same trust store every other site
    // on the machine relies on.
    const copy = lookup(PIN_SOURCE_COPY.platform_trust_store)!;
    expect(copy.toLowerCase()).toContain("verified");
  });
});
