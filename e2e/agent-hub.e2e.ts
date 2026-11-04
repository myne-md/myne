// Agent-hub suite (myne-md/myne#771 task 17). The deep agent surface is a
// singleton workspace TAB holding ONE screen — the history rail beside the open
// conversation (`decisions/ai/0634`, amended by `decisions/ai/0637`) — reached
// from the palette, from the ribbon and from the light panel's one exit
// control. This pins that contract through the REAL editor UI:
//
//   ah1 — "Agent: open on vault" opens the agent as a singleton tab, with the
//         history rail AND the conversation both on screen; re-firing reveals
//         it rather than opening a second one.
//   ah2 — "Agent: open on note" lands the SAME tab on that note's conversation,
//         with the note one click away.
//   ah3 — the light panel's focus control reaches the same place, which is the
//         panel-to-deep-surface exit the depth pair rests on.
//   ah4 — the tab remembers WHICH CONVERSATION it was left on across a reveal,
//         which is the whole reason there is no second preference for it.
//
// Why the tab contract rather than a run: an agent run needs a provider that
// answers, and `e2e/ai-chat.e2e.ts` already owns the run path against the fake
// Ollama. What this file owns is the SURFACE — that the thing exists, is a
// singleton, shows both columns, and remembers the conversation you left it on.
//
// Both gates are opened in every scenario, and in this order: `developer_mode`
// decides whether the `ai.*` actions are VISIBLE at all, `ai_enabled` decides
// whether they are invokable rather than disabled. Opening only the first finds
// the palette entry and cannot press it, which reads as a broken action.
//
// KDF: weak generator fixture (SYNC-9 — params are vault.meta-resident).

import { describe, expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  contextMenuPick,
  createNote,
  dismissImporterOffer,
  enableAi,
  enableDeveloperMode,
  runPaletteAction,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { type Session, testIdSelector } from "./support/webdriver";

/** The agent tab's stable DOM handle — the singleton workspace-item key. */
const AGENT_TAB_KEY = "agent:agent";

/**
 * The AI-lane gate, defined here the way `agent-run.e2e.ts` and `ai-chat.e2e.ts`
 * define it: scenarios that need a model to ANSWER are skipped unless the lane
 * asks for them, because the default lane's reruns must not depend on one.
 * `ah5` is such a scenario for a structural reason (see its own comment): a
 * conversation card only exists once a conversation does, and a conversation is
 * written when a run settles.
 */
const aiDescribe = process.env.MYNE_E2E_AI === "1" ? describeE2E : describe.skip;

/** One message, then the review screen it raises closed again.
 *
 *  **The stub proposes where it has an ANCHOR, not for any task**, which the
 *  scenario has to supply: its script reads the note body out of the framed turn
 *  and proposes one edit per eligible line, and a note holding only frontmatter
 *  leaves it silent — the run settles with an empty proposal and no review screen
 *  opens. `agent-run` and `ai-chat` type a line into their notes for the same
 *  reason. It DOES propose for a vault-general run too, once its scope listing has
 *  led it to read a note, which is what lets `ah5`'s second conversation settle. */
async function sendAndDismiss(s: Session, message: string): Promise<void> {
  const composer = await s.byTestId("ai.composer-input", { timeoutMs: 15_000 });
  await composer.sendKeys(message);
  // **Send has to ARM first, and on this surface that is the only gate there is.**
  // The anchored Focus view PINS its scope and renders no picker
  // (`ConversationSurface`), so the readiness gate the panel's callers use
  // (`ai.composer-scope`, see `agent-run.e2e.ts::openComposer`) does not exist
  // here — measured: `ai.composer-scope` absent and `send.disabled === true` for the
  // first ~seconds after the pane appears. Clicking into that window is a no-op, and
  // the run then never starts: `ah5` waited out its whole review-screen budget on a
  // Send that had never been armed.
  const send = await s.byTestId("ai.composer-send");
  await s.waitUntil(() => send.enabled(), {
    label: "the agent composer's Send to arm",
    timeoutMs: 20_000,
  });
  await send.click();
  await s.waitForElement(testIdSelector("agentReview.screen"), { timeoutMs: 30_000 });
  // The card's exit is Reject all (myne-md/myne#894): the × was the one
  // control that only dismissed the proposal, and rejecting everything IS
  // dismissing it.
  await (await s.byTestId("agentReview.rejectAll")).click();
  await s.waitForGone(testIdSelector("agentReview.screen"), { timeoutMs: 10_000 });
}

const TITLE = "ah1noteanchoredq7w2e9r4t1y6u3";

/** Count of agent tabs across every pane. The singleton claim is a COUNT. */
async function agentTabCount(session: Session): Promise<number> {
  const els = await session.findElements(
    testIdSelector("editor.tab", { "data-tab-id": AGENT_TAB_KEY }),
  );
  return els.length;
}

/**
 * Pin the agent tab through its own tab menu, so that a palette "open a view"
 * afterwards APPENDS a tab instead of reusing (and so closing) the agent's slot
 * (`openInFocusedTab`'s pin-aware arm, tab-modes / MYND-320).
 *
 * The same two steps `tab-modes.e2e.ts` uses: right-click the tab, click the
 * menu's Pin item. Doing it through the menu rather than by writing the
 * workspace blob keeps the scenario on production UI.
 */
async function pinAgentTab(s: Session): Promise<void> {
  const tab = await s.waitForElement(
    testIdSelector("editor.tab", { "data-tab-id": AGENT_TAB_KEY }),
    { timeoutMs: 15_000 },
  );
  // Through the shared helper rather than a private two-step: it re-fires the
  // right-click while polling for its item, which is what a menu whose first
  // synthetic right-click dispatched nothing needs (measured 2026-11-03 on this
  // very tab: the same handler served a note tab's menu fine).
  await contextMenuPick(s, tab, "tab.pin");
  await s.waitUntil(
    async () => ((await tab.attribute("data-pinned")) === "true" ? true : null),
    { label: "the agent tab reports pinned", timeoutMs: 10_000 },
  );
}

/** Unlock, clear the importer offer, and open both AI gates. */
async function readyWithAi(session: Session, password: string): Promise<void> {
  await unlockToEditor(session, password);
  await dismissImporterOffer(session);
  await enableDeveloperMode(session);
  await enableAi(session);
}

describeE2E("ah1 the agent opens as a singleton tab, rail and conversation both", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("the palette's vault verb opens it; re-firing reveals, never duplicates", async () => {
    let password = "";
    await scenario(
      "ah1-agent-hub",
      { seed: (dir) => { password = seedVault(dir).password; } },
      async (app) => {
        const s = app.session;
        await readyWithAi(s, password);

        await runPaletteAction(s, "ai.open-agent-vault", "agent");

        const tab = await s.waitForElement(
          testIdSelector("editor.tab", { "data-tab-id": AGENT_TAB_KEY }),
          { timeoutMs: 15_000 },
        );
        expect(await tab.attribute("data-active")).toBe("true");
        await s.byTestId("agent.pane", { timeoutMs: 15_000 });
        // BOTH columns, which is the whole of what changed: the history rail
        // beside the conversation rather than a list you navigate out of
        // (`decisions/ai/0637`). A scenario asserting only one of them would
        // pass against either shape.
        await s.byTestId("agent.rail", { timeoutMs: 15_000 });
        await s.byTestId("agent.focus", { timeoutMs: 15_000 });
        // A seeded vault has no conversations, so the rail lands on its
        // first-run empty state — which carries the control that starts one.
        await s.byTestId("agent.hub-empty", { timeoutMs: 15_000 });
        await s.byTestId("agent.hub-new", { timeoutMs: 15_000 });
        expect(await agentTabCount(s)).toBe(1);

        // Re-fire: the agent is a workspace-wide singleton, so this reveals the
        // existing tab rather than opening a second.
        await runPaletteAction(s, "ai.open-agent-vault", "agent");
        await s.waitUntil(
          async () => ((await agentTabCount(s)) === 1 ? true : null),
          { label: "agent tab stays a singleton after re-fire", timeoutMs: 15_000 },
        );
      },
    );
  });
});

describeE2E("ah2 the note verb lands the same tab on that note's conversation", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("open-on-note anchors the conversation, and keeps the rail beside it", async () => {
    let password = "";
    await scenario(
      "ah2-agent-focus",
      { seed: (dir) => { password = seedVault(dir).password; } },
      async (app) => {
        const s = app.session;
        await readyWithAi(s, password);
        await createNote(s, TITLE);

        await runPaletteAction(s, "ai.open-agent-note", "agent");
        await s.byTestId("agent.pane", { timeoutMs: 15_000 });
        await s.byTestId("agent.focus", { timeoutMs: 15_000 });
        // The note it is about is one click away, and the rail stays beside it:
        // there is no view to have switched to.
        await s.byTestId("agent.focus-open-note", { timeoutMs: 15_000 });
        await s.byTestId("agent.rail", { timeoutMs: 15_000 });
        // ONE tab, not two: the two verbs open one singleton on two subjects,
        // which is the property that makes "open the agent" mean the same thing
        // whichever door was used.
        expect(await agentTabCount(s)).toBe(1);
        // And no back control, because the thing it would go back to is on
        // screen. Asserting its ABSENCE is what keeps the old shape from
        // returning unnoticed.
        expect((await s.byTestIdAll("agent.focus-back")).length).toBe(0);
      },
    );
  });
});

describeE2E("ah3 the light panel's exit reaches the deep surface", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("focus-agent from the AI panel opens the agent tab in focus", async () => {
    // The panel-to-deep-surface exit. The panel is a SIBLING subtree of the
    // workspace controller, so this is the one flow where "the callback is
    // threaded" is the entire risk — and it is invisible to every other check:
    // the button renders, `tsc` is content, and a control that does nothing
    // looks exactly like one that works.
    let password = "";
    await scenario(
      "ah3-panel-exit",
      { seed: (dir) => { password = seedVault(dir).password; } },
      async (app) => {
        const s = app.session;
        await readyWithAi(s, password);
        await createNote(s, TITLE);

        // Reach the panel through its own tab, then its exit control.
        await runPaletteAction(s, "ai.open-chat", "chat");
        const focusAgent = await s.byTestId("ai.focus-agent", { timeoutMs: 15_000 });
        await focusAgent.click();

        await s.byTestId("agent.pane", { timeoutMs: 15_000 });
        await s.byTestId("agent.focus", { timeoutMs: 15_000 });
        await s.byTestId("agent.focus-open-note", { timeoutMs: 15_000 });
        // The panel is NOT retired by the tab: it keeps its place in the right
        // panel's vocabulary, and the two are a depth pair rather than a
        // migration (`decisions/ai/0634`).
        expect((await s.byTestIdAll("ai.focus-agent")).length).toBeGreaterThan(0);
      },
    );
  });
});

describeE2E("ah4 the tab remembers which conversation it was left on", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("a reveal keeps the anchored conversation, not a default", async () => {
    // The "last-used" behaviour, and the reason no preference records it:
    // revealing an open tab keeps its `agentView`, so the memory IS the tab.
    // A second record of one fact would be wrong after any path that did not
    // write it (`decisions/ai/0634`, `decisions/ai/0637`).
    let password = "";
    await scenario(
      "ah4-agent-last-view",
      { seed: (dir) => { password = seedVault(dir).password; } },
      async (app) => {
        const s = app.session;
        await readyWithAi(s, password);
        await createNote(s, TITLE);

        await runPaletteAction(s, "ai.open-agent-note", "agent");
        await s.byTestId("agent.focus-open-note", { timeoutMs: 15_000 });
        // **PINNED before leaving, and that is not decoration.** A palette "open a
        // view" reuses the focused pane's ACTIVE SLOT, so `graph.show` on an
        // unpinned agent tab REPLACES it: the tab leaves the strip, and the later
        // reveal then opens a FRESH agent tab whose conversation has no note at
        // all. That is what this scenario measured before the pin was added (the
        // anchor was gone, `agent.focus-open-note` with it), and the scenario's
        // premise was what was wrong rather than the reveal: a pinned tab
        // suppresses the reuse path, so the graph is APPENDED and the agent tab
        // survives to be revealed.
        await pinAgentTab(s);
        await runPaletteAction(s, "graph.show", "graph");
        await s.byTestId("editor.graph-pane", { timeoutMs: 15_000 });

        // Come back through the VAULT verb, which is the one the ribbon entry
        // runs. It reveals, and the reveal keeps the subject: the note link is
        // still there rather than the tab having reset to a fresh chat.
        await runPaletteAction(s, "ai.open-agent-vault", "agent");
        await s.byTestId("agent.focus-open-note", { timeoutMs: 15_000 });
        expect(await agentTabCount(s)).toBe(1);
      },
    );
  });
});

aiDescribe("ah5 a conversation card is one target with its own controls", () => {
  // myne-md/myne#848. The row WAS a title plus two always-visible icon buttons,
  // so a list of titles read as a list of controls and the two destructive ones
  // were the widest thing on every line. Now the whole card opens the
  // conversation, one icon states what the conversation is about, and rename and
  // delete live behind a menu that appears when you point at the card or reach
  // it with the keyboard.
  //
  // **Under the AI gate, and that is a correction rather than a convenience**
  // (review finding): the rail renders a card per row of `chatsList`, and a
  // conversation row is written when a run settles. This scenario used to claim
  // that opening the agent on a note created that conversation, waited for a card
  // that could never appear, and then asserted the at-rest opacity of a card on a
  // vault that has none. Two runs are what make two cards, and only the second
  // one's card is at rest.
  // Vault-count precondition: 1 (weak KDF). Requires the local-inference-stub build.
  it("opens from the card body, states its target, and reveals its actions on hover", async () => {
    let password = "";
    await scenario(
      "ah5-agent-card",
      { seed: (dir) => { password = seedVault(dir).password; } },
      async (app) => {
        const s = app.session;
        await readyWithAi(s, password);
        await createNote(s, TITLE);
        // A BODY, and it is the stub's requirement rather than the scenario's
        // subject: `createNote` leaves a note holding nothing but its frontmatter,
        // and the fixture engine's script derives its anchors from the body, so on
        // an empty note it answers nothing at all. The run then settles with an
        // EMPTY proposal, which opens no review screen, and `sendAndDismiss` waits
        // out its budget on a screen that was never coming. `agent-run` and
        // `ai-chat` type a line for exactly this reason.
        await typeIntoEditor(s, "a line the fixture engine can anchor on");
        await waitForSaved(s);
        await runPaletteAction(s, "ai.open-agent-note", "agent");
        await s.byTestId("agent.pane", { timeoutMs: 15_000 });

        // A note-anchored conversation: the pane was opened FROM the note, so the
        // row this run writes carries `note_id`.
        await sendAndDismiss(s, "what is this note about?");

        // A second, vault-general conversation, so the first card is no longer
        // the OPEN one. The rail's own new-conversation control clears the pane
        // without persisting anything, so the second row comes from the send that
        // follows it.
        await (await s.byTestId("agent.hub-new")).click();
        await sendAndDismiss(s, "and the vault as a whole?");

        // Newest first, so the note-anchored card is the LAST of the two.
        const cards = await s.byTestIdAll("agent.hub-card");
        expect(cards.length).toBe(2);
        const card = cards[cards.length - 1]!;

        // The target is stated as a glyph AND as an accessible name, so the fact
        // is not in the icon alone.
        const target = await s.waitForElement(
          testIdSelector("agent.hub-target", { "data-target": "note" }),
          { timeoutMs: 10_000 },
        );
        expect((await target.attribute("aria-label")) ?? "").not.toBe("");

        // The controls are present but invisible at rest on a card that is not
        // the open one and has no run in flight. Every query here is the LAST
        // match, for the same reason the card is.
        const lastActions = async () => {
          const all = await s.byTestIdAll("agent.hub-row-actions");
          return all[all.length - 1]!;
        };
        expect(await (await lastActions()).attribute("style")).toContain("opacity: 0");

        // Point at the card: the cluster is revealed, and the menu opens from it.
        await card.hover();
        await s.waitUntil(
          async () =>
            (await (await lastActions()).attribute("style"))?.includes("opacity: 1")
              ? true
              : null,
          { label: "hover reveals the card's actions", timeoutMs: 10_000 },
        );
        const menus = await s.byTestIdAll("agent.hub-menu");
        await menus[menus.length - 1]!.click();
        await s.waitForElement(testIdSelector("agent.hub-menu-list"), { timeoutMs: 10_000 });
        await s.byTestId("agent.hub-rename");
        await s.byTestId("agent.hub-delete");
      },
    );
  });
});
