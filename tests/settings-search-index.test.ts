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
  WRITABILITY_CONTROL,
  WRITABILITY_DEVICE_LOCAL,
  visibleSettingsIndex,
} from "../src/components/settings/search/settingsSearchIndex";
import {
  searchSettings,
  panelLabelKey,
} from "../src/components/settings/search/searchSettings";
import { SETTINGS_PANEL_TOPICS } from "../src/components/settings/settingsTopics";

// The rail panel taxonomy (mirrors SettingsModal.tsx PanelId). Kept local so the
// coverage assertion has an independent list to check the registry against.
const PANEL_IDS = [
  "account",
  "vault",
  "privacy",
  "sync",
  "ai",
  "network",
  // Connections replaced the separate `cli` and `extensions` panels
  // (myne-md/myne#1077): the CLI, the browser clipper and an external MCP client
  // are three sections of one panel.
  "connections",
  "editor",
  "files",
  "transcription",
  "hotkeys",
  "appearance",
  "storage",
  "about",
  // Split out of About on 2026-10-25; it must carry ≥1 entry or the coverage
  // assertion below fails, which is why the list is independent of the registry.
  "diagnostics",
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
    //
    // **This is the CHEAP half and not the guard.** It is a substring test over
    // a blob of every panel source, so it passes for a testid declared anywhere
    // in the tree, which is how `storage.clipper` survived pointing at Storage
    // while its only render site lived in Account (myne-md/myne#885). The guard
    // that catches that class is the RENDER walk in
    // `tests/components/settingsPanelTopics.test.tsx` (the four split panels and
    // the six short ones) plus `AiPanel.test.tsx` and `EditorPanel.test.tsx`,
    // which mount the panel an entry CLAIMS and assert its target is on screen.
    // Kept because it is instant and still catches a testid deleted outright.
    const blob =
      readPanelSources(
        fileURLToPath(new URL("../src/components/settings", import.meta.url)),
      ) +
      // One named file outside the settings tree, not the whole tree: the danger
      // zone's control is rendered by `DeleteVaultConfirmForm`, which moved out of
      // the panel when the section stopped revealing it behind a CTA
      // (myne-md/myne#1020). The entry points at that field because it is the
      // thing the user came to find. Widening the walk instead would soften this
      // into "the testid exists somewhere in `src/`", which is what its own
      // header says it is not.
      `\n${readFileSync(
        fileURLToPath(
          new URL("../src/components/DeleteVaultConfirmForm.tsx", import.meta.url),
        ),
        "utf8",
      )}`;
    const missing = SETTINGS_SEARCH_INDEX.filter(
      (e) => e.testid && !blob.includes(e.testid),
    ).map((e) => `${e.id} → ${e.testid ?? ""}`);
    expect(missing).toEqual([]);
  });

  it("names the topic of every entry whose panel renders a strip (myne-md/myne#885)", () => {
    // The regression the topic field exists to prevent. An inactive topic's body
    // is not mounted, so a hit that resolved to a panel and an anchor but NOT to
    // the topic would leave the user at the top of a tab with no answer:
    // `SettingsModal` switches the rail panel, finds no anchor, and stops. Both
    // directions, because a topic that no roster carries is the same failure
    // wearing a typo, and `topic` is a plain string to the type.
    const missing: string[] = [];
    const unknown: string[] = [];
    for (const entry of SETTINGS_SEARCH_INDEX) {
      const topics = SETTINGS_PANEL_TOPICS[entry.panelId];
      if (topics === undefined) {
        // No strip: a topic here would be stale the moment the panel gained
        // one without the entry being re-read.
        if (entry.topic !== undefined) {
          unknown.push(`${entry.id} → topic ${entry.topic}, but ${entry.panelId} has no strip`);
        }
        continue;
      }
      if (entry.topic === undefined) {
        missing.push(entry.id);
      } else if (!topics.some((topic) => topic.id === entry.topic)) {
        unknown.push(`${entry.id} → ${entry.topic} is in no ${entry.panelId} topic`);
      }
    }
    expect(missing, "entries in a stripped panel with no topic").toEqual([]);
    expect(unknown, "entries naming a topic nothing declares").toEqual([]);
  });
});

describe("settings search-index — searchSettings behaviour", () => {
  // Developer mode ON throughout this describe block: these tests are about
  // the generic scorer/grouping behaviour, not about the developer-mode gate
  // (that has its own describe block below), so the gate is held open.
  it("finds a Privacy setting by title", () => {
    const ids = searchSettings("screen capture", t, true).map((e) => e.id);
    expect(ids).toContain("privacy.screen-capture");
  });

  it("finds the theme setting by a keyword not in its title ('dark')", () => {
    const ids = searchSettings("dark", t, true).map((e) => e.id);
    expect(ids).toContain("appearance.theme");
  });

  it("surfaces panel members by the panel name in the haystack", () => {
    const panels = new Set(searchSettings("appearance", t, true).map((e) => e.panelId));
    expect(panels).toContain("appearance");
  });

  it("returns [] for a no-match query", () => {
    expect(searchSettings("zzzzznope42", t, true)).toEqual([]);
  });

  it("returns every entry for an empty query", () => {
    // Both runtime gates held OPEN (`developerModeEnabled`, `memberVault`), so
    // "every entry" is about the scorer rather than about a gate this suite is
    // not testing here. The member-vault gate has its own block below.
    expect(searchSettings("", t, true, true).length).toBe(SETTINGS_SEARCH_INDEX.length);
  });
});

describe("settings search-index — developer-mode gate (MYND-593)", () => {
  const AI_IDS = ["ai.enable", "ai.auto-tag", "ai.models", "ai.excluded-folders"];

  it("tags every developer-group panel entry as developer-gated", () => {
    // Both members of the rail's Developer group (SettingsModal's PANELS_BASE).
    // An untagged entry would let search navigate into a panel the rail itself
    // refuses to show while Developer mode is off.
    const DEVELOPER_PANELS = ["ai", "network"];
    for (const e of SETTINGS_SEARCH_INDEX) {
      if (DEVELOPER_PANELS.includes(e.panelId)) {
        expect(e.developerGated, `entry ${e.id}`).toBe(true);
      }
    }
  });

  it("mode off: the AI entries are absent from every search, even by exact title", () => {
    for (const id of AI_IDS) {
      const entry = SETTINGS_SEARCH_INDEX.find((e) => e.id === id)!;
      const found = searchSettings(entry.titleKey, t, false).map((r) => r.id);
      expect(found, `search for ${id}`).not.toContain(id);
    }
    // An empty query (list-everything) must also drop them.
    const allIds = searchSettings("", t, false).map((e) => e.id);
    for (const id of AI_IDS) expect(allIds).not.toContain(id);
  });

  it("mode on: the AI entries are found again", () => {
    const allIds = searchSettings("", t, true).map((e) => e.id);
    for (const id of AI_IDS) expect(allIds).toContain(id);
  });

  // #181: the vim toggle is developer-gated while living in a `core` panel —
  // hidden by a panel-internal render condition rather than by the rail
  // dropping the whole panel. A missed tag there leaves search scrolling to an
  // anchor that was never rendered, the exact failure `developerGated` exists
  // to stop, so it is asserted separately from the developer-group entries.
  //
  // The CLI trio was the other entry of that shape until `decisions/ui/0678`
  // moved it into the CLI panel, which sits IN the developer group. It keeps
  // the tag one level up: `searchSettings` reads this index, not the rail, so
  // without it a mode-off search offers three results in a panel the rail is
  // not showing.
  // The CLI trio is no longer developer-gated: Connections is a CORE panel
  // (myne-md/myne#1077), so those rows are gated by their capability alone.
  const SETTING_LEVEL_GATED_IDS = ["editor.vim-mode"];
  const CLI_PANEL_GATED_IDS = [
    "cli.access",
    "cli.excluded-folders",
    "cli.rate-limit",
  ];
  const DEVELOPER_GATED_IDS = [...SETTING_LEVEL_GATED_IDS];

  it("tags the vim entry as developer-gated inside the core panel it renders in", () => {
    for (const id of SETTING_LEVEL_GATED_IDS) {
      const entry = SETTINGS_SEARCH_INDEX.find((e) => e.id === id);
      expect(entry, `entry ${id}`).toBeDefined();
      expect(entry!.developerGated, `entry ${id}`).toBe(true);
      // Still owned by the core panel its control renders in — gating is
      // orthogonal to the rail group, and the whole point of #181's approach
      // is that each setting keeps its topical home.
      expect(entry!.panelId).toBe("editor");
    }
  });

  it("keeps the CLI trio's capability tag AND its developer gate", () => {
    // Two independent axes (`settingsSearchIndex.ts` docstring): a static
    // per-build capability descriptor and a runtime user toggle. Dropping the
    // capability half would make the entries searchable on web, where the
    // section is absent by platform fact rather than by preference; dropping the
    // developer half would offer a result that scrolls into a section the
    // developer gate is not rendering.
    for (const id of CLI_PANEL_GATED_IDS) {
      const entry = SETTINGS_SEARCH_INDEX.find((e) => e.id === id)!;
      expect(entry.capability, `entry ${id}`).toBe("cliAccess");
      // myne-md/myne#1077 moved the three doors into one Connections panel and
      // dropped this flag, on the reading that one panel makes the CLI a normal
      // feature. `decisions/ui/0793` keeps `0678`: the panel is a capability
      // gate, the CLI section inside it is still a developer tool, so both axes
      // stay.
      expect(entry.developerGated, `entry ${id}`).toBe(true);
      expect(entry.panelId, `entry ${id}`).toBe("connections");
    }
  });

  it("mode off: the vim entry is absent from every search, even by exact title", () => {
    for (const id of DEVELOPER_GATED_IDS) {
      const entry = SETTINGS_SEARCH_INDEX.find((e) => e.id === id)!;
      const found = searchSettings(entry.titleKey, t, false).map((r) => r.id);
      expect(found, `search for ${id}`).not.toContain(id);
    }
    const allIds = searchSettings("", t, false).map((e) => e.id);
    for (const id of DEVELOPER_GATED_IDS) expect(allIds).not.toContain(id);
  });

  it("mode on: the CLI and vim entries are found again", () => {
    const allIds = searchSettings("", t, true).map((e) => e.id);
    for (const id of DEVELOPER_GATED_IDS) expect(allIds).toContain(id);
  });

  it("mode off does not hide anything that isn't developer-gated", () => {
    // `memberVault` held open in both arms: this block is about the developer
    // gate, and leaving the OTHER runtime gate closed would make an entry that
    // is not developer-gated read as one the developer toggle hid.
    const withGateOff = new Set(searchSettings("", t, false, true).map((e) => e.id));
    const withGateOn = new Set(searchSettings("", t, true, true).map((e) => e.id));
    const nonGated = SETTINGS_SEARCH_INDEX.filter((e) => !e.developerGated);
    for (const e of nonGated) {
      expect(withGateOff.has(e.id), `${e.id} missing with gate off`).toBe(true);
      expect(withGateOn.has(e.id), `${e.id} missing with gate on`).toBe(true);
    }
  });
});

// The member-vault gate (myne-md/myne#885). The shared-vault-unlock row renders
// only while a B2B member vault is the ACTIVE vault (`MemberPasswordSettings`
// returns `null` on any other vault), so an entry carrying only
// `capability: memberSharing` still navigated to an anchor that was not
// rendered on the ordinary desktop vault. The gate is a runtime per-vault fact,
// the third axis beside the static capability descriptor and the developer
// toggle, and this block proves both directions. The RENDER half lives in
// `tests/components/memberPasswordSettings.test.tsx` (a member vault renders
// the row, a single-account vault renders nothing), so offer and render agree.
describe("settings search-index: member-vault gate (myne-md/myne#885)", () => {
  const ENTRY_ID = "privacy.member-password";

  it("the entry is tagged member-vault-gated and nothing else is", () => {
    const gated = SETTINGS_SEARCH_INDEX.filter((e) => e.memberVaultGated).map((e) => e.id);
    expect(gated).toEqual([ENTRY_ID]);
  });

  it("a member vault offers it, and a single-account vault does not", () => {
    const entry = SETTINGS_SEARCH_INDEX.find((e) => e.id === ENTRY_ID)!;
    // The query is the entry's own ENGLISH title, which is what `t` resolves the
    // key to: the sharpest query there is, because it is exactly the label the
    // row renders. Developer mode is open, so the only gate that can hide it is
    // this one, and the positive arm proves the query is not vacuous.
    const query = t(entry.titleKey);
    expect(query, "the fixture must resolve to a real label").not.toBe(entry.titleKey);
    expect(searchSettings(query, t, true, true).map((r) => r.id)).toContain(ENTRY_ID);
    expect(searchSettings(query, t, true, false).map((r) => r.id)).not.toContain(ENTRY_ID);
    // An empty query (list-everything) follows the same gate.
    expect(searchSettings("", t, true, true).map((e) => e.id)).toContain(ENTRY_ID);
    expect(searchSettings("", t, true, false).map((e) => e.id)).not.toContain(ENTRY_ID);
    expect(visibleSettingsIndex(true, true).map((e) => e.id)).toContain(ENTRY_ID);
    expect(visibleSettingsIndex(true, false).map((e) => e.id)).not.toContain(ENTRY_ID);
  });

  it("the gate defaults closed, so an unresolved vault hides the entry", () => {
    // The safe direction: a caller that has not resolved whether the active vault
    // is shared must hide the entry rather than offer one that does not render.
    expect(visibleSettingsIndex(true).map((e) => e.id)).not.toContain(ENTRY_ID);
  });
});

// The agent-writability verdict (myne-md/myne#850). A setting that reaches the
// tree with no verdict is how an AI or CLI switch becomes agent-writable by
// omission, so the check is structural rather than a list: every entry carries a
// verdict, a refusal says why, and the settings that bound what AI and the CLI
// may reach are refused as CONTROLS rather than for a generic reason. Flipping one
// of them to writable is the change this is here to stop, which is why the third
// assertion names them by id and compares the reason rather than just the verdict.
const AGENT_CONTROL_IDS = [
  "privacy.screen-capture",
  "privacy.auto-lock",
  "cli.access",
  "cli.excluded-folders",
  "cli.rate-limit",
  "ai.enable",
  "ai.excluded-folders",
  "ai.provider",
] as const;

describe("agent writability", () => {
  it("no entry arrives without a verdict", () => {
    const missing = SETTINGS_SEARCH_INDEX.filter((e) => !e.agentWritability).map((e) => e.id);
    expect(missing, "entries with no agent-writability verdict").toEqual([]);
  });

  it("every refusal carries a reason that says something", () => {
    // The placeholder shapes an author writes instead of a reason. `REASON
    // REQUIRED` is named because a seeding tool shipped it once and its own
    // length check passed it.
    const placeholder = /^(todo|tbd|reason required|n\/a|none yet)/i;
    const bad = SETTINGS_SEARCH_INDEX.filter((e) => e.agentWritability.verdict === "refused")
      .map((e) => ({
        id: e.id,
        reason: e.agentWritability.verdict === "refused" ? e.agentWritability.reason.trim() : "",
      }))
      .filter((r) => r.reason.length < 20 || placeholder.test(r.reason))
      .map((r) => r.id);
    expect(bad, "refused entries whose reason is a placeholder or too short").toEqual([]);
  });

  it("the settings that bound what AI and the CLI may reach are refused as controls", () => {
    const byId = new Map(SETTINGS_SEARCH_INDEX.map((e) => [e.id, e.agentWritability]));
    const wrong = AGENT_CONTROL_IDS.filter((id) => {
      const v = byId.get(id);
      // Narrowed rather than compared through the union: `reason` exists on one
      // arm only, so a bare `v.reason` is a type error rather than a check.
      if (v === undefined || v.verdict !== "refused") return true;
      return v.reason !== WRITABILITY_CONTROL.reason;
    });
    expect(wrong, "control settings that are not refused as controls").toEqual([]);
  });

  // ---- the v1 intent roster (myne-md/myne#850 task 4) ---------------------

  it("the writable verdicts are EXACTLY the roster both languages read", async () => {
    // The comparison has to be cross-language: the index DECIDES writability and
    // the Rust intent table ENFORCES it, so neither side can compare itself with
    // the other from inside one language. `scripts/agent-setting-intents.json` is
    // the third thing both read, and this half covers the index. Both directions,
    // because a stale roster entry is as loud a failure as a missing one: it means
    // the agent is offered a setting the table cannot spell, or can spell one it
    // is never offered.
    const roster = (await import("../scripts/agent-setting-intents.json")).default as {
      intents: string[];
    };
    const writableIds = SETTINGS_SEARCH_INDEX.filter(
      (e) => e.agentWritability.verdict === "writable",
    ).map((e) => e.id);
    const onlyIndex = writableIds.filter((id) => !roster.intents.includes(id));
    const onlyRoster = roster.intents.filter((id) => !writableIds.includes(id));
    expect(onlyIndex, "writable in the index but not on the roster").toEqual([]);
    expect(onlyRoster, "on the roster but not writable in the index").toEqual([]);
  });

  it("the per-device display family is refused with its own reason", () => {
    // myne-md/myne#850 task 4's decision. These three are `DeviceLocal`: they
    // sync nothing, so an agent write would land on the machine that ran the
    // agent and nowhere else. They are NOT on the roster above, and the reason
    // distinguishes them from an egress control, because the user's remedy
    // differs.
    for (const id of [
      "appearance.theme",
      "editor.text-size",
      "appearance.show-edit-times",
    ]) {
      const entry = SETTINGS_SEARCH_INDEX.find((e) => e.id === id);
      expect(entry, `${id} must be in the index`).toBeDefined();
      expect(entry?.agentWritability, id).toEqual(WRITABILITY_DEVICE_LOCAL);
    }
  });
});
