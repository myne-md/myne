// Developer-mode gating suite (developer-mode feature, MYND-593). One
// scenario, two states, driving three of the PRD's four enforcement surfaces
// — the settings rail, the settings search index, and the command palette.
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
  openPalette,
  openSettings,
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

        // ── Enable Developer mode from About — immediate effect, no dialog ──
        await openSettings(s, "about");
        await (await s.byTestId("about.developer-mode-toggle")).click();
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("about.developer-mode-toggle")).attribute("aria-checked")) ===
            "true"
              ? true
              : null,
          { label: "developer_mode toggled on", timeoutMs: 10_000 },
        );

        // ── Mode ON: Developer group appears, AI panel reachable ──
        await s.waitForElement(testIdSelector("settings.developer-group"));
        await (await s.byTestId("settings.tab-ai")).click();
        await s.byTestId("settings.ai-panel");

        // The transcription picker is present; enable the AI opt-in (the
        // picker's OWN gate, independent of developer_mode) so "Choose…" is
        // usable rather than merely rendered-but-disabled.
        await s.byTestId("ai.model-select-transcription");
        await (await s.byTestId("ai.enable-toggle")).click();
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("ai.enable-toggle")).attribute("aria-checked")) === "true"
              ? true
              : null,
          { label: "ai_enabled toggled on", timeoutMs: 10_000 },
        );
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
