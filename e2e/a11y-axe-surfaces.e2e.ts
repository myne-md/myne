// The axe gate's second half: the surfaces it never reached (myne-md/myne#775,
// epic #772 lane 2a).
//
// `a11y-axe.e2e.ts` covered six screens — Welcome, Unlock, the editor, Settings,
// the palette, and one more. That is the core flow, and it is where the gate
// started for good reasons. What it left unmeasured is most of the app a person
// who USES it spends time in: the graph, the attachment library, the task list,
// the sidebar collection panels, and the empty states now shared across all of
// them. `PRODUCT.md` commits to WCAG 2.2 AA "across every client", and a gate
// over six of thirty-odd surfaces cannot back that sentence.
//
// The scenarios live in their own file rather than being appended to the
// original because the two have different jobs: that one pins the FLOW nobody
// may break, this one widens the denominator. Keeping them apart means a
// failure here reads as "a surface has debt" rather than "onboarding is broken".
//
// Each scopes axe to the surface under test. A whole-page run on a screen with
// the editor behind it reports the editor's debt against whatever is in front,
// which is how a gate becomes noise nobody reads — the original file records
// that reasoning on AX-5 and this file follows it.
//
// Vault-count precondition declared per scenario. Linux-only; self-skips.
//
// ⚠️ NEW SCENARIOS: authored to the harness conventions but NOT yet validated in
// the container (this dev platform is macOS; the suite is Linux/tauri-driver
// only). Definition of done per e2e/AGENTS.md is "green 3× consecutive" via
// ./scripts/e2e-buildrun.sh. Run ISOLATED: the full suite contaminates.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import {
  dismissImporterOffer,
  enableAi,
  enableDeveloperMode,
  runPaletteAction,
  unlockToEditor,
} from "./support/flows";
import { runAxeInPage, formatAxe } from "./support/axe";
import type { Session } from "./support/webdriver";

const RAIL = '[data-testid="editor.ribbon.button"]';

/** Run the rail entry for a registry command id. */
async function runRail(s: Session, commandId: string): Promise<void> {
  await s.execute(
    `const el = document.querySelector('${RAIL}[data-command-id="${commandId}"]');` +
      `if (el !== null) el.click();`,
  );
}

/** Unlock, dismiss the importer offer, and hand back the session. */
async function ready(app: { session: Session }, password: string): Promise<Session> {
  await app.session.byTestId("unlock.password-input", { timeoutMs: 20_000 });
  await unlockToEditor(app.session, password);
  await dismissImporterOffer(app.session);
  return app.session;
}

describeE2E("AXS-1 the graph tab has no WCAG 2.2 AA violations", () => {
  it("axe is clean on the whole-vault graph", async () => {
    // Vault-count precondition: 1.
    let fixture!: SeededVault;
    await scenario(
      "axs1-graph",
      { seed: (dir) => { fixture = seedVault(dir); } },
      async (app) => {
        const s = await ready(app, fixture.password);
        await runRail(s, "graph.show");
        await s.byTestId("editor.graph-view", { timeoutMs: 15_000 });
        // The canvas itself is not axe's business — it is one element with a
        // label. What is: the toolbar cluster floating on it, which is where
        // the icon-only controls and the segmented reading-mode switch live.
        const violations = await runAxeInPage(s);
        expect(violations, formatAxe(violations)).toEqual([]);
      },
    );
  });
});

describeE2E("AXS-2 the attachment library tab has no WCAG 2.2 AA violations", () => {
  it("axe is clean on the library, including its empty state", async () => {
    // Vault-count precondition: 1. A seeded vault has no attachments, so this
    // lands on the `firstRun` EmptyState — which carries the `01` canvas, and
    // the canvas being `aria-hidden` with the meaning in text is exactly the
    // kind of claim a gate should be checking rather than a comment asserting.
    let fixture!: SeededVault;
    await scenario(
      "axs2-attachments",
      { seed: (dir) => { fixture = seedVault(dir); } },
      async (app) => {
        const s = await ready(app, fixture.password);
        await runRail(s, "attachments.open");
        await s.byTestId("attachments.empty-no-attachments", { timeoutMs: 15_000 });
        const violations = await runAxeInPage(s);
        expect(violations, formatAxe(violations)).toEqual([]);
      },
    );
  });
});

describeE2E("AXS-3 the task list tab has no WCAG 2.2 AA violations", () => {
  it("axe is clean on the vault-wide task list", async () => {
    // Vault-count precondition: 1.
    let fixture!: SeededVault;
    await scenario(
      "axs3-tasks",
      { seed: (dir) => { fixture = seedVault(dir); } },
      async (app) => {
        const s = await ready(app, fixture.password);
        await runRail(s, "tasks.show");
        const violations = await runAxeInPage(s);
        expect(violations, formatAxe(violations)).toEqual([]);
      },
    );
  });
});

describeE2E("AXS-4 the Trash panel has no WCAG 2.2 AA violations", () => {
  it("axe is clean on Trash, empty state included", async () => {
    // Vault-count precondition: 1. Scoped to the panel: the sidebar and editor
    // behind it are AX-3's subject, and reporting their debt here would make
    // this scenario fail for reasons it cannot fix.
    let fixture!: SeededVault;
    await scenario(
      "axs4-trash",
      { seed: (dir) => { fixture = seedVault(dir); } },
      async (app) => {
        const s = await ready(app, fixture.password);
        await runRail(s, "trash.open");
        await s.byTestId("trash.panel", { timeoutMs: 15_000 });
        const violations = await runAxeInPage(s, '[data-testid="trash.panel"]');
        expect(violations, formatAxe(violations)).toEqual([]);
      },
    );
  });
});

describeE2E("AXS-5 the Archive panel has no WCAG 2.2 AA violations", () => {
  it("axe is clean on Archive, empty state included", async () => {
    // Vault-count precondition: 1.
    let fixture!: SeededVault;
    await scenario(
      "axs5-archive",
      { seed: (dir) => { fixture = seedVault(dir); } },
      async (app) => {
        const s = await ready(app, fixture.password);
        await runRail(s, "archive.open");
        await s.byTestId("archive.panel", { timeoutMs: 15_000 });
        const violations = await runAxeInPage(s, '[data-testid="archive.panel"]');
        expect(violations, formatAxe(violations)).toEqual([]);
      },
    );
  });
});

describeE2E("AXS-6 the agent tab has no WCAG 2.2 AA violations", () => {
  it("axe is clean on the agent Hub, including its first-run empty state", async () => {
    // Vault-count precondition: 1. Task 13 of myne-md/myne#771.
    //
    // It goes through the PALETTE rather than the rail, unlike its four
    // neighbours above: the agent's ribbon entry is pin-eligible and NOT in
    // `RIBBON_DEFAULT_IDS`, so a fresh vault's rail does not carry it and
    // `runRail` would click nothing and then time out on an element that was
    // never going to appear — which reads as a broken surface rather than as a
    // scenario asking for the wrong door.
    //
    // Both gates have to be opened, and in this order: `developer_mode` decides
    // whether the action is VISIBLE in the palette at all, `ai_enabled` decides
    // whether it is invokable rather than disabled. Opening only the first
    // finds the entry and cannot press it.
    //
    // A seeded vault has no conversations, so this lands on the Hub's
    // `firstRun` empty state — which carries the `01` canvas, and the canvas
    // being `aria-hidden` with its meaning in text is exactly the kind of claim
    // a gate should check rather than a comment assert.
    let fixture!: SeededVault;
    await scenario(
      "axs6-agent",
      { seed: (dir) => { fixture = seedVault(dir); } },
      async (app) => {
        const s = await ready(app, fixture.password);
        await enableDeveloperMode(s);
        await enableAi(s);
        // The third argument is the palette QUERY, not an option: the picker
        // filters before it can be clicked.
        await runPaletteAction(s, "ai.open-agent-vault", "agent");
        await s.byTestId("agent.pane", { timeoutMs: 15_000 });
        await s.byTestId("agent.hub-empty", { timeoutMs: 15_000 });
        const violations = await runAxeInPage(s, '[data-testid="agent.pane"]');
        expect(violations, formatAxe(violations)).toEqual([]);
      },
    );
  });
});
