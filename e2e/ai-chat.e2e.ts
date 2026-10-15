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
//         exchange (multi-turn) → lock + re-unlock CONTINUES the transcript
//         (persisted conversations, myne-md/myne#675 Q9; this tail used to
//         pin the RAM-only wipe and was updated with that change; the delete
//         half lives in `chat-history.e2e.ts` ch1).
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

aiDescribe("ac1 conversational AI chat → stream → follow-up → lock keeps", () => {
  // Vault-count precondition: 1 (weak KDF). Requires the local-inference-stub build.
  it("streams a chat answer, remembers a follow-up, and continues the transcript on lock", async () => {
    let password = "";
    await scenario(
      "ac1-ai-chat",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        // **A note the fixture engine's reply names** (myne-md/myne#867), seeded
        // FIRST so the note below stays the one the editor is on.
        //
        // The mention link only exists where an answer names a note the vault
        // holds, and the stub's finished summary is the FIXED string `stub run`
        // So the vault has to hold a note by that name for the answer to name
        // one. The scenario is therefore coupled to that string on purpose: if
        // the stub's summary is reworded, this fails by name rather than
        // quietly asserting that no mention ever appears.
        await createNote(s, "stub run");
        await typeIntoEditor(s, "Notes about the fixture engine.");
        await waitForSaved(s);

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

        // ── The note mention opens the note (myne-md/myne#867) ────────────
        // The answer's text is `stub run`, the vault holds a note by that
        // name, so the name is a link rather than prose, and pressing it
        // opens THAT note. Asserted on the assistant turn, which is where the
        // desktop puts a mention: a user's own words stay plain text
        // (`ConversationSurface` renders them as `pre-wrap` on purpose), so a
        // link there would be a second, different surface.
        const mentions = await s.findElements('[data-testid="ai.mention-link"]');
        expect(mentions.length).toBeGreaterThan(0);
        expect((await mentions[0]!.textContent()).trim()).toBe("stub run");
        await mentions[0]!.click();
        // `openMention` is `ws.openNewTabInFocused`, so the note becomes the
        // ACTIVE tab, the one signal that says the press reached the
        // workspace rather than only the link's own styling.
        await s.waitUntil(
          async () => {
            for (const tab of await s.byTestIdAll("editor.tab")) {
              if ((await tab.attribute("data-active")) !== "true") continue;
              if ((await tab.textContent()).includes("stub run")) return true;
            }
            return null;
          },
          { label: "the mentioned note to become the active tab", timeoutMs: 10_000 },
        );

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

        // Lock the vault → re-unlock CONTINUES the transcript (persisted
        // conversations, myne-md/myne#675 Q9 (the tab continues the last
        // conversation by derived recency.) This tail used to pin the
        // RAM-only wipe; the delete half lives in `chat-history.e2e.ts` ch1.
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
        // Transcript continued after lock: both exchanges still here.
        await s.waitUntil(
          async () => ((await s.byTestIdAll("ai.turn")).length === 4 ? true : null),
          { label: "transcript continued after lock", timeoutMs: 15_000 },
        );
        expect((await s.byTestIdAll("ai.turn")).length).toBe(4);
      },
    );
  });
});

aiDescribe("ac2 the composer refuses a keystroke when there is nothing in scope", () => {
  // myne-md/myne#848. A new conversation now starts on the whole vault, so the
  // only state with no scope at all is a vault the resolution empties: no notes,
  // or every note inside an excluded folder. The host's own preview answers
  // "zero" a step before `start_run` refuses with `EmptyGrant`, which is what
  // lets the field refuse the KEYSTROKE rather than the send.
  //
  // Asserted structurally (the outline attribute and the disabled field) rather
  // than on the copy: the sentence lives in the catalog and the component tests
  // pin its key, so an E2E assertion on English wording would be a second place
  // to update for a copy change.
  it("disables the field and outlines the scope control on an empty vault", async () => {
    let password = "";
    await scenario(
      "ac2-blocked-scope",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        // NO note is created, which is the precondition the scenario is about.
        await enableAi(s);
        await runPaletteAction(s, "ai.open-chat", "chat");

        await s.waitForElement(testIdSelector("ai.composer-input"), { timeoutMs: 15_000 });
        await s.waitUntil(
          async () =>
            (await (
              await s.byTestId("ai.composer-scope-wrap")
            ).attribute("data-blocked")) === "true"
              ? true
              : null,
          { label: "the scope control reports an empty scope", timeoutMs: 20_000 },
        );
        const input = await s.byTestId("ai.composer-input");
        expect(await input.attribute("disabled")).not.toBeNull();
        // And no line under the field: the highlight and the refusal are the
        // whole message, so a warning paragraph reappearing here is a regression.
        expect((await s.byTestIdAll("ai.composer-needs-scope")).length).toBe(0);
      },
    );
  });
});

aiDescribe("ac3 the run's footprint is one line in the transcript", () => {
  // myne-md/myne#848. The figures used to live in a strip pinned under the
  // transcript; they are now a disclosure on the run's own turn, which is what
  // makes them survive scrolling and navigation.
  it("copies a turn's words, and says which way it went", async () => {
    let password = "";
    await scenario(
      "ac4-turn-copy",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "ac4notealfa7k2m9qx4w8e5rj0aa");
        await typeIntoEditor(s, "The mitochondria is the powerhouse of the cell.");
        await waitForSaved(s);
        await enableAi(s);
        await runPaletteAction(s, "ai.open-chat", "chat");

        const composer = await s.byTestId("ai.composer-input", { timeoutMs: 10_000 });
        await composer.sendKeys("summarize this note");
        await (await s.byTestId("ai.composer-send")).click();
        await dismissRunProposal(s);

        // **The USER's turn is the deterministic half** (myne-md/myne#848). The
        // stub may answer with a proposal and no words of its own, so the
        // ANSWER's copy control is conditional, while what the user typed is
        // always there, and it is the same control either way.
        const userCopy = await s.findElement(
          `${testIdSelector("ai.turn", { "data-role": "user" })} ${testIdSelector("ai.turn-copy")}`,
        );
        // The control names WHAT it copies, so it is not a bare glyph whose
        // meaning the user has to guess.
        expect(await userCopy.attribute("aria-label")).toBe("Copy your message");
        await userCopy.click();
        // The outcome is reported ON the control, the `inline-icon` arm of
        // `lib/clipboard.ts`. "Copied" means the write resolved through the
        // platform seam; "Could not copy" means it did not, and a failed copy
        // that looked like a successful one is the exact defect that module
        // exists to prevent. The clipboard is NOT read back: the WebView holds
        // no clipboard READ grant, deliberately (myne#379).
        await s.waitUntil(
          async () =>
            (await userCopy.attribute("aria-label")) === "Copied" ? true : null,
          { label: "the copy reports success on the control", timeoutMs: 10_000 },
        );
      },
    );
  });

  it("reports the run on its turn, and reveals the figures when asked", async () => {
    let password = "";
    await scenario(
      "ac3-run-footprint",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "ac3notealfa7k2m9qx4w8e5rj0aa");
        await typeIntoEditor(s, "The mitochondria is the powerhouse of the cell.");
        await waitForSaved(s);
        await enableAi(s);
        await runPaletteAction(s, "ai.open-chat", "chat");

        const composer = await s.byTestId("ai.composer-input", { timeoutMs: 10_000 });
        await composer.sendKeys("summarize this note");
        await (await s.byTestId("ai.composer-send")).click();
        await dismissRunProposal(s);

        // The line is on the turn, INSIDE the scrolling transcript.
        const scroller = await s.byTestId("ai.transcript");
        await s.waitForElement(testIdSelector("agentFootprint"), { timeoutMs: 20_000 });
        const footprint = await s.byTestId("agentFootprint");
        expect(await footprint.attribute("data-settled")).toBe("true");
        // The figures are NOT on the line until it is opened.
        expect((await s.byTestIdAll("agentFootprint.runCost")).length).toBe(0);
        await (await s.byTestId("agentFootprint.disclosure")).click();
        await s.waitForElement(testIdSelector("agentFootprint.runCost"), {
          timeoutMs: 10_000,
        });
        void scroller;
      },
    );
  });
});
