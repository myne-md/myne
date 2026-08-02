// MYND-485 — the mobile i18n runtime is the desktop react-i18next runtime,
// shared verbatim by alias (`@myne/i18n` → ../src/i18n). These tests prove the
// alias resolves, the shared catalogs load on mobile's build/test config, the
// language set is the shared desktop constant (no drift), switching works, and a
// missing translation falls back rather than rendering blank. (The roster grew
// from 24 to 32 with the RTL epic, which added the RTL locales — ar/fa/ur — plus
// more scripts; the count below tracks the shared constant, not a mobile copy.)

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n, { setLanguage } from "@myne/i18n";
import { SUPPORTED_LANGUAGES } from "@myne/i18n/config";

// The boot language is environment-derived (localStorage → navigator.language →
// en). Node 22 exposes a global `navigator.language` = the host OS locale, so on
// a non-English machine the runtime boots that locale (the desired behavior).
// Pin English before each assertion so catalog tests are host-locale-independent.
beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("mobile i18n runtime (shared desktop runtime via @myne/i18n alias)", () => {
  it("loads the shared English catalog through the alias", () => {
    // A key that only exists in the shared repo-root locales/en/common.json.
    expect(i18n.t("settings.language.label")).toBe("Language");
  });

  it("shares the desktop 32-language config (no mobile copy → no drift)", () => {
    const codes = SUPPORTED_LANGUAGES.map((l) => l.code);
    expect(SUPPORTED_LANGUAGES.length).toBe(32);
    expect(codes).toContain("en");
    expect(codes).toContain("tr");
    // The RTL epic's locales are part of the shared roster mobile inherits.
    expect(codes).toContain("ar");
    // Labels are in each language's own script (a shared-config sanity check).
    expect(SUPPORTED_LANGUAGES.find((l) => l.code === "tr")?.label).toBe("Türkçe");
  });

  // Go through `setLanguage`, not `i18n.changeLanguage`. Catalogs other than
  // English are lazy chunks (myne `decisions.md` 2026-08-03), so the bundle for
  // a locale has to be installed before the switch — which is exactly what
  // `setLanguage` does and why the UI calls it. A bare `changeLanguage` finds no
  // `tr` bundle and resolves back to the English fallback.
  it("switches the active locale via setLanguage", async () => {
    await expect(setLanguage("tr")).resolves.toBe(true);
    expect(i18n.resolvedLanguage ?? i18n.language).toBe("tr");
  });

  it("setLanguage persists the choice to localStorage myne.lang", () => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    setLanguage("tr");
    expect(store.get("myne.lang")).toBe("tr");
  });

  it("falls back to the key for a missing translation (never blank)", () => {
    const missing = "nonexistent.key.zzz";
    const out = i18n.t(missing);
    expect(out).toBe(missing);
    expect(out).not.toBe("");
  });
});
