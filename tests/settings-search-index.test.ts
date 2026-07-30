// Task 2 (settings-search) — drift guard for the settings search-index registry.
// Asserts registry integrity WITHOUT rendering any panel (panels run IPC on
// mount), by resolving keys against the raw English catalog:
//   • every entry's panelId is a valid PanelId
//   • all ids are unique
//   • every titleKey / descriptionKey / keywordsKey resolves to a non-empty
//     string in locales/en/common.json (no missing-key)
//   • every rail panel is represented by ≥1 entry (panel coverage)
//   • searchSettings returns the expected entries for representative queries
// This is the automated backstop for registry drift; the residual risk (a NEW
// setting with no entry) is convention + PR review, out of a test's reach.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import en from "../locales/en/common.json";
import {
  SETTINGS_SEARCH_INDEX,
} from "../src/components/settings/search/settingsSearchIndex";
import {
  searchSettings,
  panelLabelKey,
} from "../src/components/settings/search/searchSettings";

// The rail panel taxonomy (mirrors SettingsModal.tsx PanelId). Kept local so the
// coverage assertion has an independent list to check the registry against.
const PANEL_IDS = [
  "account",
  "privacy",
  "sync",
  "ai",
  "editor",
  "files",
  "transcription",
  "hotkeys",
  "appearance",
  "storage",
  "about",
] as const;

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

/** A `t` for behavioural checks: real catalog string, or the key if missing. */
const t = (key: string): string => lookup(key) ?? key;

/**
 * Concatenate every panel source under `dir`, EXCLUDING the search/ subtree.
 * The registry lives under search/, so including it would let a stale testid
 * match its own declaration and defeat the flash-target guard below.
 */
function readPanelSources(dir: string): string {
  let blob = "";
  for (const name of readdirSync(dir)) {
    if (name === "search") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      blob += readPanelSources(full);
    } else if (name.endsWith(".tsx") || name.endsWith(".ts")) {
      blob += `\n${readFileSync(full, "utf8")}`;
    }
  }
  return blob;
}

describe("settings search-index — integrity", () => {
  it("every entry targets a valid PanelId", () => {
    for (const e of SETTINGS_SEARCH_INDEX) {
      expect(PANEL_IDS as readonly string[]).toContain(e.panelId);
    }
  });

  it("all entry ids are unique", () => {
    const ids = SETTINGS_SEARCH_INDEX.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every title/description/keywords key resolves in the en catalog", () => {
    const missing: string[] = [];
    for (const e of SETTINGS_SEARCH_INDEX) {
      for (const key of [e.titleKey, e.descriptionKey, e.keywordsKey]) {
        if (key && lookup(key) === undefined) missing.push(`${e.id} → ${key}`);
      }
      if (lookup(panelLabelKey(e.panelId)) === undefined) {
        missing.push(`${e.id} → ${panelLabelKey(e.panelId)}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every rail panel is represented by at least one entry (coverage)", () => {
    const covered = new Set(SETTINGS_SEARCH_INDEX.map((e) => e.panelId));
    for (const p of PANEL_IDS) expect(covered).toContain(p);
  });

  it("every registered testid still exists in a panel source (flash-target guard)", () => {
    // The scroll/flash resolver falls back to a setting's `data-testid` when it
    // has no `data-setting-anchor`. A registry `testid` that no longer exists in
    // any panel would SILENTLY degrade the jump to a plain panel switch — the
    // i18n-key checks above cannot catch that. Scan the panel sources, excluding
    // the search/ subtree (it holds the registry itself, whose literals would
    // otherwise let a stale testid match its own declaration).
    const blob = readPanelSources(
      fileURLToPath(new URL("../src/components/settings", import.meta.url)),
    );
    const missing = SETTINGS_SEARCH_INDEX.filter(
      (e) => e.testid && !blob.includes(e.testid),
    ).map((e) => `${e.id} → ${e.testid ?? ""}`);
    expect(missing).toEqual([]);
  });
});

describe("settings search-index — searchSettings behaviour", () => {
  it("finds a Privacy setting by title", () => {
    const ids = searchSettings("screen capture", t).map((e) => e.id);
    expect(ids).toContain("privacy.screen-capture");
  });

  it("finds the theme setting by a keyword not in its title ('dark')", () => {
    const ids = searchSettings("dark", t).map((e) => e.id);
    expect(ids).toContain("appearance.theme");
  });

  it("surfaces panel members by the panel name in the haystack", () => {
    const panels = new Set(searchSettings("appearance", t).map((e) => e.panelId));
    expect(panels).toContain("appearance");
  });

  it("returns [] for a no-match query", () => {
    expect(searchSettings("zzzzznope42", t)).toEqual([]);
  });

  it("returns every entry for an empty query", () => {
    expect(searchSettings("", t).length).toBe(SETTINGS_SEARCH_INDEX.length);
  });
});
