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
// opaque build nonce — never a note id or coordinate; SYNC-8). The deeper
// "re-render during heavy index churn does not
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
  openGraphPane,
  unlockToEditor,
} from "./support/flows";
import { type Session } from "./support/webdriver";

// Distinct note titles so the graph has nodes to lay out + persist.
const TITLES = [
  "gp1notealfa7k2m9qx4w8e5rj0aa",
  "gp1notebravo3f6h1zn8c2vb5kk0",
  "gp1notecharlie9d4s7yq2mx1pp5",
];

/** Poll until the `vault.graph` blob exists on disk (the flush is debounced
 *  ~800 ms after the worker settles), then assert its MYG1 magic. */
async function waitForGraphBlob(s: Session, path: string): Promise<void> {
  await s.waitUntil(async () => (existsSync(path) ? true : null), {
    label: "vault.graph written to disk",
    timeoutMs: 15_000,
  });
  assertBlobMagic(path, "MYG1");
}

// DE-QUARANTINED (myne-md/myne#555), and the recorded reason was wrong twice
// over.
//
// It was filed as a contended-runner mount timeout. Two causes were measured
// instead, and neither is contention:
//
// 1. The first seeding test in a vitest process builds `e2e-fixture-gen` with
//    `cargo build --release` inside its own budget (~171 s against a 180 s
//    `testTimeout`). That is the shared `nav1`/`tp1`/`svc1` cause;
//    `e2e/support/global-setup.ts` now pays it once, before any worker starts.
//
// 2. A residual failure survived that fix and was NOT a timeout — it failed in
//    2.6 s with `expected 0 to be greater than or equal to 3`. `openGraphPane`
//    resolves as soon as the pane ELEMENT exists, while the model is built
//    asynchronously behind the app's only `React.lazy` boundary, so reading
//    `data-node-count` straight afterwards reads a pane that has not built yet.
//    It is the "a helper that verifies nothing hides behind the helper that
//    comes after it" family `e2e/AGENTS.md` records, and the harness already had
//    the answer: every read below now waits for the attribute it is about to
//    assert on.
//
// Measured after both: 15 consecutive clean runs at `--retry=0` in a warm
// container, which is the bar `e2e/AGENTS.md` sets for releasing a quarantined
// spec.
describeE2E("gp1 graph layout persists across a lock/re-unlock remount", () => {
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
        //
        // WAIT for the count rather than reading it once. `openGraphPane`
        // resolves on the pane's own presence, and the model is built behind
        // the app's only `React.lazy` boundary a few hundred ms later — so a
        // bare read here samples `data-node-count="0"` on a pane that is
        // rendering its Suspense fallback. That is the whole of this
        // scenario's residual flake.
        const pane = await openGraphPane(s);
        const nodeCount = await s.waitUntil(
          async () => {
            const raw = await pane.attribute("data-node-count");
            return Number(raw) >= TITLES.length ? { v: raw } : null;
          },
          { label: `graph built at least ${TITLES.length} nodes`, timeoutMs: 15_000 },
        ).then((box) => box.v);
        expect(Number(nodeCount)).toBeGreaterThanOrEqual(TITLES.length);

        // At-rest proof: the encrypted MYG1 blob lands on disk.
        await waitForGraphBlob(s, graphLayoutPath(app.appDataDir, vaultId));

        // Lock (clears the RAM layout store) then re-unlock → GraphPane remounts.
        await lockAndReunlock(s, password);

        // Reopen the graph → the layout is RESTORED from the encrypted blob:
        // the hydrate path ran, and the graph built the same node-set. Same
        // rule as above — wait for the attribute being asserted on, so a
        // pre-hydrate sample cannot report "not hydrated" as a failure.
        const pane2 = await openGraphPane(s);
        await s.waitUntil(
          async () =>
            (await pane2.attribute("data-layout-hydrated")) === "true" ? true : null,
          { label: "graph layout hydrated from the MYG1 blob", timeoutMs: 15_000 },
        );
        await s.waitUntil(
          async () =>
            (await pane2.attribute("data-node-count")) === nodeCount ? true : null,
          { label: `graph rebuilt the same ${nodeCount} nodes`, timeoutMs: 15_000 },
        );
      },
    );
  });
});

// DE-QUARANTINED (myne-md/myne#555) — same cause 1 as gp1 (the fixture-gen
// build inside the first seeding test's budget), and it never had cause 2: this
// scenario already waits for `data-layout-nonce` to reach "1" before asserting
// anything, so it never read an unbuilt pane. That contrast is what identified
// the defect in gp1.
describeE2E("gp2 graph layout is flashbang-free (builds once, does not re-run)", () => {
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

        const pane = await openGraphPane(s);

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
