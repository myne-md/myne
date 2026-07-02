// AI UX-surface flow suite (ai-ux-surface MYND-408 task 7). Drives the AI
// settings panel + the right-sidebar AI Chat tab on the real tauri-driver
// harness, against the **`local-inference-stub` build variant** (SYNC-5). The
// audited production bundle never enables the AI feature, so this suite runs
// ONLY when the AI-feature binary is under test — gated on `MYNE_E2E_AI=1`
// (see `docs/dev/e2e.md`).
//
//   aux1 — open Settings → AI panel → assert the trust HEADLINE and (expanded)
//          DISCLOSURE by FULL-LITERAL equality against the load-bearing-copy
//          constants (a copy collapse must fail) → toggle `ai_enabled` on →
//          switch the right sidebar to the AI Chat tab → assert AI Chat is the
//          sole active pane (Backlinks no longer active).
//
// The trust copy is public product voice (NOT a credential — SYNC-13 is about
// phrases/passwords), so full-literal assertion is the sanctioned shape for
// load-bearing banner copy (`e2e/CLAUDE.md`). Asserting against the imported
// constant (not a hardcoded string) keeps the suite honest if the copy is
// revised — the constant is the single source both production and this suite read.
//
// KDF: weak generator fixture (SYNC-9 — params are vault.meta-resident).

import { describe, expect, it } from "vitest";
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
import { AI_TRUST_DISCLOSURE, AI_TRUST_HEADLINE } from "../src/lib/load-bearing-copy";

/** Only run when the binary under test is the AI-feature (`local-inference-stub`)
 *  build — the default production bundle has no AI panel/commands, so these
 *  testids never appear there. The feature-flagged build sets `MYNE_E2E_AI=1`. */
const aiDescribe = process.env.MYNE_E2E_AI === "1" ? describeE2E : describe.skip;

/** The id of the currently-active right-panel tab, or null if none (mirrors
 *  `right-panel-active-tab.e2e.ts`). */
async function activeTabId(session: Session): Promise<string | null> {
  const els = await session.byTestIdAll("editor.right-panel-tab");
  for (const e of els) {
    if ((await e.attribute("data-active")) === "true") {
      return await e.attribute("data-panel-tab-id");
    }
  }
  return null;
}

/** Click the right-panel tab `tabId`. */
async function clickTab(session: Session, tabId: string): Promise<void> {
  await (
    await session.waitForElement(
      testIdSelector("editor.right-panel-tab", { "data-panel-tab-id": tabId }),
    )
  ).click();
}

aiDescribe("aux1 AI settings surface + right-sidebar AI Chat tab (ai-ux-surface)", () => {
  // Vault-count precondition: 1 (weak KDF). Requires the local-inference-stub build.
  it("asserts the trust copy by full literal, toggles AI on, and reveals the AI Chat pane", async () => {
    let password = "";
    await scenario(
      "aux1-ai-ux-surface",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "aux1notealfa7k2m9qx4w8e5rj0aa");

        // ── Settings → AI panel: trust copy by FULL LITERAL ──
        await openSettings(s, "ai");
        await s.byTestId("settings.ai-panel");

        // Headline renders the constant verbatim — a collapse fails this.
        const headline = await s.byTestId("ai.trust-headline");
        expect(await headline.textContent()).toBe(AI_TRUST_HEADLINE);

        // Expand the "How does this work?" disclosure, then assert its full text.
        await (await s.byTestId("ai.trust-disclosure-toggle")).click();
        const disclosure = await s.waitForElement(testIdSelector("ai.trust-disclosure"), {
          timeoutMs: 10_000,
        });
        expect(await disclosure.textContent()).toBe(AI_TRUST_DISCLOSURE);

        // ── Toggle ai_enabled on (off by default, SYNC-12) ──
        await (await s.byTestId("ai.enable-toggle")).click();
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("ai.enable-toggle")).attribute("aria-checked")) === "true"
              ? true
              : null,
          { label: "ai_enabled toggled on", timeoutMs: 10_000 },
        );
        await closeSettings(s);

        // ── Right sidebar → AI Chat tab is the sole active pane ──
        await s.byTestId("editor.right-panel-tabs");
        await clickTab(s, "ai-chat");
        await s.waitUntil(
          async () => ((await activeTabId(s)) === "ai-chat" ? true : null),
          { label: "AI Chat becomes the active right-panel tab", timeoutMs: 10_000 },
        );
        // The right panel renders only the ACTIVE tab's body, so the AI Chat body
        // being present ⟺ AI Chat is the visible pane and Backlinks is hidden.
        await s.byTestId("ai.chat-tab");
        expect(await activeTabId(s)).toBe("ai-chat");
      },
    );
  });
});
