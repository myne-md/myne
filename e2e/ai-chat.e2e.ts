// Conversational AI chat flow suite (conversational-ai-chat MYND-454, task 14).
// Drives the end-to-end streaming chat surface through the `ai.*` testids on the
// real tauri-driver harness, against the **`local-inference-stub` build variant**
// (the deterministic `StubEngine` — no model file in the repo; SYNC-5). The
// audited production bundle never enables that feature, so this suite runs ONLY
// when the AI-feature binary is under test — gated on `MYNE_E2E_AI=1`, which the
// feature-flagged build sets (see `docs/dev/e2e.md`).
//
//   ac1 — enable AI → open the AI Chat tab → send a message → a streamed
//         assistant turn appears in the transcript → a follow-up appends another
//         exchange (multi-turn) → lock + re-unlock clears the transcript
//         (RAM-only, dropped on lock).
//
// The stub engine returns deterministic `stub-infer: …` output over the token
// `Channel`, so the transcript is assertable without shipping a model. The hard
// no-egress guarantee is the Rust gate (`ai-no-network-check.sh`); this
// behavioral suite asserts the flow completes locally (no error state).
//
// Notes on coverage: the streaming CARET and the STOP control are covered by the
// Vitest component tests (AiChatTab) — the stub streams too fast to reliably
// catch a mid-stream Stop here. CITATIONS depend on embedded-note retrieval
// (embed-on-unlock over the stub's zero-vectors); this suite asserts the core
// send → stream → follow-up → lock-clears path, which is deterministic.
//
// KDF: weak generator fixture (SYNC-9 — params are vault.meta-resident).

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
 *  build — the default production bundle has no AI commands, so these testids
 *  never appear there. The feature-flagged build sets `MYNE_E2E_AI=1`. */
const aiDescribe = process.env.MYNE_E2E_AI === "1" ? describeE2E : describe.skip;

/** Wait for the run's review screen and close it.
 *
 *  Every message is a run since `docs/decisions/ai/0524`, so a proposal takes
 *  the screen after each send and the composer is unreachable until it goes.
 *  `ag6` in `agent-run.e2e.ts` does the same thing for the same reason. */
async function dismissRunProposal(s: Session): Promise<void> {
  await s.waitForElement(testIdSelector("agentReview.screen"), { timeoutMs: 30_000 });
  await (await s.byTestId("agentReview.close")).click();
  await s.waitForGone(testIdSelector("agentReview.screen"), { timeoutMs: 10_000 });
}

aiDescribe("ac1 conversational AI chat → stream → follow-up → lock clears", () => {
  // Vault-count precondition: 1 (weak KDF). Requires the local-inference-stub build.
  it("streams a chat answer, remembers a follow-up, and wipes the transcript on lock", async () => {
    let password = "";
    await scenario(
      "ac1-ai-chat",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "ac1notealfa7k2m9qx4w8e5rj0aa");
        await typeIntoEditor(s, "The mitochondria is the powerhouse of the cell.");
        await waitForSaved(s);

        // Turn AI on (off by default, SYNC-12) and reveal the AI Chat tab.
        await enableAi(s);
        await runPaletteAction(s, "ai.open-chat", "chat");

        // Send the first message via the composer (click the Send button — never
        // a synthetic Enter keystroke, which carries invisible-char footguns).
        //
        // The composer sends on Enter now too, and this scenario deliberately
        // does not rely on that: `Element.sendKeys` posts exactly the string it
        // is given and appends nothing (`support/webdriver.ts`), so the click
        // below is the only thing that sends. A scenario that WANTS Enter writes
        // `` itself, the way `notes.e2e.ts` does.
        const composer = await s.byTestId("ai.composer-input", { timeoutMs: 10_000 });
        await composer.sendKeys("what is this note about?");
        await (await s.byTestId("ai.composer-send")).click();

        // **A question is a RUN now, so the send opens the review screen over the
        // composer.** `docs/decisions/ai/0524` removed the Ask/Edit split: every
        // message goes through the agent loop, the stub proposes for any task,
        // and the proposal takes the screen. This scenario is about the
        // transcript and the lock, not about reviewing a proposal (`ag1` and
        // `ag3` are), so it closes the screen the way `ag6` does — and it has to,
        // or the follow-up below clicks a Send button behind a modal.
        await dismissRunProposal(s);

        // The transcript appears with a user turn + an assistant turn.
        await s.waitForElement(testIdSelector("ai.transcript"), { timeoutMs: 15_000 });
        await s.waitUntil(
          async () => ((await s.byTestIdAll("ai.turn")).length >= 2 ? true : null),
          { label: "user + assistant turns present", timeoutMs: 15_000 },
        );
        const turns = await s.byTestIdAll("ai.turn");
        expect(turns.length).toBe(2);
        expect(await turns[0]!.attribute("data-role")).toBe("user");
        expect(await turns[1]!.attribute("data-role")).toBe("assistant");
        // **The stub's deterministic marker, in the shape the run produces it.**
        // This used to look for the plain echo `stub-infer:`, which is what the
        // engine answers a NON-agent chat with — and after `0524` there is no
        // such chat, so the marker could never appear again and the scenario
        // timed out on it. A run ends by finishing with a summary, the stub's is
        // the fixed string below, and it reaches the transcript only if the loop
        // actually ran and streamed back. Same property, current architecture.
        await s.waitUntil(
          async () =>
            (await (await s.byTestIdAll("ai.turn"))[1]!.textContent()).includes("stub run")
              ? true
              : null,
          { label: "assistant turn carries the stub run's summary", timeoutMs: 15_000 },
        );
        // No error state on the happy path.
        expect((await s.byTestIdAll("ai.turn-error")).length).toBe(0);

        // Follow-up: a second message appends another exchange (multi-turn).
        const composer2 = await s.byTestId("ai.composer-input");
        await composer2.sendKeys("say more");
        await (await s.byTestId("ai.composer-send")).click();
        await dismissRunProposal(s);
        await s.waitUntil(
          async () => ((await s.byTestIdAll("ai.turn")).length >= 4 ? true : null),
          { label: "follow-up appended a second exchange", timeoutMs: 15_000 },
        );
        // Exactly four, not "at least four": a lower bound cannot fail on a
        // double send, which is the thing the comment above is about.
        expect((await s.byTestIdAll("ai.turn")).length).toBe(4);

        // Lock the vault → the RAM-only transcript is dropped. Re-unlock and
        // reveal the tab: the transcript is gone (fresh conversation).
        await (await s.byTestId("editor.lock-cta")).click();
        const pw = await s.byTestId("unlock.password-input", { timeoutMs: 15_000 });
        await pw.sendKeys(password);
        await (await s.byTestId("unlock.submit")).click();
        // Second editor mount: the importer offer is a FRESH-VAULT overlay and does
        // not re-appear after a lock -> unlock on a vault that already has notes —
        // `dismissImporterOfferIfPresent`'s own doc says so, and the hard variant
        // times out waiting for something that is deliberately absent.
        await dismissImporterOfferIfPresent(s);
        await runPaletteAction(s, "ai.open-chat", "chat");
        // Transcript cleared on lock (task 12): no turns, no transcript region.
        await s.waitUntil(
          async () => ((await s.byTestIdAll("ai.turn")).length === 0 ? true : null),
          { label: "transcript cleared after lock", timeoutMs: 15_000 },
        );
        expect((await s.byTestIdAll("ai.turn")).length).toBe(0);
      },
    );
  });
});
