// Graph-layout persistence + stability suite (graph rework Phase C closure).
// The whole-vault graph's laid-out node positions persist to the encrypted
// `vault.graph` (`MYG1`, protocol.md §9.19) rebuildable cache, and the layout
// must NOT spontaneously re-run ("flashbang") while the graph sits open. Both
// are pinned here through the REAL editor UI.
//
//   gp1 — layout persists across a lock → re-unlock remount: opening the graph
//         writes `vault.graph` (MYG1 at rest); after a lock (which clears the
//         in-RAM layout store via `resetGraphLayoutOnLock`) and re-unlock, the
//         graph re-mounts and RESTORES the layout FROM DISK — proven by the
//         `data-layout-hydrated` flag + the same `data-node-count`. Because lock
//         wipes the RAM store, a restored non-empty layout can only have come
//         from the encrypted blob.
//   gp2 — flashbang-free: after the graph settles, the build/layout runs exactly
//         ONCE (`data-layout-nonce` reaches "1" and never climbs while the pane
//         sits open) — the machine-checkable proof the layout effect does not
//         re-run on ordinary re-renders.
//
// Why data-* not canvas pixels: the graph body is a force-laid-out <canvas>, so
// positions are not in the DOM (same reason graph-tab.e2e.ts asserts the tab
// contract, not node hit-testing). `GraphPane` exposes bounded, DENY-list-clean
// observability attributes on `editor.graph-pane` (node-count / hydrated / an
// opaque build nonce — never a note id or coordinate; SYNC-8, modeled on
// AiHydrationProbe). The deeper "re-render during heavy index churn does not
// re-scatter" property is enforced by the effect-deps design (GraphCanvas deps
// = [model]; the build effect reads `notes` through a ref) + its Vitest
// coverage; E2E owns the observable surface.
//
// KDF: weak generator fixture (SYNC-9 — params are vault.meta-resident).

import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { assertBlobMagic, graphLayoutPath, seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  lockAndReunlock,
  unlockToEditor,
} from "./support/flows";
import { type Session } from "./support/webdriver";

// Distinct note titles so the graph has nodes to lay out + persist.
const TITLES = [
  "gp1notealfa7k2m9qx4w8e5rj0aa",
  "gp1notebravo3f6h1zn8c2vb5kk0",
  "gp1notecharlie9d4s7yq2mx1pp5",
];

/** Open the whole-vault graph via the BottomBar affordance and return the pane
 *  element once it renders. */
async function openGraph(s: Session) {
  await (await s.byTestId("editor.graph-button")).click();
  return await s.byTestId("editor.graph-pane", { timeoutMs: 15_000 });
}

/** Poll until the `vault.graph` blob exists on disk (the flush is debounced
 *  ~800 ms after the worker settles), then assert its MYG1 magic. */
async function waitForGraphBlob(s: Session, path: string): Promise<void> {
  await s.waitUntil(async () => (existsSync(path) ? true : null), {
    label: "vault.graph written to disk",
    timeoutMs: 15_000,
  });
  assertBlobMagic(path, "MYG1");
}

// QUARANTINE (contention): tail-of-suite mount-timeout — createNote's
// `notes.rename-input` never paints within budget on a contended runner (the
// helper is sound; 57 other files pass it). Green 2× on 2026-07-26; regressed
// under suite-length degradation. Debt: boot-cost investigation (nav1/tp1 family).
describeE2E.flaky("gp1 graph layout persists across a lock/re-unlock remount", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("opening the graph writes MYG1; a remount restores the layout from disk", async () => {
    let password = "";
    let vaultId = "";
    await scenario(
      "gp1-graph-layout-persistence",
      {
        seed: (dir) => {
          const v = seedVault(dir);
          password = v.password;
          vaultId = v.vaultId;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        for (const t of TITLES) await createNote(s, t);

        // Open the graph → it builds + lays out + (debounced) writes vault.graph.
        const pane = await openGraph(s);
        const nodeCount = await pane.attribute("data-node-count");
        expect(Number(nodeCount)).toBeGreaterThanOrEqual(TITLES.length);

        // At-rest proof: the encrypted MYG1 blob lands on disk.
        await waitForGraphBlob(s, graphLayoutPath(app.appDataDir, vaultId));

        // Lock (clears the RAM layout store) then re-unlock → GraphPane remounts.
        await lockAndReunlock(s, password);

        // Reopen the graph → the layout is RESTORED from the encrypted blob:
        // the hydrate path ran, and the graph built the same node-set.
        const pane2 = await openGraph(s);
        expect(await pane2.attribute("data-layout-hydrated")).toBe("true");
        expect(await pane2.attribute("data-node-count")).toBe(nodeCount);
      },
    );
  });
});

// QUARANTINE (contention): same tail-of-suite mount-timeout as gp1.
describeE2E.flaky("gp2 graph layout is flashbang-free (builds once, does not re-run)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("data-layout-nonce settles at 1 and never climbs while the graph sits open", async () => {
    let password = "";
    await scenario(
      "gp2-graph-layout-stable",
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

        const pane = await openGraph(s);

        // The layout effect runs exactly once per mount → nonce reaches "1".
        await s.waitUntil(
          async () =>
            (await pane.attribute("data-layout-nonce")) === "1" ? true : null,
          { label: "graph builds once", timeoutMs: 15_000 },
        );

        // Sample the nonce across a window while the pane sits open: it must NOT
        // climb (a spontaneous re-build/re-layout is the flashbang regression).
        for (let i = 0; i < 5; i += 1) {
          await s.waitUntil(async () => true, { label: "settle tick", timeoutMs: 800 });
          expect(await pane.attribute("data-layout-nonce")).toBe("1");
        }
      },
    );
  });
});
