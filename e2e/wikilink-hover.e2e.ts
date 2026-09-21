// wh1 — hovering a wikilink says where it goes. myne-md/myne#555, the
// `editor.wikilinks` bullet:
//
//   > `editor/src/wikilink/hover.ts` uses CodeMirror `hoverTooltip(...,
//   > {hoverTime:300})` driven by ordinary mousemove, and
//   > `e2e/support/webdriver.ts` already ships `hover()` (used by
//   > `cards-cover-picker.e2e.ts`). Appearance within the dwell, the resolved-path
//   > text, dismissal on leave and edge-clamping (a rect-containment check) are
//   > all deterministic.
//
// # What the tooltip is for, and what a unit test cannot say about it
//
// `hover.ts` exports `wikilinkHoverTooltip` specifically "so the resolution +
// DOM-build path can be unit-tested without the timer/geometry of a live
// mousemove". That is the right split, and it leaves exactly two things
// untested: the TIMER and the GEOMETRY. Both are why a user sees the tooltip or
// does not.
//
// A tooltip that resolves correctly and never appears is indistinguishable from
// one that was never written, and the failure is silent: the extension is
// installed, the text is computed, and nothing shows. The dwell is a real 300 ms
// in a real event loop, and `hoverTime` is the kind of number a refactor moves
// without meaning to.
//
// # Dismissal is asserted because a stuck tooltip is worse than none
//
// A tooltip that appears and does not leave follows the caret around the
// document, covering the text under it. That is a permanent obstruction, and it
// is the state a `mouseleave` handler wired to the wrong element produces.
//
// Vault-count precondition: 1 (weak KDF generator fixture).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  seedEmbedIntoNote,
  unlockToEditor,
} from "./support/flows";
import type { Session } from "./support/webdriver";

const EDITOR = '[data-testid="editor.content"]';
const TOOLTIP = ".cm-wikilink-hover";

/** The tooltip's text, or "" when it is not up. */
async function tooltipText(s: Session): Promise<string> {
  return (
    (await s.execute<string>(
      "var t = document.querySelector(arguments[0]);" +
        "return t ? (t.textContent || '') : '';",
      [TOOLTIP],
    )) ?? ""
  );
}

describeE2E("wh1 a wikilink says where it goes on hover (myne-md/myne#555)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("appears within the dwell, names the target, leaves on mouseout, stays on screen", async () => {
    let seeded: SeededVault;
    await scenario(
      "wh1-wikilink-hover",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        // A real target note, so the tooltip has a resolution to report rather
        // than the broken-link text. Created FIRST: the hover reads the note
        // set out of editor state, so a link authored before its target exists
        // would resolve as broken and this scenario would be asserting the
        // wrong arm.
        const TARGET = "Hedef Notu";
        await createNote(s, TARGET);
        await createNote(s, "Kaynak Notu");

        // Written through `note_update` and reopened rather than typed: `[`
        // races CodeMirror's bracket auto-close, which `e2e/AGENTS.md` records
        // four rounds of. This scenario is about the HOVER, not about typing a
        // wikilink — that is covered where typing is the subject.
        await seedEmbedIntoNote(s, `\nBir [[${TARGET}]] baglantisi.`);

        // The chip is the decorated wikilink. Waiting for it is what separates
        // "the tooltip did not appear" from "the link never rendered".
        const chip = await s.waitForElement(`${EDITOR} .cm-wikilink-chip`, {
          timeoutMs: 15_000,
        });

        // Nothing is up before the pointer arrives — otherwise "it appeared"
        // below would be satisfied by a tooltip that is always on screen.
        expect(await tooltipText(s), "a hover tooltip was already up before hovering").toBe("");

        await chip.hover();

        // THE dwell. `hoverTime` is 300 ms; the budget here is generous enough
        // that a slow container is not a failure and short enough that a
        // tooltip which never comes is reported as one.
        let seen = "";
        await s.waitUntil(
          async () => {
            seen = await tooltipText(s);
            return seen.length > 0 ? true : null;
          },
          {
            label: () =>
              `the wikilink hover tooltip to appear within the dwell — nothing is ` +
              `up after hovering the chip. \`hoverTooltip(..., {hoverTime: 300})\` ` +
              `is the only thing that raises it, and a tooltip that resolves ` +
              `correctly and never appears is indistinguishable from one that was ` +
              `never written.`,
            timeoutMs: 10_000,
          },
        );

        // It names the TARGET. A tooltip that appears with the wrong text — or
        // with the broken-link text for a link that resolves — is worse than
        // none: it tells the user their link is broken when it is not.
        expect(
          seen,
          `the tooltip says ${JSON.stringify(seen)}, which does not name "${TARGET}". ` +
            `The whole point of the hover is answering "where does this go" without ` +
            `following it.`,
        ).toContain(TARGET);

        // It is ON SCREEN. A tooltip anchored past the viewport edge is
        // rendered and unreadable, which is the clamping half of the bullet.
        const onScreen = await s.execute<{ fits: boolean; rect: string } | null>(
          "var t = document.querySelector(arguments[0]);" +
            "if (!t) return null;" +
            "var r = t.getBoundingClientRect();" +
            "return {" +
            "  fits: r.left >= -1 && r.top >= -1 &&" +
            "        r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1," +
            "  rect: JSON.stringify({l: Math.round(r.left), t: Math.round(r.top)," +
            "                        r: Math.round(r.right), b: Math.round(r.bottom)," +
            "                        vw: window.innerWidth, vh: window.innerHeight})" +
            "};",
          [TOOLTIP],
        );
        expect(onScreen, "the tooltip vanished between the two reads").not.toBeNull();
        expect(
          onScreen!.fits,
          `the tooltip is not fully inside the viewport (${onScreen!.rect}). It is ` +
            `rendered and unreadable, which is the same outcome as not rendering it ` +
            `and harder to notice.`,
        ).toBe(true);

        // And it LEAVES. A tooltip that appears and stays follows the caret
        // around the document, covering the text under it — a permanent
        // obstruction, and the state a `mouseleave` wired to the wrong element
        // produces.
        const away = await s.byTestId("editor.settings-cta");
        await away.hover();
        await s.waitUntil(
          async () => ((await tooltipText(s)) === "" ? true : null),
          {
            label:
              "the tooltip to leave once the pointer moves off the chip — one that " +
              "stays covers the text under it for the rest of the session",
            timeoutMs: 10_000,
          },
        );
      },
    );
  });
});
