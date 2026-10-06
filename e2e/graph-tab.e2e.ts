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
//   gt2 : that tab's BODY fills the pane (myne-md/myne#534).
//   gt3 : and keeps filling it when the pane is resized without the window
//         being resized (myne-md/myne#534).
//
// Why the tab contract, not a canvas node-click: the graph body is a
// force-laid-out <canvas>, so pixel-accurate node hit-testing is inherently
// flaky under the driver. The node-click-opens-a-new-tab behavior is covered
// deterministically by the workspace-ops unit tests
// (tests/notes/workspaceContext.test.tsx). E2E owns the surface contract:
// the graph mounts as a genuine, singleton tab, in a box the right size.
//
// KDF: weak generator fixture (SYNC-9 — params are vault.meta-resident).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  collapseNotesSidebar,
  createNote,
  dismissImporterOffer,
  openSettledGraphPane,
  runPaletteAction,
  settleOn,
  unlockToEditor,
} from "./support/flows";
import { type Session, testIdSelector } from "./support/webdriver";

// A couple of note titles so the graph has nodes to lay out (the tab renders
// regardless, but a non-empty vault exercises the real canvas path). Shared by
// all three scenarios: none of them asserts on a title, and each gets its own
// vault, so per-scenario sets would only invite the next author to add a fourth.
const TITLES = [
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
        for (const t of TITLES) await createNote(s, t);

        // Open the graph through the palette. The BottomBar launcher this used
        // to click is gone (myne-md/myne#727): the graph is a command the left
        // ribbon hosts, and `graph.show` is its frozen palette id.
        await runPaletteAction(s, "graph.show", "graph");

        // The graph mounts as a tab: the strip carries a `graph:graph` tab and
        // it is the active one; the pane body shows the graph (not the editor).
        const graphTab = await s.waitForElement(
          testIdSelector("editor.tab", { "data-tab-id": GRAPH_TAB_KEY }),
          { timeoutMs: 15_000 },
        );
        expect(await graphTab.attribute("data-active")).toBe("true");
        await s.byTestId("editor.graph-pane", { timeoutMs: 15_000 });
        expect(await graphTabCount(s)).toBe(1);

        // Re-fire the command: the graph is a workspace-wide singleton, so this
        // reveals the existing tab instead of opening a second one.
        await runPaletteAction(s, "graph.show", "graph");
        await s.waitUntil(
          async () => ((await graphTabCount(s)) === 1 ? true : null),
          { label: "graph tab stays a singleton after re-fire", timeoutMs: 15_000 },
        );
      },
    );
  });
});

// ── gt2 / gt3: the graph BODY, not the tab (myne-md/myne#534) ─────────────
//
// gt1 pins that the graph mounts as a singleton tab. It says nothing about the
// BOX that tab renders into, and for the whole life of the feature that box was
// wrong: the pane body's full-bleed frame was given to the drawing note type
// only, so `GraphPane`'s `height: 100%` resolved against an auto-height wrapper,
// became `auto`, and the canvas fell back to its intrinsic 2:1 ratio. The graph
// was `paneWidth / 2` tall, overflowing a wide window (unreachably, since the
// canvas `preventDefault`s `wheel`) and leaving dead space in a narrow one.
// Nothing saw it: jsdom has no layout, no Vitest test mounts the canvas, and
// this suite asserted presence.
//
// Two scenarios rather than one, because they are two stories: the body FILLS
// the pane, and it KEEPS filling it when the pane changes size without the
// window doing so, which is the case a `window`-only resize listener cannot
// observe.

interface GraphGeometry {
  /** Viewport-space bottom edges, rounded. The fill claim is that they meet. */
  paneBottom: number;
  canvasBottom: number;
  /** The canvas's CSS box, UNROUNDED: the backing-store claim multiplies by it. */
  cssWidth: number;
  cssHeight: number;
  /** `canvas.width` / `canvas.height`, i.e. the BACKING STORE, in device pixels.
   *  This is the half a stale resize listener leaves behind: the CSS box
   *  follows the pane for free (`width: 100%`), the backing store only follows
   *  if something observed the element. */
  storeWidth: number;
  storeHeight: number;
  dpr: number;
}

/** Both boxes in ONE `execute`, so they are read from the same layout. Two
 *  round-trips could straddle the sidebar's width transition and compare a pane
 *  from before it against a canvas from after. Returns `""` until both elements
 *  exist: the canvas sits behind the app's only `React.lazy` boundary and mounts
 *  a few hundred ms after the pane. Numbers only, no note id and no node
 *  coordinate, so a failure diff carries nothing from the vault (SYNC-13). */
async function measureGraph(s: Session): Promise<string> {
  return s.execute<string>(
    "var pane = document.querySelector(arguments[0]);" +
      "var cv = document.querySelector(arguments[1]);" +
      "if (!pane || !cv) return '';" +
      "var p = pane.getBoundingClientRect();" +
      "var c = cv.getBoundingClientRect();" +
      "return JSON.stringify({" +
      "  paneBottom: Math.round(p.bottom)," +
      "  canvasBottom: Math.round(c.bottom)," +
      "  cssWidth: c.width," +
      "  cssHeight: c.height," +
      "  storeWidth: cv.width," +
      "  storeHeight: cv.height," +
      "  dpr: window.devicePixelRatio || 1" +
      "});",
    [testIdSelector("editor.pane"), testIdSelector("editor.graph-canvas")],
  );
}

/** The settled geometry. Two agreeing samples is enough here: the only thing in
 *  flight is the sidebar's width TRANSITION, which moves monotonically toward
 *  rest, so it cannot repeat a value mid-animation the way the canvas-ink probe
 *  in `graph-settings.e2e.ts` can. */
async function settledGraphGeometry(s: Session, label: string): Promise<GraphGeometry> {
  return settleOn(s, async () => (await measureGraph(s)) || null, {
    label,
    parse: (raw) => JSON.parse(raw) as GraphGeometry,
  });
}

/** Seed two notes and open the graph, settled and with its canvas mounted. */
async function openBuiltGraph(s: Session, password: string): Promise<void> {
  await unlockToEditor(s, password);
  await dismissImporterOffer(s);
  for (const t of TITLES) await createNote(s, t);
  await openSettledGraphPane(s);
}

describeE2E("gt2 the graph body fills the pane (myne-md/myne#534)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("the graph canvas ends where the pane ends, neither short of it nor past it", async () => {
    let password = "";
    await scenario(
      "gt2-graph-fills-pane",
      {
        seed: (dir) => {
          password = seedVault(dir).password;
        },
      },
      async (app) => {
        const s = app.session;
        await openBuiltGraph(s, password);
        const g = await settledGraphGeometry(s, "graph geometry settles");

        // The whole claim, in one number. Before the fix this gap was the pane
        // height minus `paneWidth / 2`, measured at 347 px in the harness's
        // 1100x720 window, and NEGATIVE (overflowing, the bottom of the graph
        // off-screen and unscrollable) on a wider one.
        expect(
          Math.abs(g.paneBottom - g.canvasBottom),
          "the graph canvas ends where the pane ends",
        ).toBeLessThanOrEqual(2);

        // Guards the assertion above against holding for the wrong reason: a
        // canvas collapsed to nothing sits at the pane's TOP today, but a future
        // layout change could park a zero-height box on the bottom edge and
        // satisfy the gap alone.
        expect(
          g.cssHeight,
          "the canvas is a real box, not a collapsed one",
        ).toBeGreaterThan(100);
      },
    );
  });
});

describeE2E("gt3 the graph canvas follows a pane resize (myne-md/myne#534)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("collapsing the notes sidebar re-sizes the canvas backing store, not just its CSS box", async () => {
    let password = "";
    await scenario(
      "gt3-graph-follows-resize",
      {
        seed: (dir) => {
          password = seedVault(dir).password;
        },
      },
      async (app) => {
        const s = app.session;
        await openBuiltGraph(s, password);
        const before = await settledGraphGeometry(s, "graph geometry settles");

        // The notes sidebar is the pane's only neighbour that can change the
        // pane's width WITHOUT changing the window's, which is exactly the case
        // a `window`-resize listener never hears. The harness has no primitive
        // for a real window resize either, so this is not a substitute for one:
        // it is the stronger case.
        //
        // Waited for rather than asserted immediately, which is the difference
        // between a race and a bug: every other read in this file and in gt2
        // goes through `settleOn` or `waitUntil`, and a bare `findElements` used
        // as a hard expect turns a title bar that paints a frame later into a
        // red pipeline reading like a product defect. `stable_max_failures` is
        // 0 in `scripts/e2e-scenario-floor.json`, so any failure in this lane
        // reddens the blocking `e2e-floor` step.
        await s.waitUntil(
          async () =>
            (
              await s.findElements(
                testIdSelector("editor.sidebar-toggle", {
                  "data-side": "left",
                  "data-collapsed": "false",
                }),
              )
            ).length === 1 || null,
          { label: "the notes sidebar starts expanded, so collapsing it really narrows the pane" },
        );
        await collapseNotesSidebar(s);

        const after = await settledGraphGeometry(s, "graph geometry re-settles");

        // Non-vacuity: without a real width change every assertion below would
        // hold on a build with the fix removed.
        expect(
          after.cssWidth,
          "collapsing the sidebar widened the pane",
        ).toBeGreaterThan(before.cssWidth + 50);

        // The defect, named. With a `window`-only listener the backing store
        // stayed at `before.storeWidth`: a canvas drawing a box that is no
        // longer there, stretched, with `sizeRef`-driven culling and pointer
        // hit-testing pointing at the old geometry.
        expect(
          Math.abs(after.storeWidth - after.cssWidth * after.dpr),
          "the backing store followed the canvas's new width",
        ).toBeLessThanOrEqual(1);
        expect(
          Math.abs(after.storeHeight - after.cssHeight * after.dpr),
          "the backing store followed the canvas's height",
        ).toBeLessThanOrEqual(1);

        // And the resize must not re-open the gap gt2 closed.
        expect(
          Math.abs(after.paneBottom - after.canvasBottom),
          "the graph still ends where the pane ends",
        ).toBeLessThanOrEqual(2);
      },
    );
  });

  // Vault-count precondition: 1 (weak KDF).
  it("opens the ISOLATED view from the palette, which is its only entry point", async () => {
    // `graph.show-isolated` is the one way in. The pane's own filter control
    // deliberately cannot enter the view (its `<option>` is rendered only while
    // it is already the value), so if this command is not driven here, nothing
    // drives it at all (myne-md/myne#727, task 14).
    let password = "";
    await scenario(
      "gt4-graph-isolated-command",
      {
        seed: (dir) => {
          password = seedVault(dir).password;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        // Notes with no links between them, so the vault has orphans.
        for (const t of TITLES) await createNote(s, t);

        await runPaletteAction(s, "graph.show-isolated", "isolated");
        const pane = await s.byTestId("editor.graph-pane", { timeoutMs: 15_000 });
        const filter = await s.byTestId("editor.graph-filter", { timeoutMs: 15_000 });
        // The control TELLS THE TRUTH about the view it is in: the isolated
        // option is rendered only while it IS the value, and the trigger shows
        // that option's label.
        //
        // Read off the trigger's TEXT since myne-md/myne#772 made this the
        // shared `<Select>`: it is a button, not a native select, so there is
        // no `.value` property — and its absence is the improvement. A native
        // select falls back to its first option when the value matches none,
        // which is how this control could read "All" over a different picture.
        expect(await filter.property<string>("textContent")).toContain("Isolated");
        // And the picture really is the isolated set: every note in this vault
        // is an orphan, so the pane reports the whole set.
        await s.waitUntil(
          async () =>
            (await pane.attribute("data-node-count")) === String(TITLES.length)
              ? true
              : null,
          { label: "the isolated view holds every unlinked note", timeoutMs: 15_000 },
        );
        // No tag nodes: the isolated path is notes-only by design.
        expect(await pane.attribute("data-tag-node-count")).toBe("0");
      },
    );
  });
});
