// AI chat history: persist across lock, read-only proposal, delete everywhere
// (myne-md/myne#675, task 14).
//
// Drives the shared-tree history surface through the `ai.*` testids on the
// real tauri-driver harness, against the **`local-inference-stub` build
// variant** like `ai-chat.e2e.ts` (gated on `MYNE_E2E_AI=1` for the same
// reason). One flow:
//
//   ch1: send a message (the stub proposes anchored edits) → the settled
//         turn persists → lock + re-unlock CONTINUES the conversation (the
//         pre-persistence build cleared it; `ai-chat.e2e.ts` ac1 pinned the
//         old shape and was updated with this change) → the history list
//         shows the conversation → the frozen proposal renders read-only
//         (anchors visible, no apply/insert affordance) → delete with
//         confirm → gone, list empty.
//
// # What the stub can and cannot reach
//
// The stub proposes one anchored edit per eligible body line and finishes
// with a summary, so the frozen proposal (anchors + replacements verbatim)
// is reachable without a model. What is NOT reachable is a second device, so
// sync arrival is not asserted here. The merge rule is unit- and
// vector-covered (`conflict.rs`, `chats-merge`), and the tombstone half
// is the delete assertion below (row gone, list empty).
//
// KDF: weak generator fixture (SYNC-9: params are vault.meta-resident).

import { describe, expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  dismissImporterOfferIfPresent,
  enableAi,
  runPaletteAction,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

/** Only run when the binary under test is the AI-feature (`local-inference-stub`)
 *  build: same gate as `ai-chat.e2e.ts`. */
const aiDescribe = process.env.MYNE_E2E_AI === "1" ? describeE2E : describe.skip;

/** Wait for the run's review screen and close it (the `ai-chat.e2e.ts`
 *  pattern: every message is a run, so a proposal takes the screen and the
 *  composer is unreachable until it goes). */
async function dismissRunProposal(s: Session): Promise<void> {
  await s.waitForElement(testIdSelector("agentReview.screen"), { timeoutMs: 30_000 });
  // The card's exit is Reject all (myne-md/myne#894): the × was the one
  // control that only dismissed the proposal, and rejecting everything IS
  // dismissing it.
  await (await s.byTestId("agentReview.rejectAll")).click();
  await s.waitForGone(testIdSelector("agentReview.screen"), { timeoutMs: 10_000 });
}

aiDescribe("ch1 AI chat history persists across lock, then deletes everywhere", () => {
  // Vault-count precondition: 1 (weak KDF). Requires the local-inference-stub build.
  it("sends, locks, continues, shows the frozen proposal read-only, and deletes", async () => {
    let password = "";
    await scenario(
      "ch1-chat-history",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "ch1notealfa7k2m9qx4w8e5rj0aa");
        // TWO lines, deliberately (the `agent-run.e2e.ts` ag1 discipline):
        // the stub proposes one edit per eligible body line, so the settled
        // turn carries a frozen proposal with anchors copied out of this note.
        await typeIntoEditor(s, "alpha beta gamma delta\nepsilon zeta eta theta");
        await waitForSaved(s);
        await enableAi(s);
        await runPaletteAction(s, "ai.open-chat", "chat");

        // Send: the run settles, the review takes the screen, dismiss it.
        const composer = await s.byTestId("ai.composer-input", { timeoutMs: 10_000 });
        await composer.sendKeys("tidy this note");
        await (await s.byTestId("ai.composer-send")).click();
        await dismissRunProposal(s);
        await s.waitUntil(
          async () => ((await s.byTestIdAll("ai.turn")).length >= 2 ? true : null),
          { label: "user + assistant turns present", timeoutMs: 15_000 },
        );
        expect((await s.byTestIdAll("ai.turn")).length).toBe(2);
        expect((await s.byTestIdAll("ai.turn-error")).length).toBe(0);

        // The roster lists the conversation under the derived title (first
        // 48 chars of the first user turn).
        await (await s.byTestId("ai.history-button")).click();
        await s.waitForElement(testIdSelector("ai.conversation-list"), { timeoutMs: 10_000 });
        const rows = await s.byTestIdAll("ai.conversation-row");
        expect(rows.length).toBe(1);
        expect(await rows[0]!.textContent()).toContain("tidy this note");
        // Close the modal by opening the active row (the modal's own rule:
        // opening the active conversation dismisses).
        await (await s.byTestId("ai.conversation-open")).click();
        await s.waitForGone(testIdSelector("ai.conversation-list"), { timeoutMs: 10_000 });

        // Lock + re-unlock CONTINUES the conversation (myne-md/myne#675 Q9):
        // the transcript still holds both turns, not a fresh tab.
        await (await s.byTestId("editor.lock-cta")).click();
        const pw = await s.byTestId("unlock.password-input", { timeoutMs: 15_000 });
        await pw.sendKeys(password);
        await (await s.byTestId("unlock.submit")).click();
        await dismissImporterOfferIfPresent(s);
        await runPaletteAction(s, "ai.open-chat", "chat");
        await s.waitUntil(
          async () => ((await s.byTestIdAll("ai.turn")).length === 2 ? true : null),
          { label: "transcript continued after lock", timeoutMs: 15_000 },
        );
        expect((await s.byTestIdAll("ai.turn")).length).toBe(2);

        // The frozen proposal is reachable only through the turn's diff icon,
        // and the modal is read-only: anchors visible, and NO write
        // affordance. An `ai.insert-turn` control or any apply button would
        // be a re-apply path for a proposal quoting a note that may since
        // have changed.
        await s.waitForElement(testIdSelector("ai.turn-diff"), { timeoutMs: 10_000 });
        await (await s.byTestId("ai.turn-diff")).click();
        await s.waitForElement(testIdSelector("ai.proposal-diff-body"), { timeoutMs: 10_000 });
        const proposalText = (await (await s.byTestId("ai.proposal-diff-body")).textContent()) ?? "";
        expect(
          proposalText,
          "the frozen proposal shows the anchor text it was settled with",
        ).toContain("alpha beta gamma delta");
        expect(await s.byTestIdAll("ai.insert-turn")).toHaveLength(0);
        const buttonsInProposal = await s.execute<number>(
          "return document.querySelectorAll('[data-testid=\"ai.proposal-diff-body\"] button:not([data-testid=\"ai.proposal-diff-close\"])').length;",
        );
        expect(
          buttonsInProposal,
          "no write button inside the frozen proposal modal (read-only means read-only)",
        ).toBe(0);
        await (await s.byTestId("ai.proposal-diff-close")).click();
        await s.waitForGone(testIdSelector("ai.proposal-diff-body"), { timeoutMs: 10_000 });

        // Delete with confirm: the row goes away and the list empties.
        await (await s.byTestId("ai.history-button")).click();
        await s.waitForElement(testIdSelector("ai.conversation-list"), { timeoutMs: 10_000 });
        await (await s.byTestId("ai.conversation-delete")).click();
        await (await s.byTestId("ai.conversation-delete-confirm")).click();
        await s.waitForElement(testIdSelector("ai.history-empty"), { timeoutMs: 10_000 });
        expect(await s.byTestIdAll("ai.conversation-row")).toHaveLength(0);
      },
    );
  });
});
