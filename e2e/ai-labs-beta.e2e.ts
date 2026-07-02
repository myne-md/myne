// AI Labs/Beta surface suite (local-ai epic, ai-ux-surface MYND-408;
// decisions.md 2026-07-02 "Ship local AI in the default build behind a runtime
// beta opt-in").
//
// Unlike `ai-ux-surface.e2e.ts` (which needs the `local-inference-stub` build
// for deterministic INFERENCE output and is gated on `MYNE_E2E_AI=1`), this
// suite asserts pure UI that ships in the DEFAULT production bundle now that AI
// is default-on: the Settings → Labs rail group, the "Beta" badge, and the
// "no model selected" ready-state that a normal user hits before side-loading a
// model. So it runs UNGATED, against the same default `target/release/myne-desktop`
// the rest of the E2E suite drives — no stub build, no model file required (the
// no-model state IS the natural default).
//
//   alb1 — Settings → AI lives under a "Labs" rail group and carries a Beta
//          badge; enabling it with no model side-loaded surfaces the
//          "no model selected" state in the AI Chat tab (not a false "Ready").
//
// Vault-count precondition: 1 (weak KDF — params are vault.meta-resident).
// SYNC-13: note title is an in-source scenario constant (residue needle rule).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  closeSettings,
  createNote,
  dismissImporterOffer,
  openSettings,
  unlockToEditor,
} from "./support/flows";
import { type Session, testIdSelector } from "./support/webdriver";

/** Click the right-panel tab `tabId` (mirrors ai-ux-surface.e2e.ts). */
async function clickTab(session: Session, tabId: string): Promise<void> {
  await (
    await session.waitForElement(
      testIdSelector("editor.right-panel-tab", { "data-panel-tab-id": tabId }),
    )
  ).click();
}

describeE2E("alb1 AI Labs group + Beta badge + no-model state (ai-ux-surface)", () => {
  // Vault-count precondition: 1 (weak KDF). Runs on the DEFAULT build (AI is
  // compiled in; no model side-loaded).
  it("shows AI under Labs with a Beta badge and a no-model state when enabled", async () => {
    let password = "";
    await scenario(
      "alb1-ai-labs-beta",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "albnotealpha7k2m9qx4w8e5rj0aa");

        // ── Settings → AI panel sits under the Labs rail group ──
        await openSettings(s, "ai");
        // The Labs divider is rendered in the rail regardless of active panel.
        await s.byTestId("settings.labs-group");
        await s.byTestId("settings.ai-panel");
        // Beta badge on the panel header.
        await s.byTestId("ai.beta-badge");

        // ── Enable AI with no model side-loaded → "no model" ready-state ──
        await (await s.byTestId("ai.enable-toggle")).click();
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("ai.enable-toggle")).attribute("aria-checked")) === "true"
              ? true
              : null,
          { label: "ai_enabled toggled on", timeoutMs: 10_000 },
        );
        await closeSettings(s);

        // Right sidebar → AI Chat tab: the status must be the no-model hint, not
        // a misleading "Ready" (the engine is compiled but has no model file).
        await s.byTestId("editor.right-panel-tabs");
        await clickTab(s, "ai-chat");
        await s.byTestId("ai.chat-tab");
        const noModelHint = await s.waitForElement(testIdSelector("ai.status-no-model"), {
          timeoutMs: 10_000,
        });
        expect(await noModelHint.textContent()).not.toBe("");
        // The status chip reflects the same signal.
        const status = await s.byTestId("ai.chrome-status");
        expect(await status.attribute("data-ai-model-ready")).toBe("false");
      },
    );
  });
});
