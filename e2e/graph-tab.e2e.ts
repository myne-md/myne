// Graph-tab suite (MYND-198). The whole-vault graph is no longer a modal
// carve-out — it opens as a first-class workspace TAB (a `{kind:"graph"}`
// WorkspaceItem), a peer of note and saved-view tabs. This pins the tab
// contract through the REAL editor UI:
//
//   gt1 — the BottomBar graph affordance opens the graph as a tab: a
//         `data-tab-id="graph:graph"` tab appears, becomes active, and the
//         graph pane body renders in place of the editor. Firing the
//         affordance again does NOT make a second graph tab — the graph is a
//         workspace-wide singleton (global duplicate-forbid → reveal).
//
// Why the tab contract, not a canvas node-click: the graph body is a
// force-laid-out <canvas>, so pixel-accurate node hit-testing is inherently
// flaky under the driver. The node-click-opens-a-new-tab behavior is covered
// deterministically by the workspace-ops unit tests
// (tests/notes/workspaceContext.test.tsx). E2E owns the surface contract:
// the graph mounts as a genuine, singleton tab.
//
// KDF: weak generator fixture (SYNC-9 — params are vault.meta-resident).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import { createNote, dismissImporterOffer, unlockToEditor } from "./support/flows";
import { type Session, testIdSelector } from "./support/webdriver";

// A couple of distinct note titles so the graph has nodes to lay out (the tab
// renders regardless, but a non-empty vault exercises the real canvas path).
const GT1_TITLES = [
  "gt1notealfa7k2m9qx4w8e5rj0aa",
  "gt1notebravo3f6h1zn8c2vb5kk0",
];

// The graph tab's stable DOM handle — `data-tab-id` carries the workspace-item
// key, and the whole-vault graph is the singleton `graph:graph` (Saved Views #4
// generalized tabs to `note:<id>` / `view:<id>` / `graph:graph`).
const GRAPH_TAB_KEY = "graph:graph";

/** Count of graph tabs currently in the workspace (across all panes). */
async function graphTabCount(session: Session): Promise<number> {
  const els = await session.findElements(
    testIdSelector("editor.tab", { "data-tab-id": GRAPH_TAB_KEY }),
  );
  return els.length;
}

describeE2E("gt1 graph opens as a singleton tab (MYND-198)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("the BottomBar graph affordance opens the graph as a tab; re-firing reveals, never duplicates", async () => {
    let password = "";
    await scenario(
      "gt1-graph-tab",
      {
        seed: (dir) => {
          password = seedVault(dir).password;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        for (const t of GT1_TITLES) await createNote(s, t);

        // Open the graph via the persistent BottomBar affordance.
        await (await s.byTestId("editor.graph-button")).click();

        // The graph mounts as a tab: the strip carries a `graph:graph` tab and
        // it is the active one; the pane body shows the graph (not the editor).
        const graphTab = await s.waitForElement(
          testIdSelector("editor.tab", { "data-tab-id": GRAPH_TAB_KEY }),
          { timeoutMs: 15_000 },
        );
        expect(await graphTab.attribute("data-active")).toBe("true");
        await s.byTestId("editor.graph-pane", { timeoutMs: 15_000 });
        expect(await graphTabCount(s)).toBe(1);

        // Re-fire the affordance — the graph is a workspace-wide singleton, so
        // this reveals the existing tab instead of opening a second one.
        await (await s.byTestId("editor.graph-button")).click();
        await s.waitUntil(
          async () => ((await graphTabCount(s)) === 1 ? true : null),
          { label: "graph tab stays a singleton after re-fire", timeoutMs: 15_000 },
        );
      },
    );
  });
});
