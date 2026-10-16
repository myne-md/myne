// Agent-memory end to end (myne-md/myne#697, task 10). Drives the full
// remember loop on the real tauri-driver harness, against the
// **`local-inference-stub` build variant** (gated on `MYNE_E2E_AI=1` like its
// AI siblings): the stub's task-keyed script answers a task asking to
// "remember this" with one `remember` write plus `finish`
// (`StubEngine::agent_script`), so no model file is needed.
//
//   mem1: send "please remember this for later" → the run settles with NO
//         review screen (a remember-only run proposes no edits, and an empty
//         proposal opens none) → the turn-end marker reports one written
//         entry → the chat popover lists the remembered text → Settings →
//         AI → the memory section lists it → delete it → the empty state
//         returns.
//   mem2: the personality block saves through the settings section and
//         persists across a settings close/reopen (a real IPC write + read
//         through the vault, not a draft echo).
//
// KDF: weak generator fixture (SYNC-9, params are vault.meta-resident).

import { describe, expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  clickBySelector,
  closeSettings,
  createNote,
  dismissImporterOffer,
  enableAi,
  openSettings,
  runPaletteAction,
  selectSettingsTopic,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { testIdSelector } from "./support/webdriver";
import type { Session } from "./support/webdriver";

/** Only run when the binary under test is the AI-feature build. */
const aiDescribe = process.env.MYNE_E2E_AI === "1" ? describeE2E : describe.skip;

/** Open the AI Chat tab and wait for its composer to be ready to send (the
 *  `agent-run.e2e.ts` route: the composer renders only while `ai-chat` is
 *  the active right-pane tab). */
async function openComposer(session: Session): Promise<void> {
  await runPaletteAction(session, "ai.open-chat", "chat");
  await session.waitForElement(testIdSelector("ai.composer"), { timeoutMs: 15_000 });
  // **`ai.composer-scope`, which is the trigger itself** (myne-md/myne#848).
  // This waited on `ai.composer-scope-current`, a caption that no longer exists
  // anywhere in the tree, so every scenario using this helper timed out at 5s
  // inside `openComposer`, which is the failure this comment block records
  // happening once already (myne-md/myne#596). The gate has to be something the
  // composer ALWAYS renders: the count caption would be the stronger claim
  // ("a scope resolved"), but it is absent when the probe fails, and a helper
  // that times out on a failed probe reports the wrong thing entirely.
  await session.waitForElement(testIdSelector("ai.composer-scope"), {
    timeoutMs: 5_000,
  });
}

/** Send one chat task from the composer. */
async function sendTask(session: Session, task: string): Promise<void> {
  const input = await session.byTestId("ai.composer-input");
  await input.click();
  await input.sendKeys(task);
  await (await session.byTestId("ai.composer-send")).click();
}

aiDescribe("mem1 agent run writes memory → marker → popover → settings delete", () => {
  // Vault-count precondition: 1 (weak KDF). Requires the local-inference-stub build.
  it("remembers through a run and deletes through settings", async () => {
    let password = "";
    await scenario(
      "mem1-agent-memory",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "mem1notealfa7k2m9qx4w8e5rj0aa");
        await typeIntoEditor(s, "alpha beta gamma delta");
        await waitForSaved(s);
        await enableAi(s);
        await openComposer(s);

        await sendTask(s, "please remember this for later");

        // ── The run settles with NO review screen. ──
        // A remember-only run proposes no edits, and an empty proposal opens
        // no review (myne-md/myne#568): waiting for the review here would
        // time out on a screen that must never come. The marker is the
        // settle fact instead: it renders only on a settled turn whose host
        // count is positive. **It lives behind the footprint's disclosure now**
        // (myne-md/myne#848) - the settled run's line is one line, and the memory
        // chip is part of the detail it opens - so the disclosure is pressed
        // first. A wait on the marker without it would time out on a screen that
        // is behaving correctly.
        await (await s.byTestId("agentFootprint.disclosure")).click();
        const marker = await s.waitForElement(testIdSelector("agentFootprint.memory"), {
          timeoutMs: 30_000,
        });
        // The marker renders `agent.footprint.memory` with the run's count, whose
        // count-1 plural is `"{{count}} memory saved"` → `"1 memory saved"`
        // (`locales/en/common.json`). The one-write-per-run bound makes the count
        // exactly 1 here, so the copy is asserted whole. (The old marker this
        // replaced rendered `agentTurn.memoryUpdated`, "Memory updated with one
        // entry.", which is what this assertion was written against.)
        expect(await marker.textContent()).toContain("1 memory saved");
        expect(await s.byTestIdAll("agentReview.screen")).toHaveLength(0);

        // ── The chat popover lists the remembered text. ──
        await (await s.byTestId("ai.memory-button")).click();
        await s.waitForElement(testIdSelector("ai.memory-popover"), { timeoutMs: 10_000 });
        const popoverRows = await s.byTestIdAll("ai.memory-popover-row");
        expect(popoverRows.length).toBeGreaterThanOrEqual(1);
        const popoverText = await Promise.all(popoverRows.map((r) => r.textContent()));
        expect(
          popoverText.join("\n"),
          "the popover must show the text the run just wrote",
        ).toContain("terse");
        // Close through the popover's own Close button: the overlay is
        // viewport-capped, so it must be hit-testable (myne-md/myne#697
        // review; the toggle-around this replaced hid the bug instead of
        // proving the control).
        await (await s.byTestId("ai.memory-popover-close")).click();
        await s.waitForGone(testIdSelector("ai.memory-popover"), {
          timeoutMs: 10_000,
        });

        // ── Settings → AI → the memory section lists it; delete it. ──
        await openSettings(s, "ai");
        // Memory and personality live in the AI panel's `advanced` topic since
        // myne-md/myne#885; only the active topic's body is mounted.
        await selectSettingsTopic(s, "ai", "advanced");
        await s.waitForElement(testIdSelector("settings.memory-section"), {
          timeoutMs: 10_000,
        });
        const sectionRows = await s.byTestIdAll("settings.memory.row");
        expect(sectionRows.length).toBeGreaterThanOrEqual(1);
        await (await s.byTestIdAll("settings.memory.delete"))[0].click();
        await s.waitForElement(testIdSelector("settings.memory.empty"), {
          timeoutMs: 10_000,
        });
        await closeSettings(s);

        // ── Clear-all with confirm (task 10): the destructive path needs its
        // own coverage. A second run writes a second entry (the one-write
        // bound is per run), then clear-all with confirm empties the roster.
        await openComposer(s);
        await sendTask(s, "please remember this for later");
        // **Target the SECOND run's disclosure, which is the COLLAPSED one.**
        // The transcript holds one footprint per turn, each with its own
        // disclosure, and `byTestId` returns the FIRST. The block above already
        // opened that first one, so a plain `byTestId(...).click()` here toggles
        // the first run's detail CLOSED while the second run's marker stays
        // behind its own collapsed disclosure, and the wait below times out on a
        // screen that is behaving correctly (measured: 3 of 3 runs). The first
        // run's `aria-expanded` is true and the second's is false, which is what
        // tells the two apart; `clickBySelector` re-finds and re-clicks each poll
        // so a replaced node cannot leave a stale handle behind.
        await clickBySelector(
          s,
          testIdSelector("agentFootprint.disclosure", { "aria-expanded": "false" }),
          { timeoutMs: 15_000 },
        );
        await s.waitForElement(testIdSelector("agentFootprint.memory"), {
          timeoutMs: 30_000,
        });
        await openSettings(s, "ai");
        // Memory and personality live in the AI panel's `advanced` topic since
        // myne-md/myne#885; only the active topic's body is mounted.
        await selectSettingsTopic(s, "ai", "advanced");
        await s.waitForElement(testIdSelector("settings.memory-section"), {
          timeoutMs: 10_000,
        });
        expect((await s.byTestIdAll("settings.memory.row")).length).toBeGreaterThanOrEqual(1);
        await (await s.byTestId("settings.memory.clear-all")).click();
        await (await s.byTestId("settings.memory.clear-confirm")).click();
        await s.waitForElement(testIdSelector("settings.memory.empty"), {
          timeoutMs: 10_000,
        });
        await closeSettings(s);
      },
    );
  });
});

aiDescribe("mem2 personality block saves and persists", () => {
  // Vault-count precondition: 1 (weak KDF). Requires the local-inference-stub build.
  it("writes the voice preferences through settings and reads them back", async () => {
    let password = "";
    await scenario(
      "mem2-agent-personality",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await enableAi(s);

        await openSettings(s, "ai");
        // Memory and personality live in the AI panel's `advanced` topic since
        // myne-md/myne#885; only the active topic's body is mounted.
        await selectSettingsTopic(s, "ai", "advanced");
        await s.waitForElement(testIdSelector("settings.memory-section"), {
          timeoutMs: 10_000,
        });
        const input = await s.byTestId("settings.memory.personality-input");
        await input.click();
        await input.sendKeys("Answer in haiku.");
        await (await s.byTestId("settings.memory.personality-save")).click();
        await closeSettings(s);

        // A close/reopen round-trip: the value must come back from the
        // vault, proving a real write rather than a draft echo.
        await openSettings(s, "ai");
        // Memory and personality live in the AI panel's `advanced` topic since
        // myne-md/myne#885; only the active topic's body is mounted.
        await selectSettingsTopic(s, "ai", "advanced");
        await s.waitForElement(testIdSelector("settings.memory-section"), {
          timeoutMs: 10_000,
        });
        const reopened = await s.byTestId("settings.memory.personality-input");
        expect(await reopened.attribute("value")).toContain("haiku");
        await closeSettings(s);
      },
    );
  });
});
