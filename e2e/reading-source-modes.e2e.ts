// Reading & Source view modes E2E (reading-source-modes / MYND-299).
//
// Pins the per-tab view-mode flow end-to-end against the production binary:
//   rsm1 — a note tab's bottom-bar view-mode CTA cycles live → reading → source
//          → live (the `data-view-mode` attribute reflects the current mode),
//          AND the side-by-side read-only preview companion opens/closes.
//   rsm2 — Settings → Editor "Default view mode" segmented control persists the
//          chosen default (the `editor_default_view_mode` MYP1 field) — the
//          radio reflects the selection across a re-open of the panel.
//
// Per-tab mode rides the engine-opaque MYW1 descriptor (no envelope change); the
// default rides vault.prefs (MYP1). This drives the real cycle/toggle/persist
// IPC + render path, no test hook.
//
// VERIFICATION STATUS (editor-modes-trio, 2026-06-17): authored to the harness
// conventions but NOT yet run on this dev platform (macOS; the suite is
// Linux/tauri-driver only — `pnpm test:e2e` self-skips off-platform). Definition
// of done per e2e/CLAUDE.md is "green 3× in the container"
// (./scripts/e2e-local.sh) and MUST be met before merge. Run ISOLATED per the
// full-suite-contamination note (e2e-full-suite-contamination memory).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import { createNote, dismissImporterOffer, openSettings, unlockToEditor } from "./support/flows";
import { type Session } from "./support/webdriver";

/** Current view mode reflected on the bottom-bar CTA's `data-view-mode`. */
async function currentViewMode(s: Session): Promise<string | null> {
  return (await s.byTestId("editor.view-mode-cta")).attribute("data-view-mode");
}

describeE2E("rsm1 view-mode CTA cycles + preview companion (reading-source-modes, MYND-299)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("cycles live → reading → source via the bottom-bar CTA and opens the companion", async () => {
    let password = "";
    await scenario(
      "rsm1-view-mode-cycle",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // The view-mode CTA only renders when a note tab is focused — create one.
        await createNote(s, "reading-modes");

        // A fresh tab opens in the default mode (live, the canonical default).
        await s.waitUntil(async () => ((await currentViewMode(s)) === "live" ? true : null), {
          label: "fresh tab opens in live mode",
        });

        // Click the CTA → live → reading.
        await (await s.byTestId("editor.view-mode-cta")).click();
        await s.waitUntil(async () => ((await currentViewMode(s)) === "reading" ? true : null), {
          label: "CTA cycles live → reading",
        });

        // Click again → reading → source.
        await (await s.byTestId("editor.view-mode-cta")).click();
        await s.waitUntil(async () => ((await currentViewMode(s)) === "source" ? true : null), {
          label: "CTA cycles reading → source",
        });

        // In SOURCE mode the bottom-bar preview toggle appears; it opens a
        // side-by-side read-only Reading mirror of the same buffer.
        await s.waitForGone('[data-testid="editor.preview-companion"]');
        await (await s.byTestId("editor.preview-companion-toggle")).click();
        await s.byTestId("editor.preview-companion");

        // Toggle again → the companion closes.
        await (await s.byTestId("editor.preview-companion-toggle")).click();
        await s.waitForGone('[data-testid="editor.preview-companion"]');

        // Click again → source → live (wraps); the preview toggle is source-only,
        // so it disappears once we leave source mode.
        await (await s.byTestId("editor.view-mode-cta")).click();
        await s.waitUntil(async () => ((await currentViewMode(s)) === "live" ? true : null), {
          label: "CTA cycles source → live (wraps)",
        });
        await s.waitForGone('[data-testid="editor.preview-companion-toggle"]');
      },
    );
  });
});

describeE2E("rsm2 default view mode persists in vault.prefs (reading-source-modes, MYND-299)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("Settings → Editor 'Default view mode' selection persists across a panel re-open", async () => {
    let password = "";
    await scenario(
      "rsm2-default-view-mode",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Open Settings → Editor. The default is "live" (canonical default).
        await openSettings(s, "editor");
        const live = await s.byTestId("settings.default-view-mode-live");
        expect(await live.attribute("aria-checked")).toBe("true");

        // Choose "reading" → the radio flips, "live" deselects.
        await (await s.byTestId("settings.default-view-mode-reading")).click();
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("settings.default-view-mode-reading")).attribute(
              "aria-checked",
            )) === "true" || null,
          { label: "reading default selected" },
        );
        expect(
          await (await s.byTestId("settings.default-view-mode-live")).attribute("aria-checked"),
        ).toBe("false");

        // Re-open the panel (navigate away and back) → the choice survived the
        // disk-first persist (editor_default_view_mode === "reading").
        await (await s.byTestId("settings.tab-about")).click();
        await (await s.byTestId("settings.tab-editor")).click();
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("settings.default-view-mode-reading")).attribute(
              "aria-checked",
            )) === "true" || null,
          { label: "reading default persisted across panel re-open" },
        );
      },
    );
  });
});
