// Agent-hub suite (myne-md/myne#771 task 17). The deep agent surface is a
// singleton workspace TAB with two views (`decisions/ai/0620`), reached from
// the palette, from the ribbon and from the light panel's one exit control.
// This pins that contract through the REAL editor UI:
//
//   ah1 — "Agent: open on vault" opens the agent as a singleton tab in the HUB
//         view; re-firing reveals it rather than opening a second one.
//   ah2 — "Agent: open on note" lands the SAME tab in the FOCUS view on the
//         open note, and the back control returns it to the hub.
//   ah3 — the light panel's focus control reaches the same place, which is the
//         panel-to-deep-surface exit the depth pair rests on.
//   ah4 — the ribbon entry reveals the tab in the view it was LAST left on,
//         which is the whole reason there is no second preference for it.
//
// Why the tab contract rather than a run: an agent run needs a provider that
// answers, and `e2e/ai-chat.e2e.ts` already owns the run path against the fake
// Ollama. What this file owns is the SURFACE — that the thing exists, is a
// singleton, and remembers which of its two views you left it on.
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

/** Which view the agent pane is currently showing, or null if it is not open. */
async function agentView(session: Session): Promise<string | null> {
  const el = (await session.byTestIdAll("agent.pane")).at(0) ?? null;
  return el === null ? null : await el.attribute("data-agent-view");
}

describeE2E("ah1 the agent opens as a singleton tab in the hub view", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("the palette's vault verb opens the hub; re-firing reveals, never duplicates", async () => {
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
        expect(await agentView(s)).toBe("hub");
        // A seeded vault has no conversations, so the hub lands on its
        // first-run empty state rather than a list. That is the state a new
        // user meets, which makes it the one worth pinning.
        await s.byTestId("agent.hub-empty", { timeoutMs: 15_000 });
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

describeE2E("ah2 the note verb lands the same tab in focus, and back returns", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("open-on-note opens FOCUS on the open note; the back control returns to the hub", async () => {
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
        expect(await agentView(s)).toBe("focus");
        // ONE tab, not two: the two verbs are two views of one singleton, which
        // is the property that makes "open the agent" mean the same thing
        // whichever door was used.
        expect(await agentTabCount(s)).toBe(1);

        const back = await s.byTestId("agent.focus-back", { timeoutMs: 15_000 });
        await back.click();
        await s.waitUntil(
          async () => ((await agentView(s)) === "hub" ? true : null),
          { label: "the back control returns the tab to the hub", timeoutMs: 15_000 },
        );
        expect(await agentTabCount(s)).toBe(1);
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
        await s.waitUntil(
          async () => ((await agentView(s)) === "focus" ? true : null),
          { label: "the panel's exit lands in focus", timeoutMs: 15_000 },
        );
        // The panel is NOT retired by the tab: it keeps its place in the right
        // panel's vocabulary, and the two are a depth pair rather than a
        // migration (`decisions/ai/0620`).
        expect((await s.byTestIdAll("ai.focus-agent")).length).toBeGreaterThan(0);
      },
    );
  });
});

describeE2E("ah4 the ribbon entry reveals the view the tab was left on", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("a tab left in focus comes back in focus", async () => {
    // The "last-used view" behaviour, and the reason no preference records it:
    // revealing an open tab keeps its `agentView`, so the memory IS the tab.
    // A second record of one fact would be wrong after any path that did not
    // write it (`decisions/ai/0620`).
    let password = "";
    await scenario(
      "ah4-agent-last-view",
      { seed: (dir) => { password = seedVault(dir).password; } },
      async (app) => {
        const s = app.session;
        await readyWithAi(s, password);
        await createNote(s, TITLE);

        // Leave the tab in FOCUS, then go elsewhere so the reveal is a real
        // reveal rather than a no-op on an already-active tab.
        await runPaletteAction(s, "ai.open-agent-note", "agent");
        await s.byTestId("agent.focus", { timeoutMs: 15_000 });
        await runPaletteAction(s, "graph.show", "graph");
        await s.byTestId("editor.graph-pane", { timeoutMs: 15_000 });

        // Come back through the VAULT verb, which is the one the ribbon entry
        // runs. It reveals, and the reveal keeps the view.
        await runPaletteAction(s, "ai.open-agent-vault", "agent");
        await s.waitUntil(
          async () => ((await agentView(s)) === "focus" ? true : null),
          {
            label: "the reveal kept the view the tab was left on",
            timeoutMs: 15_000,
          },
        );
        expect(await agentTabCount(s)).toBe(1);
      },
    );
  });
});
