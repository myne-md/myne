// AI UX-surface flow suite (ai-ux-surface MYND-408 task 7). Drives the AI
// settings panel + the right-sidebar AI Chat tab on the real tauri-driver
// harness, against the **`local-inference-stub` build variant** — gated on
// `MYNE_E2E_AI=1` (see `docs/dev/e2e.md`).
//
// AI now ships in the DEFAULT build (decisions.md 2026-07-02), so the AI panel +
// commands DO exist in the production bundle; the pure-UI surface (Labs group,
// Beta badge, no-model state) is covered UNGATED in `ai-labs-beta.e2e.ts`. This
// suite stays gated because it needs the STUB engine for deterministic
// inference-adjacent behaviour without a real model file in the repo.
//
//   aux1 — open Settings → AI panel → assert the trust HEADLINE and (expanded)
//          DISCLOSURE by FULL-LITERAL equality against the load-bearing-copy
//          constants (a copy collapse must fail) → toggle `ai_enabled` on →
//          switch the right sidebar to the AI Chat tab → assert AI Chat is the
//          sole active pane (Backlinks no longer active).
//
// The trust copy is public product voice (NOT a credential — SYNC-13 is about
// phrases/passwords), so full-literal assertion is the sanctioned shape for
// load-bearing banner copy (`e2e/AGENTS.md`). Asserting against the imported
// constant (not a hardcoded string) keeps the suite honest if the copy is
// revised — the constant is the single source both production and this suite read.
//
// KDF: weak generator fixture (SYNC-9 — params are vault.meta-resident).

import { describe, expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  clickNewItem,
  closeSettings,
  createNote,
  dismissImporterOffer,
  enableDeveloperMode,
  excludeFolderFromAi,
  unlockToEditor,
} from "./support/flows";
import { type Session, testIdSelector } from "./support/webdriver";
import {
  aiTrustDisclosure,
  aiTrustHeadline,
} from "../src/lib/load-bearing-copy";

// The E2E vault names no provider and stores no endpoint, so the panel is in
// its in-process state. Still compared by FULL literal, not substring.
const IN_PROCESS = { kind: "in-process" } as const;

/** Only run against the `local-inference-stub` build (sets `MYNE_E2E_AI=1`),
 *  which swaps in the deterministic StubEngine so inference-adjacent behaviour
 *  is stable without a model file. The AI panel/commands themselves now ship in
 *  the default bundle too (decisions.md 2026-07-02) — their pure-UI checks live
 *  ungated in `ai-labs-beta.e2e.ts`; this suite is the stub-only slice. */
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
        // The AI tab lives behind Developer mode and does not exist without it:
        // `developer-mode.e2e.ts:137` asserts `settings.tab-ai` has length 0
        // before enabling. This spec used `openSettings(s, "ai")`, which CLICKS
        // that tab — so it waited its full budget and threw, which is exactly
        // how it was failing in CI. `ai-degradation.e2e.ts` already had the
        // right order; this one was never updated when the panel moved behind
        // the toggle.
        //
        // Go straight to the tab rather than through `openSettings`:
        // `enableDeveloperMode` leaves the modal OPEN on About by design, so
        // re-clicking `editor.settings-cta` would fight an open modal.
        await enableDeveloperMode(s);
        await (await s.byTestId("settings.tab-ai")).click();
        await s.byTestId("settings.ai-panel");

        // Headline renders the constant verbatim — a collapse fails this.
        const headline = await s.byTestId("ai.trust-headline");
        expect(await headline.textContent()).toBe(aiTrustHeadline(IN_PROCESS));

        // Expand the "How does this work?" disclosure, then assert its full text.
        await (await s.byTestId("ai.trust-disclosure-toggle")).click();
        const disclosure = await s.waitForElement(testIdSelector("ai.trust-disclosure"), {
          timeoutMs: 10_000,
        });
        expect(await disclosure.textContent()).toBe(aiTrustDisclosure(IN_PROCESS));

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

/** Create a folder via the sidebar's inline new-folder input. The trailing `\uE007`
 *  (W3C Enter) commits it, else `notes.folder-row` never materializes, the same
 *  helper `folder-archive.e2e.ts` carries locally. */
async function createFolder(s: Session, name: string): Promise<void> {
  await clickNewItem(s, "notes.new-folder");
  await (await s.byTestId("notes.new-folder-input")).sendKeys(`${name}\uE007`);
  await s.byTestId("notes.folder-row");
}

describeE2E("aux2 the excluded-folders picker writes the list the AI honors", () => {
  // myne-md/myne#848. The list is the control `docs/threat-model.md` A17 rests its
  // remote-provider mitigation on, and it gained a picker: the box stays the
  // authority (a pasted list still works, and an egress control must not require
  // a picker), while the common case stops being a hand-typed path that does not
  // match the folder it names.
  //
  // **The dropdown half is asserted here; the append handler itself is pinned by
  // `tests/components/AiPanel.test.tsx`**, which drives the real handler and
  // asserts both that the box gains the line and that the setter fired. Two
  // layers, because a scenario can prove the control is reachable and a component
  // test can prove what it does.
  // Vault-count precondition: 1 (weak KDF). Requires the local-inference-stub build.
  it("offers the vault's folders, appends the picked one, and commits it", async () => {
    let password = "";
    await scenario(
      "aux2-excluded-picker",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        // **The AI panel is a Developer-group panel** (myne-md/myne#848): without
        // this the `settings.tab-ai` click waits its full budget and throws, which
        // is exactly how `aux1` was failing before it gained the same line.
        await enableDeveloperMode(s);
        // **And the modal it leaves open covers the sidebar.** `enableDeveloperMode`
        // deliberately leaves Settings OPEN on About, so the create buttons behind
        // its backdrop are in the DOM and not hit-testable: `createNote` below used
        // to spend its whole budget on `waitUntil(element interactable + clicked)`
        // with `notes.create` present the entire time, which is why this scenario
        // never ran. Close it before driving anything in the sidebar.
        await closeSettings(s);
        await createNote(s, "aux2notealfa7k2m9qx4w8e5rj0aa");
        await createFolder(s, "Private");

        // With a folder in the vault the picker is offered; with none it is
        // omitted rather than disabled (the omit-don't-disable posture), which is
        // the state a fresh vault shows. The flow itself lives in
        // `excludeFolderFromAi` (it opens Settings on the AI tab and closes it
        // again), shared with `ai-chat.e2e.ts` ac2, so the two scenarios cannot
        // describe the control differently.
        await excludeFolderFromAi(s, "Private/");
      },
    );
  });
});
