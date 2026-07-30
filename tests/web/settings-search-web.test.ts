// The settings search index, on a client with absent capabilities
// (phase3-web-client task 96).
//
// # Why an ungated index is worse here than a stale menu
//
// Matching runs against the STATIC registry, never the rendered DOM — that is
// the registry's whole reason to exist, since panels run IPC on mount and
// mounting all ten to scan their text was rejected. The consequence is that
// search does not know what is on screen: on a client where `backup` is absent
// it happily finds "Back up vault", navigates to Storage, and scrolls to a
// `data-setting-anchor` that was never rendered. The user lands on a panel with
// no setting, no error and nothing to read.
//
// So the filter is not cosmetic parity with the rail — it is the difference
// between an absent feature and a broken one.

import { describe, expect, it, vi } from "vitest";

/** The capability set the web client actually declares as absent. */
const WEB_ABSENT = [
  "clipper",
  "localAi",
  "watchCapture",
  "shareImport",
  "biometricQuickUnlock",
  "osIdleAutoLock",
  "screenCaptureProtection",
  "vaultMigration",
  "backup",
  "nativeSaveAs",
  "vaultCreation",
  "phraseRecovery",
  "vaultExport",
  "spellCheck",
];

async function load(absent: string[]) {
  vi.resetModules();
  vi.doMock("../../src/platform/capabilities", () => ({
    has: (cap: string) => !absent.includes(cap),
  }));
  const index = await import("../../src/components/settings/search/settingsSearchIndex");
  const search = await import("../../src/components/settings/search/searchSettings");
  return { ...index, ...search };
}

const t = (key: string) => key;

describe("the index, filtered by capability", () => {
  // Developer mode ON throughout — these tests are about capability filtering,
  // which is orthogonal to (and unaffected by) the developer-mode gate.
  it("hides every entry whose capability this client lacks", async () => {
    const { visibleSettingsIndex, SETTINGS_SEARCH_INDEX } = await load(WEB_ABSENT);
    const visible = visibleSettingsIndex(true);
    expect(visible.length).toBeLessThan(SETTINGS_SEARCH_INDEX.length);
    for (const e of visible) {
      expect(WEB_ABSENT).not.toContain(e.capability ?? "");
    }
  });

  it("shows everything on a client with every capability", async () => {
    const { visibleSettingsIndex, SETTINGS_SEARCH_INDEX } = await load([]);
    expect(visibleSettingsIndex(true).length).toBe(SETTINGS_SEARCH_INDEX.length);
  });

  it("returns no result for an absent control, searched by its own label", async () => {
    // Searched by the entry's own `titleKey` — with `t` as identity that key IS
    // the haystack, so this is the sharpest available query: if the entry were
    // still in the candidate set, this is exactly what would find it.
    const { SETTINGS_SEARCH_INDEX } = await load([]);
    const { searchSettings } = await load(WEB_ABSENT);
    const gated = SETTINGS_SEARCH_INDEX.filter(
      (e) => e.capability !== undefined && WEB_ABSENT.includes(e.capability),
    );
    expect(gated.length).toBeGreaterThan(5); // the fixture is not empty
    for (const e of gated) {
      const found = searchSettings(e.titleKey, t, true).map((r) => r.id);
      expect(found, `search for ${e.id} (${e.titleKey})`).not.toContain(e.id);
    }
  });

  it("still finds the settings web DOES have", async () => {
    // The filter must not have been achieved by breaking search.
    const { SETTINGS_SEARCH_INDEX } = await load([]);
    const { searchSettings } = await load(WEB_ABSENT);
    const kept = SETTINGS_SEARCH_INDEX.filter((e) => e.capability === undefined);
    for (const e of kept.slice(0, 8)) {
      expect(searchSettings(e.titleKey, t, true).map((r) => r.id), `search for ${e.id}`).toContain(
        e.id,
      );
    }
  });
});

describe("the drift half", () => {
  it("keeps every capability tag pointing at a real capability", async () => {
    // A typo'd tag (`"backups"`) silently makes the entry unconditional again,
    // because `has()` of an unknown name is false only by accident of the set's
    // contents — the entry would be filtered EVERYWHERE, or nowhere, and either
    // way not where it was meant to be.
    const { SETTINGS_SEARCH_INDEX } = await load([]);
    // The REAL module: `load()` mocked `has`, and a mock's `ALL_CAPABILITIES`
    // would make this assertion vacuous rather than wrong.
    const { ALL_CAPABILITIES } = await vi.importActual<
      typeof import("../../src/platform/capabilities")
    >("../../src/platform/capabilities");
    for (const e of SETTINGS_SEARCH_INDEX) {
      if (e.capability !== undefined) {
        expect(ALL_CAPABILITIES, `entry ${e.id}`).toContain(e.capability);
      }
    }
  });

  it("tags every entry whose panel is itself capability-gated", async () => {
    // The `ai` panel is filtered out of the rail entirely (task 27). An `ai.*`
    // entry with no tag would therefore name a panel that does not exist on this
    // client — a navigation into nothing, which is worse than a hidden control.
    const { SETTINGS_SEARCH_INDEX } = await load([]);
    for (const e of SETTINGS_SEARCH_INDEX) {
      if (e.panelId === "ai") expect(e.capability, `entry ${e.id}`).toBe("localAi");
    }
  });
});
