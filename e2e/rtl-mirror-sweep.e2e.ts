// rms1 — the chrome actually MIRRORS in an RTL locale, side by side.
// myne-md/myne#555, the `app.language-and-i18n` bullet:
//
//   > compare bounding boxes of the sidebar, chevrons, bottom-bar items and
//   > modal button pairs between an ltr and an rtl run and assert each flipped
//   > side. That is the gap rtl1 leaves.
//
// # What rtl1 covers, and the gap it leaves
//
// `rtl-layout.e2e.ts` pins the CONTRACT: picking an RTL locale flips
// `<html dir>` to `rtl`, live, and a mixed-script note title stays
// `<bdi>`-isolated. That attribute is what the whole shared `src/` tree mirrors
// off — CSS logical properties plus `[dir="rtl"]` rules — so it is the right
// thing to pin first.
//
// It does not check that anything MOVED. A tree that sets `dir="rtl"` and lays
// out identically satisfies every assertion there, and that is the realistic
// regression: one `left:` or `marginLeft` in an inline style is unreachable to a
// logical-property mirror, permanently, and the surrounding chrome flips around
// it. `check-token-adoption.mjs` ratchets the same class for colours; nothing
// ratchets it for sides.
//
// # One run, not two
//
// The language is switched mid-session through the real picker, so both
// measurements come from the same window at the same size. Two runs would make
// every comparison depend on two windows being identical, and a window that is
// 8px narrower would read as a layout difference.
//
// # What "mirrored" is asserted to mean
//
// Not "the box moved" — a box that shifts 20px has moved. The assertion is that
// each element CROSSES the centre line: something in the left half of the
// window is in the right half afterwards, and back. That is the property a user
// sees, it is scale-free, and it cannot be satisfied by a nudge.
//
// The bottom bar is checked differently, because its items do not each cross:
// the SEQUENCE reverses. So their left-to-right order by testid is captured and
// required to come back inverted, which catches a bar that mirrors its
// container while leaving its contents in place — the specific thing that
// happens when a flex row's `flex-direction` is mirrored and an inner
// `position: absolute` child is not.
//
// Vault-count precondition: 1 (weak KDF generator fixture).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import { createNote, dismissImporterOffer, openSettings, unlockToEditor } from "./support/flows";
import { type Session } from "./support/webdriver";

/** Elements whose SIDE must flip. Each is a chrome surface a user locates by
 *  side rather than by reading it. */
const MIRRORED = ["editor.sidebar-left", "editor.sidebar-right"] as const;

interface Sides {
  /** Viewport width, so "which half" is computed rather than assumed. */
  readonly viewport: number;
  /** Centre x of each mirrored element, by testid. Missing ones are omitted. */
  readonly centres: Record<string, number>;
  /** Bottom-bar item testids in left-to-right order. */
  readonly barOrder: string[];
}

async function readSides(s: Session): Promise<Sides> {
  const raw = await s.execute<string>(
    "var ids = arguments[0];" +
      "var centres = {};" +
      "for (var i = 0; i < ids.length; i++) {" +
      "  var el = document.querySelector('[data-testid=\"' + ids[i] + '\"]');" +
      "  if (!el) continue;" +
      "  var r = el.getBoundingClientRect();" +
      "  if (r.width <= 0) continue;" +
      "  centres[ids[i]] = r.left + r.width / 2;" +
      "}" +
      "var items = Array.prototype.slice.call(" +
      "  document.querySelectorAll('[data-testid=\"editor.bar-item\"]')" +
      ");" +
      "var order = items" +
      "  .map(function (el) {" +
      "    var r = el.getBoundingClientRect();" +
      "    var inner = el.querySelector('[data-testid]');" +
      "    return { x: r.left + r.width / 2, id: inner ? inner.getAttribute('data-testid') : '' };" +
      "  })" +
      "  .filter(function (o) { return o.id !== ''; })" +
      "  .sort(function (a, b) { return a.x - b.x; })" +
      "  .map(function (o) { return o.id; });" +
      "return JSON.stringify({" +
      "  viewport: document.documentElement.clientWidth," +
      "  centres: centres," +
      "  barOrder: order" +
      "});",
    [MIRRORED as unknown as string[]],
  );
  return JSON.parse(raw) as Sides;
}

/** `[dir, lang]` currently on `<html>`. */
async function rootDir(s: Session): Promise<{ dir: string; lang: string }> {
  return s.execute(
    "return { dir: document.documentElement.getAttribute('dir') || '', " +
      "lang: document.documentElement.getAttribute('lang') || '' };",
  );
}

/** Which half of the window a point is in. */
function half(x: number, viewport: number): "left" | "right" {
  return x < viewport / 2 ? "left" : "right";
}

describeE2E("rms1 the chrome mirrors in an RTL locale (myne-md/myne#555)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("flips each side-anchored surface across the centre and reverses the bottom bar", async () => {
    let seeded: SeededVault;
    await scenario(
      "rms1-rtl-mirror",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);
        // A note, so the sidebar and the editor are both populated — an empty
        // shell can mirror correctly while the populated one does not.
        await createNote(s, "rms1note");

        await s.waitUntil(async () => ((await rootDir(s)).dir === "ltr" ? true : null), {
          label: "the document to start LTR, which every comparison below is against",
          timeoutMs: 10_000,
        });
        const ltr = await readSides(s);

        // NON-VACUITY, twice over. Both surfaces have to be on screen AND on
        // opposite sides to begin with — a run where one is collapsed would
        // compare a missing box against a missing box and pass.
        expect(
          Object.keys(ltr.centres).length,
          `only ${Object.keys(ltr.centres).length} of ${MIRRORED.length} mirrored ` +
            `surfaces rendered with a non-zero width, so this scenario would compare ` +
            `boxes that are not there. A collapsed sidebar is the likely cause — the ` +
            `window may be narrow enough to trip the responsive collapse.`,
        ).toBe(MIRRORED.length);
        expect(
          half(ltr.centres["editor.sidebar-left"]!, ltr.viewport),
          "the LEFT sidebar is not in the left half of an LTR window, so there is " +
            "nothing to flip",
        ).toBe("left");
        expect(
          half(ltr.centres["editor.sidebar-right"]!, ltr.viewport),
          "the RIGHT sidebar is not in the right half of an LTR window",
        ).toBe("right");
        expect(
          ltr.barOrder.length,
          "the bottom bar rendered no identifiable items, so the order assertion " +
            "below compares two empty lists",
        ).toBeGreaterThan(1);

        // Switch to Arabic through the real picker — the same path rtl1 drives.
        await openSettings(s, "appearance");
        await (await s.byTestId("settings.language-select")).click();
        await s.byTestId("settings.language-select-menu", { timeoutMs: 10_000 });
        const options = await s.byTestIdAll("settings.language-select-option");
        let arabic = null;
        for (const o of options) {
          // Endonym labels are not translated; the Arabic entry reads "العربية".
          if ((await o.textContent()).includes("العربية")) {
            arabic = o;
            break;
          }
        }
        expect(arabic, "the picker offers Arabic (an RTL locale)").not.toBeNull();
        await arabic!.click();

        await s.waitUntil(
          async () => {
            const { dir } = await rootDir(s);
            return dir === "rtl" ? true : null;
          },
          { label: "<html> to become dir=rtl", timeoutMs: 10_000 },
        );

        // Close Settings so the chrome underneath is what gets measured.
        await (await s.byTestId("settings.close")).click();
        await s.waitForGone('[data-testid="settings.modal"]');

        // Settled, not sampled: the sidebars animate their width and the bar
        // reflows, so a single read can land mid-transition.
        let rtl = ltr;
        await s.waitUntil(
          async () => {
            const next = await readSides(s);
            const same =
              JSON.stringify(next.centres) === JSON.stringify(rtl.centres) &&
              next.barOrder.join(",") === rtl.barOrder.join(",");
            rtl = next;
            return same ? true : null;
          },
          { label: "the RTL layout to stop moving", timeoutMs: 20_000 },
        );

        for (const id of MIRRORED) {
          const before = half(ltr.centres[id]!, ltr.viewport);
          const after = half(rtl.centres[id] ?? -1, rtl.viewport);
          expect(
            after,
            `${id} is in the ${after} half under an RTL locale and was in the ` +
              `${before} half under an LTR one — it did not cross the centre. ` +
              `<html dir> flipped (asserted above), so this surface is not mirroring ` +
              `with it: a physical \`left\`/\`marginLeft\` in an inline style is ` +
              `unreachable to a logical-property mirror, permanently, and the chrome ` +
              `around it flips while it stays put.`,
          ).not.toBe(before);
        }

        expect(
          rtl.barOrder,
          `the bottom bar's items are in the same left-to-right order under RTL ` +
            `(${rtl.barOrder.join(", ")}). The bar's own box may have mirrored, but ` +
            `its contents did not — which is what happens when a flex row is ` +
            `mirrored and an absolutely-positioned child inside it is not, and it ` +
            `leaves a user reaching for the wrong control by muscle memory.`,
        ).toEqual([...ltr.barOrder].reverse());
      },
    );
  });
});
