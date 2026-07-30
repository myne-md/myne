// Graph settings panel suite (graph-connection-ux-polish task 5) — the gear
// button in the graph pane opens a panel that FLOATS over the canvas (never
// resizing it, since a canvas-size change would re-run the layout and
// re-jumble the graph — the flashbang the warm-start layout work exists to
// prevent), with one working control (edge-direction arrows), a
// reset-to-defaults action, and device-local persistence in `vault.workspace`.
//
// Task 6 adds the remaining seven controls, in two groups whose CORRECT
// behaviour is opposite — which is why they get a scenario each:
//
//   gs2 — the four appearance controls (label fade, node size, node-size
//         strength, line thickness) each PREVIEW LIVE and each repaint with
//         NO layout re-run: the canvas's own pixels change while
//         `data-layout-nonce` stays "1" and the canvas's
//         `data-force-relayout-count` stays "0" (no worker run at all).
//   gs3 — a FORCE control does the opposite, and must do it exactly once:
//         `data-force-relayout-count` goes up by ONE, the run warm-starts
//         (`data-force-relayout-seeded` == the pane's node count — a cold run
//         seeds none), `data-layout-nonce` never moves (a layout re-run, not a
//         model rebuild), and then everything FREEZES — no perpetual loop.
//
//   gs1 — open the gear: the panel appears WITHOUT changing the canvas's own
//         dimensions and WITHOUT bumping `data-layout-nonce` (the pane's
//         existing flashbang-free observability — `graph-layout-persistence
//         .e2e.ts` gp2's proof, reused here for "did opening settings re-run
//         the layout"); toggling the arrows switch flips its `aria-checked`
//         immediately, with NO layout re-run either (appearance-only); after a
//         lock → re-unlock remount, the graph pane + settings panel reopen
//         with the toggle still off (device-local persistence survived
//         restart); Reset restores the default (arrows back on).
//
// Why data-*/aria-* rather than canvas pixels in gs1: same reasoning as
// `graph-layout-persistence.e2e.ts` — the graph body is a force-laid-out
// <canvas>, so positions/appearance aren't in the DOM. The arrows toggle's own
// `aria-checked` and the pane's `data-layout-nonce` are the bounded,
// DENY-list-clean observability that scenario needs.
//
// gs2/gs3 need pixels ON TOP of those attributes, for the same reason
// `graph-color-groups.e2e.ts` does: "the slider previewed live" and "the
// arrangement actually changed" ARE pixel claims, and no attribute can stand in
// for them. The pixels are reduced IN THE PAGE to two scalars (an opaque-pixel
// count and a hash of the RGBA buffer) — never a coordinate, never a title, so
// nothing a failure diff prints can leak content (SYNC-8/SYNC-13).
//
// KDF: weak generator fixture (SYNC-9 — params are vault.meta-resident). Note
// bodies/titles are in-source scenario content, not credentials (SYNC-13).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  lockAndReunlock,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { type Element, type Session } from "./support/webdriver";

// Distinct note titles so the graph has nodes to lay out.
const TITLES = ["gs1notealfa7k2m9qx4w8e5rj0aa", "gs1notebravo3f6h1zn8c2vb5kk0"];

// gs2/gs3 need real EDGES, not just nodes: line thickness and the degree term
// of node size have nothing to change without them. A three-note chain
// (Bravo → Alfa → Charlie) is the `links-tab.e2e.ts` fixture shape, one
// wikilink per note — the typing pattern already proven green there.
const CHAIN = { charlie: "Gs Charlie", alfa: "Gs Alfa", bravo: "Gs Bravo" };
const CHAIN_TAILS = { charlie: "ctailgs4m2x", alfa: "atailgs8r6v", bravo: "btailgs1z9j" };

/** Open the whole-vault graph via the BottomBar affordance and return the pane
 *  element once it renders (mirrors `graph-layout-persistence.e2e.ts`). */
async function openGraph(s: Session) {
  await (await s.byTestId("editor.graph-button")).click();
  return await s.byTestId("editor.graph-pane", { timeoutMs: 15_000 });
}

/** Click the gear and return the now-open settings panel. */
async function openSettingsPanel(s: Session) {
  await (await s.byTestId("editor.graph-settings-gear")).click();
  return await s.byTestId("editor.graph-settings-panel");
}

/** Seed the three-note chain gs2/gs3 lay out, and return the graph pane +
 *  canvas once the first layout has been built. The canvas wait is NOT
 *  optional: `GraphCanvas` sits behind the app's only `React.lazy` boundary and
 *  mounts a few hundred ms AFTER the pane, so a pixel probe that only waited on
 *  `data-layout-nonce` reads a DOM with no <canvas> in it at all. */
async function openSettledGraph(s: Session): Promise<{ pane: Element; canvas: Element }> {
  await createNote(s, CHAIN.charlie);
  await typeIntoEditor(s, ` ${CHAIN_TAILS.charlie}`);
  await waitForSaved(s);
  await createNote(s, CHAIN.alfa);
  await typeIntoEditor(s, ` [[${CHAIN.charlie}]] ${CHAIN_TAILS.alfa}`);
  await waitForSaved(s);
  await createNote(s, CHAIN.bravo);
  await typeIntoEditor(s, ` [[${CHAIN.alfa}]] ${CHAIN_TAILS.bravo}`);
  await waitForSaved(s);

  const pane = await openGraph(s);
  await s.waitUntil(
    async () => ((await pane.attribute("data-layout-nonce")) === "1" ? true : null),
    { label: "graph builds once", timeoutMs: 15_000 },
  );
  const canvas = await s.byTestId("editor.graph-canvas", { timeoutMs: 15_000 });
  return { pane, canvas };
}

interface InkStats {
  /** How many pixels of the canvas carry (near-)opaque ink. Every appearance
   *  control under test here can only ADD ink (bigger discs, thicker strokes,
   *  labels that were hidden), so this doubles as a direction check. */
  n: number;
  /** Order-sensitive hash over the whole RGBA buffer — "the render changed at
   *  all", including a change that keeps the ink count identical. */
  h: string;
}

/** Reduce the graph canvas's backing store to {@link InkStats} in ONE round
 *  trip. `null` when the canvas is not mounted. */
async function inkStats(s: Session): Promise<InkStats | null> {
  return await s.execute<InkStats | null>(
    "var c = document.querySelector('[data-testid=\"editor.graph-canvas\"]');" +
      "if (!c) return null;" +
      "var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;" +
      "var n = 0, h = 2166136261;" +
      "for (var i = 0; i < d.length; i += 4) {" +
      "  if (d[i + 3] > 200) n += 1;" +
      "  h = Math.imul(h ^ d[i], 16777619) >>> 0;" +
      "  h = Math.imul(h ^ d[i + 3], 16777619) >>> 0;" +
      "}" +
      "return { n: n, h: String(h) };",
  );
}

/** Poll until the canvas has been pixel-IDENTICAL for `stable` consecutive
 *  samples — i.e. the bounded layout run finished and the renderer went quiet.
 *  Returns the settled stats. */
async function waitForCanvasQuiet(
  s: Session,
  label: string,
  stable = 3,
): Promise<InkStats> {
  let last: InkStats | null = null;
  let run = 0;
  return await s.waitUntil<InkStats>(
    async () => {
      const cur = await inkStats(s);
      if (cur === null) {
        last = null;
        run = 0;
        return null;
      }
      run = last !== null && last.h === cur.h ? run + 1 : 0;
      last = cur;
      return run >= stable ? cur : null;
    },
    { label: `canvas quiet (${label})`, timeoutMs: 30_000, intervalMs: 400 },
  );
}

/** Wait for the canvas to repaint into something different from `from`, and
 *  return the settled result. */
async function waitForRepaint(s: Session, from: InkStats, label: string): Promise<InkStats> {
  await s.waitUntil(
    async () => {
      const cur = await inkStats(s);
      return cur !== null && cur.h !== from.h ? cur : null;
    },
    { label: `repaint (${label})`, timeoutMs: 20_000, intervalMs: 200 },
  );
  return await waitForCanvasQuiet(s, label);
}

/** Drive one of the panel's `<input type=range>` controls to an END of its
 *  track and return its new displayed value.
 *
 *  A track click is the real gesture, but WebKit's slider does not always take
 *  a synthesized one — so an unchanged readout falls back to the range
 *  control's native End/Home keyboard shortcut. Both are real UI driving; no
 *  test hook, no value written from script. */
async function slideToEnd(s: Session, testId: string, end: "min" | "max"): Promise<string> {
  const el = await s.byTestId(testId);
  await el.scrollIntoView();
  const readout = await s.byTestId(`${testId}-value`);
  const before = await readout.textContent();
  const changed = async () => {
    const v = await readout.textContent();
    return v !== before ? v : null;
  };

  const box = await el.rect();
  const dx = Math.max(1, Math.floor(box.width / 2) - 3);
  await el.actionClick(end === "max" ? dx : -dx, 0);
  try {
    return await s.waitUntil(changed, {
      label: `${testId} pointer → ${end}`,
      timeoutMs: 3_000,
      intervalMs: 150,
    });
  } catch {
    // W3C key codes: U+E010 END, U+E011 HOME — the native "jump to max / min"
    // shortcut of an <input type=range>.
    await el.sendKeys(end === "max" ? "\uE010" : "\uE011");
    return await s.waitUntil(changed, { label: `${testId} keyboard → ${end}` });
  }
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describeE2E("gs1 graph settings panel — floats, no-relayout, toggles live, persists, resets", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("opens over the canvas without resizing/relayout, persists the toggle, and resets", async () => {
    let password = "";
    await scenario(
      "gs1-graph-settings-panel",
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
        // Let the layout settle before probing "did it re-run" — gp2's wait.
        await s.waitUntil(
          async () => ((await pane.attribute("data-layout-nonce")) === "1" ? true : null),
          { label: "graph builds once", timeoutMs: 15_000 },
        );

        const canvas = await s.waitForElement("canvas");
        const rectBefore = await canvas.rect();

        await openSettingsPanel(s);

        // Floats over the canvas: no dimension change, no layout re-run.
        const rectAfter = await canvas.rect();
        expect(rectAfter.width).toBe(rectBefore.width);
        expect(rectAfter.height).toBe(rectBefore.height);
        expect(await pane.attribute("data-layout-nonce")).toBe("1");

        // Toggling arrows flips the switch live, with no re-layout either
        // (an appearance-only change per the PRD's render-time-layer rule).
        const toggle = await s.byTestId("editor.graph-settings-arrows-toggle");
        expect(await toggle.attribute("aria-checked")).toBe("true"); // default: arrows on
        await toggle.click();
        await s.waitUntil(
          async () => ((await toggle.attribute("aria-checked")) === "false" ? true : null),
          { label: "arrows toggle flips off" },
        );
        expect(await pane.attribute("data-layout-nonce")).toBe("1");

        // Persistence: lock (flushes the staged workspace descriptor) → re-unlock.
        await lockAndReunlock(s, password);
        await openGraph(s);
        await openSettingsPanel(s);
        const toggle2 = await s.byTestId("editor.graph-settings-arrows-toggle");
        expect(await toggle2.attribute("aria-checked")).toBe("false");

        // Reset restores every control to its default (arrows back on).
        await (await s.byTestId("editor.graph-settings-reset")).click();
        await s.waitUntil(
          async () => ((await toggle2.attribute("aria-checked")) === "true" ? true : null),
          { label: "reset restores default" },
        );
      },
    );
  });
});

describeE2E("gs2 appearance controls preview live and never re-run the layout", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("label fade, node size, size strength and line thickness each repaint with the layout pinned", async () => {
    let password = "";
    await scenario(
      "gs2-graph-settings-appearance",
      {
        seed: (dir) => {
          password = seedVault(dir).password;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        const { pane, canvas } = await openSettledGraph(s);
        const settled = await waitForCanvasQuiet(s, "initial layout");
        expect(await canvas.attribute("data-force-relayout-count")).toBe("0");

        await openSettingsPanel(s);
        expect(await pane.attribute("data-layout-nonce")).toBe("1");

        // Each control, driven to the end of its track. Order is deliberate:
        // every one of these can only ADD ink (labels that were hidden below
        // the fade threshold, fatter discs, a wider degree term, thicker
        // strokes), so the count is monotone and the final comparison against
        // `settled` is a direction check, not just "something changed".
        const CONTROLS = [
          { testId: "editor.graph-settings-label-fade", end: "min" },
          { testId: "editor.graph-settings-node-size-strength", end: "max" },
          { testId: "editor.graph-settings-node-size", end: "max" },
          { testId: "editor.graph-settings-line-thickness", end: "max" },
        ] as const;

        let prev = settled;
        for (const c of CONTROLS) {
          const value = await slideToEnd(s, c.testId, c.end);
          expect(value.length).toBeGreaterThan(0); // the panel's own readout moved
          // It PREVIEWS LIVE — the canvas really repaints…
          prev = await waitForRepaint(s, prev, c.testId);
          // …and it is RENDER-TIME ONLY: no model rebuild (the pane's nonce)
          // and no layout worker run at all (the canvas's own counter). A
          // layout re-run on an appearance change is the defect this pins.
          expect(await pane.attribute("data-layout-nonce")).toBe("1");
          expect(await canvas.attribute("data-force-relayout-count")).toBe("0");
        }

        expect(prev.n).toBeGreaterThan(settled.n);

        // Reset-to-defaults covers these four as well as gs1's arrows toggle:
        // with the layout untouched throughout, restoring the defaults must
        // restore the DEFAULT RENDER — same positions, same settings, same
        // amount of ink as the very first settled frame.
        await (await s.byTestId("editor.graph-settings-reset")).click();
        await s.waitUntil(
          async () => {
            const cur = await inkStats(s);
            return cur !== null && cur.n === settled.n ? true : null;
          },
          { label: "reset restores the default render", timeoutMs: 20_000 },
        );
        expect(await pane.attribute("data-layout-nonce")).toBe("1");
        expect(await canvas.attribute("data-force-relayout-count")).toBe("0");
      },
    );
  });
});

describeE2E("gs3 a force control re-runs the bounded layout once, warm-started, then freezes", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("bumps the re-layout counter by exactly one, seeds every node, and goes quiet", async () => {
    let password = "";
    await scenario(
      "gs3-graph-settings-forces",
      {
        seed: (dir) => {
          password = seedVault(dir).password;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        const { pane, canvas } = await openSettledGraph(s);
        const settled = await waitForCanvasQuiet(s, "initial layout");
        const nodeCount = await pane.attribute("data-node-count");
        expect(await canvas.attribute("data-force-relayout-count")).toBe("0");

        await openSettingsPanel(s);
        await slideToEnd(s, "editor.graph-settings-force-repel", "max");

        // ONE bounded re-layout runs — the opposite contract from gs2, and
        // correct: the user explicitly asked for a different arrangement.
        await s.waitUntil(
          async () =>
            (await canvas.attribute("data-force-relayout-count")) === "1" ? true : null,
          { label: "force change ran one bounded re-layout", timeoutMs: 20_000 },
        );
        // It WARM-STARTS: the request carried a seed for every node it was
        // about to lay out. `seedInitialPosition` only randomizes a node the
        // request did NOT seed, so "seeded == node count" is exactly
        // "nothing re-scattered" — the flashbang-free property.
        expect(await canvas.attribute("data-force-relayout-seeded")).toBe(nodeCount);
        // …and it is a LAYOUT re-run, not a model rebuild.
        expect(await pane.attribute("data-layout-nonce")).toBe("1");

        // The arrangement really did change — the slider is wired end to end,
        // through the layout-request protocol and into the worker kernel.
        const rearranged = await waitForCanvasQuiet(s, "re-layout settled");
        expect(rearranged.h).not.toBe(settled.h);

        // …then it FREEZES. The bounded-tick posture is what keeps the graph
        // viable on large vaults, so "one run, then quiet" is the load-bearing
        // half: across a multi-second window neither the counter nor a single
        // canvas pixel moves again (a perpetual rAF loop would move both).
        for (let i = 0; i < 6; i += 1) {
          await pause(500);
          expect(await canvas.attribute("data-force-relayout-count")).toBe("1");
          expect(await pane.attribute("data-layout-nonce")).toBe("1");
          expect((await inkStats(s))?.h).toBe(rearranged.h);
        }

        // A second force control behaves identically: exactly one more run,
        // still warm-started, still no model rebuild.
        await slideToEnd(s, "editor.graph-settings-force-link-distance", "max");
        await s.waitUntil(
          async () =>
            (await canvas.attribute("data-force-relayout-count")) === "2" ? true : null,
          { label: "second force change ran one more bounded re-layout", timeoutMs: 20_000 },
        );
        expect(await canvas.attribute("data-force-relayout-seeded")).toBe(nodeCount);
        expect(await pane.attribute("data-layout-nonce")).toBe("1");
      },
    );
  });
});
