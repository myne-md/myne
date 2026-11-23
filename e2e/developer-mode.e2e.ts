// Developer-mode gating suite (developer-mode feature, MYND-593; extended by
// #181). Two scenarios, each two states, driving three of the PRD's four
// enforcement surfaces — the settings rail, the settings search index, and the
// command palette.
// The fourth surface, the Rust host-side gate (effective-enabled conjunction,
// transcription fallthrough, model-path rejection), is Rust-unit-tested in
// task 4 instead — faster, deterministic, and it needs no WebView to be
// meaningful (see the PRD's "Testing Decisions").
//
// This scenario is the designated replacement for the deleted
// `ai-labs-beta.e2e.ts`: that file's whole premise (an unconditionally-visible
// AI tab under a "Labs" rail group with a "Beta" badge) no longer exists —
// the AI panel now lives behind the Developer group, off by default.
//
//   dm1 — mode OFF: no Developer group in the rail, no AI settings tab, a
//         settings search for an AI-only term returns nothing, and the AI
//         command-palette actions are absent. Then enables the mode from
//         About and asserts: the Developer group appears, the AI panel is
//         reachable, the transcription model picker is present and usable
//         (AI opt-in on, the picker's "Choose…" control enabled), the
//         settings search surfaces the AI entry again, and the AI palette
//         actions reappear.
//
//   dm2 — the SETTING-level half of the same gate (#181): the Vim toggle in
//         Editor is hidden while the mode is off even though its panel is not,
//         and it comes back with the mode. Distinct story from dm1: dm1 proves
//         a whole rail GROUP appears and disappears, dm2 proves an individual
//         setting inside a CORE panel does — the panel stays visible
//         throughout, which is exactly what makes this a gate the rail filter
//         cannot express.
//
//         The CLI trio was dm2's other half until `decisions/ui/0678` moved it
//         out of Privacy into a developer-group panel of its own, which is
//         dm1's shape rather than dm2's. dm2 now asserts that move rather than
//         assuming it: the rail entry and the block appear and disappear
//         TOGETHER with the mode, so a future re-shuffle that left one of the
//         two behind fails here.
//
//         What dm2 does NOT cover, because the proof lives where the machinery
//         does: that hiding is not disabling. The CLI half is `cli6` (it needs
//         the command-socket harness) and the vim half is `vm4` (it needs a
//         mounted editor). Both are the acceptance criterion most likely to
//         regress silently, so neither is folded in here.
//
// Stays entirely inside the Settings modal / command palette and never opens
// a note — no CodeMirror pane mount, the suite's dominant flake source.
//
// AUTHORED ON A NON-HARNESS HOST (macOS) — pending green-3× verification on
// the Linux tauri-driver container (the e2e DoD; `./scripts/e2e-one.sh
// developer-mode`).
//
// KDF: weak generator fixture (SYNC-9 — params are vault.meta-resident).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  closeSettings,
  dismissImporterOffer,
  enableDeveloperMode,
  openPalette,
  openSettings,
  selectSettingsTopic,
  unlockToEditor,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

/** A query that ONLY matches the AI-enable settings entry's keyword string
 *  ("local ai on off enable disable machine learning") — chosen specifically
 *  so it cannot accidentally hit an unrelated, non-gated entry. */
const AI_ONLY_QUERY = "machine learning";

/** Type `text` into the Settings search box (sending keys focuses it first,
 *  same helper shape as `settings-search.e2e.ts`). */
async function typeSearch(session: Session, text: string): Promise<void> {
  await (await session.byTestId("settings.search-input")).replaceText(text);
}

/** Queries that only match the #181-gated entries, chosen the same way
 *  {@link AI_ONLY_QUERY} was — a hit cannot come from an unrelated non-gated
 *  entry.
 *
 *  The CLI query has to satisfy TWO properties at once, and the obvious
 *  distinctive-phrase pick satisfies only one: it must match NOTHING outside the
 *  gate (so the mode-OFF `not.toContain` assertions mean something) AND match
 *  ALL THREE gated CLI rows (so the mode-ON `toContain` assertions can pass).
 *  `"command line shell"` was CLI-only but appears verbatim in just
 *  `settings.search.keywords.cliAccess` — the excluded-folders and rate-limit
 *  rows never carried the word "shell", so the ON half of this scenario asserted
 *  something the index could not produce. `"terminal"` is the token those three
 *  keyword strings actually share, and it appears in no other entry's title,
 *  description or keywords. The panel those rows now live in is a
 *  developer-group rail entry (`decisions/ui/0678`), so a hit while the mode is
 *  off is doubly wrong: the anchor is not rendered AND the panel is not in the
 *  rail. */
const CLI_ONLY_QUERY = "terminal";
const VIM_ONLY_QUERY = "modal editing";

/** Type `query` into the Settings search box and return the `data-setting-id`
 *  of every rendered result row. Reads the ids rather than asserting an empty
 *  result list: the #181 entries live in panels that keep matching other,
 *  ungated settings, so "no results at all" is the wrong assertion here. */
async function searchResultIds(session: Session, query: string): Promise<string[]> {
  await typeSearch(session, query);
  const rows = await session.byTestIdAll("settings.search-result");
  const ids: string[] = [];
  for (const row of rows) {
    const id = await row.attribute("data-setting-id");
    if (id !== null && id !== "") ids.push(id);
  }
  return ids;
}

/** Open the command palette, type `query`, and return the `data-action-id`
 *  of every currently-rendered row (command-row filtering runs off a
 *  synchronous `useMemo`, not the debounced note search, so no settle-wait is
 *  needed between typing and reading). Closes the palette (Escape) before
 *  returning so the caller starts the next step fresh. */
async function paletteActionIds(session: Session, query: string): Promise<string[]> {
  await openPalette(session);
  await (await session.byTestId("palette.input")).sendKeys(query);
  const rows = await session.byTestIdAll("palette.option");
  const ids: string[] = [];
  for (const row of rows) {
    const id = await row.attribute("data-action-id");
    if (id !== null && id !== "") ids.push(id);
  }
  await (await session.byTestId("palette.input")).sendKeys(""); // Escape (W3C code point)
  await session.waitForGone(testIdSelector("palette.input"));
  return ids;
}

describeE2E("dm1 developer-mode gating: rail + search + palette (MYND-593)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("closes all three surfaces while off, opens them after enabling from About", async () => {
    let password = "";
    await scenario(
      "dm1-developer-mode-gating",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // ── Mode OFF: rail — no Developer group, no AI tab ──
        await openSettings(s);
        expect((await s.byTestIdAll("settings.developer-group")).length).toBe(0);
        expect((await s.byTestIdAll("settings.tab-ai")).length).toBe(0);

        // ── Mode OFF: settings search yields nothing for an AI-only term ──
        await typeSearch(s, AI_ONLY_QUERY);
        await s.byTestId("settings.search-empty");
        expect((await s.byTestIdAll("settings.search-result")).length).toBe(0);
        await closeSettings(s);

        // ── Mode OFF: the AI command-palette actions are absent ──
        // (Two of the five: the other three additionally require a selected
        // note, and opening one would mount the editor pane — out of scope
        // per this scenario's own "never mounts the editor" rule. All five
        // share the identical `!ctx.prefs.developer_mode → "hidden"` clause
        // in `src/commands/actions.ts`, so these two are representative.)
        const offIds = await paletteActionIds(s, "ai");
        expect(offIds.includes("ai.toggle-enabled")).toBe(false);
        expect(offIds.includes("ai.open-chat")).toBe(false);

        // ── Mode ON: enable from About, Developer group appears, AI reachable ──
        await enableDeveloperMode(s);
        await (await s.byTestId("settings.tab-ai")).click();
        await s.byTestId("settings.ai-panel");

        // The transcription picker is in the Models topic, and the AI opt-in is in
        // Answering (the panel's first topic) since myne-md/myne#885.
        await selectSettingsTopic(s, "ai", "models");
        await s.byTestId("ai.model-select-transcription");
        await selectSettingsTopic(s, "ai", "answering");
        await (await s.byTestId("ai.enable-toggle")).click();
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("ai.enable-toggle")).attribute("aria-checked")) === "true"
              ? true
              : null,
          { label: "ai_enabled toggled on", timeoutMs: 10_000 },
        );
        await selectSettingsTopic(s, "ai", "models");
        const chooseTranscription = await s.byTestId("ai.model-choose-transcription");
        expect(await chooseTranscription.attribute("disabled")).toBeNull();
        await closeSettings(s);

        // ── Mode ON: settings search surfaces the AI entry again ──
        await openSettings(s);
        await typeSearch(s, AI_ONLY_QUERY);
        const row = await s.waitForElement(
          testIdSelector("settings.search-result", { "data-setting-id": "ai.enable" }),
        );
        if ((await row.attribute("data-panel")) !== "ai") {
          throw new Error("ai.enable result is not tagged with the ai panel");
        }
        await closeSettings(s);

        // ── Mode ON: the AI palette actions reappear ──
        const onIds = await paletteActionIds(s, "ai");
        expect(onIds.includes("ai.toggle-enabled")).toBe(true);
        expect(onIds.includes("ai.open-chat")).toBe(true);
      },
    );
  });
});

describeE2E("dm2 setting-level developer gating: vim toggle + the CLI panel (#181)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("hides the vim toggle inside a panel that stays visible, takes the CLI panel out of the rail, and restores both", async () => {
    let password = "";
    await scenario(
      "dm2-setting-level-gating",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        await openSettings(s, "privacy");
        // Privacy itself is present — that is the whole point of a setting-level
        // gate, and it is what distinguishes this from dm1. Anchored on an
        // ungated neighbour rather than a panel root, because PrivacyPanel's
        // root carries no testid of its own. That neighbour lives in Privacy's
        // `locking` topic (myne-md/myne#885), so the topic is opened for it.
        await selectSettingsTopic(s, "privacy", "locking");
        await s.byTestId("settings.auto-lock-select");
        // The CLI rows are NOT here any more: they moved into a panel of their
        // own, so their absence from Privacy is structural rather than gated.
        expect((await s.byTestIdAll("settings.cli-access")).length).toBe(0);
        // The door's own panel is a CAPABILITY gate since myne-md/myne#1077 (it
        // also hosts the browser clipper), so the tab is there either way; what
        // the developer gate removes is the CLI body inside it, asserted above
        // and again here after opening the panel.
        await (await s.byTestId("settings.tab-connections")).click();
        await s.byTestId("settings.connections");
        expect((await s.byTestIdAll("settings.cli-access")).length).toBe(0);

        await (await s.byTestId("settings.tab-editor")).click();
        await selectSettingsTopic(s, "editor", "editing");
        await s.byTestId("settings.section.editor-editing");
        expect((await s.byTestIdAll("settings.vim-mode")).length).toBe(0);

        // ── Mode OFF: search finds none of the four ──
        // A result here would scroll to an anchor that was never rendered —
        // the exact failure `developerGated` exists to prevent.
        const cliOff = await searchResultIds(s, CLI_ONLY_QUERY);
        expect(cliOff).not.toContain("cli.access");
        expect(cliOff).not.toContain("cli.excluded-folders");
        expect(cliOff).not.toContain("cli.rate-limit");
        const vimOff = await searchResultIds(s, VIM_ONLY_QUERY);
        expect(vimOff).not.toContain("editor.vim-mode");
        await closeSettings(s);

        // ── Mode OFF: the vim palette action is absent ──
        // Settings hiding the toggle while a keystroke could still flip it
        // would make the gate decorative.
        expect((await paletteActionIds(s, "vim")).includes("editor.toggle-vim-mode")).toBe(
          false,
        );

        // ── Mode ON ──
        await enableDeveloperMode(s);

        // The CLI section comes back, inside the Connections panel.
        await (await s.byTestId("settings.tab-connections")).click();
        await s.byTestId("settings.cli-access");
        await s.byTestId("settings.cli-exclusions");
        await s.byTestId("settings.cli-rate-limit");

        await (await s.byTestId("settings.tab-editor")).click();
        await selectSettingsTopic(s, "editor", "editing");
        await s.byTestId("settings.vim-mode");

        const cliOn = await searchResultIds(s, CLI_ONLY_QUERY);
        expect(cliOn).toContain("cli.access");
        expect(cliOn).toContain("cli.excluded-folders");
        expect(cliOn).toContain("cli.rate-limit");
        const vimOn = await searchResultIds(s, VIM_ONLY_QUERY);
        expect(vimOn).toContain("editor.vim-mode");
        await closeSettings(s);

        expect((await paletteActionIds(s, "vim")).includes("editor.toggle-vim-mode")).toBe(true);
      },
    );
  });
});
