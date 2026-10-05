// Agent-hub suite (myne-md/myne#771 task 17). The deep agent surface is a
// singleton workspace TAB holding ONE screen — the history rail beside the open
// conversation (`decisions/@@ai/0638@@`, amended by `decisions/ai/0637`) — reached
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

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  enableAi,
  enableDeveloperMode,
  runPaletteAction,
  unlockToEditor,
} from "./support/flows";
import { type Session, testIdSelector } from "./support/webdriver";

/** The agent tab's stable DOM handle — the singleton workspace-item key. */
const AGENT_TAB_KEY = "agent:agent";

const TITLE = "ah1noteanchoredq7w2e9r4t1y6u3";

/** Count of agent tabs across every pane. The singleton claim is a COUNT. */
async function agentTabCount(session: Session): Promise<number> {
  const els = await session.findElements(
    testIdSelector("editor.tab", { "data-tab-id": AGENT_TAB_KEY }),
  );
  return els.length;
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
        // migration (`decisions/@@ai/0638@@`).
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
    // write it (`decisions/@@ai/0638@@`, `decisions/ai/0637`).
    let password = "";
    await scenario(
      "ah4-agent-last-view",
      { seed: (dir) => { password = seedVault(dir).password; } },
      async (app) => {
        const s = app.session;
        await readyWithAi(s, password);
        await createNote(s, TITLE);

        // Anchor the tab to the note, then go elsewhere so the reveal is a
        // real reveal rather than a no-op on an already-active tab.
        await runPaletteAction(s, "ai.open-agent-note", "agent");
        await s.byTestId("agent.focus-open-note", { timeoutMs: 15_000 });
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
