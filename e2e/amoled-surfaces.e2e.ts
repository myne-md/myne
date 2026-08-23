// am1 — the AMOLED theme really turns the pixels off. myne-md/myne#555, the
// `appearance.themes` / `settings.panel.appearance` bullet:
//
//   > "the pixels are off" is determined by the value being `#000000`, and a
//   > seam is a computed background-colour read over the named elements
//   > (divider, sidebar edge, bottom bar, ornament layer) — exactly what
//   > `accent-color.e2e.ts` and `ornament.e2e.ts` already do for other tokens.
//
// # What the roster row was actually asking a person to do
//
// Put the app on an OLED panel, switch to AMOLED, and look at whether the dark
// areas are emitting light. That is a hardware observation, and it has exactly
// one determinant in software: whether the painted background is `#000000` or
// merely something close to it. An OLED subpixel is off at zero and lit at one,
// so `#0d0d0c` is not "almost the same" — it is the whole difference between
// the feature working and not.
//
// # Why a token read alone would not settle it
//
// `--_paper-amoled: #000000` is one line of CSS, and asserting it says nothing
// about what any element PAINTS. A surface can carry its own literal, inherit a
// different token, sit under a translucent overlay, or be an inline style that
// outranks every stylesheet — root `CLAUDE.md`'s token-adoption ratchet exists
// because that last one is common. So this reads computed backgrounds off real
// elements in the running app.
//
// # The sweep, and why it is a sweep
//
// Naming four elements tests four elements. The claim is about the SCREEN, so
// the assertion walks every element in the document, keeps the ones that both
// paint an opaque background and cover a real fraction of the viewport, and
// requires all of them to be true black. That is the property "the pixels are
// off" actually means, and it catches a surface nobody thought to name — which
// is the only kind that ever ships wrong.
//
// A structural surface is one covering at least 8 % of the viewport. Chips,
// buttons, badges, selected rows and menu items are all far below that and are
// SUPPOSED to be lit; the sweep is about the ground, not the marks on it.
//
// # The counter-assertion, without which this would be satisfiable by a bug
//
// A theme that painted EVERYTHING `#000000` would pass a black-only sweep and
// be unusable: no divider, no sidebar edge, no seam between panes. So the
// separators are asserted to be non-black in the same run. Both halves have to
// hold, and they pull in opposite directions.
//
// Vault-count precondition: 1 (weak KDF generator fixture).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import { closeSettings, dismissImporterOffer, openSettings, unlockToEditor } from "./support/flows";
import type { Session } from "./support/webdriver";

/** A painted surface the sweep judged. */
type Surface = {
  /** `tag#id[data-testid]`, enough to find it again. */
  what: string;
  /** `rgb(...)` / `rgba(...)` exactly as the engine computed it. */
  color: string;
  /** Share of the viewport it covers, 0..1. */
  share: number;
};

/** A custom property's value as the engine's normalised `rgb(...)` form.
 *
 *  Read back through a probe element rather than compared as text, and that is
 *  a correction rather than a nicety: the first version compared
 *  `getPropertyValue('--paper')` against `"#000000"` and failed against a build
 *  that was completely correct, because the stylesheet's authored value comes
 *  back as `#000` — custom properties are substituted as TOKENS, so the engine
 *  hands back whatever the author typed, shorthand and all. Assigning it to a
 *  real `color` and reading the computed style is what turns it into a colour,
 *  and it makes `#000`, `#000000`, `black` and `rgb(0,0,0)` all answer the same
 *  thing. */
async function tokenAsRgb(s: Session, name: string): Promise<string> {
  const v = await s.execute<string>(
    "var probe = document.createElement('span');" +
      "probe.style.color = 'var(' + arguments[0] + ')';" +
      "document.documentElement.appendChild(probe);" +
      "var out = getComputedStyle(probe).color;" +
      "probe.remove();" +
      "return out;",
    [name],
  );
  return v ?? "";
}

/** Every opaque, structurally-sized painted surface in the document.
 *
 *  "Opaque" is judged from the computed colour's own alpha rather than from
 *  `opacity`: a fully transparent background shows whatever is behind it, so it
 *  cannot light a pixel on its own and is not this test's business. A
 *  PARTIALLY transparent one is, because it composites over the ground and the
 *  result is not black — those are kept and reported. */
async function paintedSurfaces(s: Session, minShare: number): Promise<Surface[]> {
  return (
    (await s.execute<Surface[]>(
      "var out = [];" +
        "var vw = window.innerWidth * window.innerHeight;" +
        "if (!vw) return out;" +
        "var all = document.querySelectorAll('*');" +
        "for (var i = 0; i < all.length; i++) {" +
        "  var el = all[i];" +
        "  var cs = getComputedStyle(el);" +
        "  if (cs.visibility === 'hidden' || cs.display === 'none') continue;" +
        "  var bg = cs.backgroundColor || '';" +
        // `rgba(r,g,b,0)` and the keyword `transparent` both paint nothing.
        "  if (bg === '' || bg === 'transparent') continue;" +
        "  var m = bg.match(/^rgba?\\(([^)]+)\\)$/);" +
        "  if (!m) continue;" +
        "  var parts = m[1].split(',').map(function (x) { return parseFloat(x); });" +
        "  var alpha = parts.length > 3 ? parts[3] : 1;" +
        "  if (!(alpha > 0)) continue;" +
        "  var r = el.getBoundingClientRect();" +
        "  var area = Math.max(0, r.width) * Math.max(0, r.height);" +
        "  var share = area / vw;" +
        "  if (share < arguments[0]) continue;" +
        "  var id = el.getAttribute('data-testid');" +
        "  out.push({" +
        "    what: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (id ? '[' + id + ']' : '')," +
        "    color: bg," +
        "    share: share" +
        "  });" +
        "}" +
        "return out;",
      [minShare],
    )) ?? []
  );
}

/** True for `rgb(0, 0, 0)` and for any fully-opaque `rgba` form of it. */
function isTrueBlack(color: string): boolean {
  const m = color.match(/^rgba?\(([^)]+)\)$/);
  if (!m) return false;
  const parts = m[1]!.split(",").map((x) => parseFloat(x));
  const [r, g, b] = parts;
  const alpha = parts.length > 3 ? parts[3]! : 1;
  return r === 0 && g === 0 && b === 0 && alpha === 1;
}

describeE2E("am1 the AMOLED theme paints true black (myne-md/myne#555)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("turns every structural surface off and still keeps the seams visible", async () => {
    let seeded: SeededVault;
    await scenario(
      "am1-amoled-surfaces",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        // Before: whatever the default theme is, the ground is NOT black.
        // Without this the sweep below could pass on a build where AMOLED does
        // nothing and the default happened to be black already.
        const beforeBody = await s.execute<string>(
          "return getComputedStyle(document.body).backgroundColor;",
        );
        expect(
          isTrueBlack(beforeBody ?? ""),
          `the default theme already paints the body true black (${beforeBody}), so ` +
            `switching to AMOLED would prove nothing about AMOLED`,
        ).toBe(false);

        await openSettings(s, "appearance");
        await (await s.byTestId("settings.theme-amoled")).click();
        // The theme lands on `:root` as a data attribute; wait for the applied
        // value rather than for the click, so a pref that never reached the DOM
        // fails here instead of poisoning every assertion after it.
        await s.waitUntil(
          async () =>
            (await s.execute<string>(
              "return document.documentElement.getAttribute('data-theme');",
            )) === "amoled"
              ? true
              : null,
          { label: "the AMOLED theme reached :root", timeoutMs: 10_000 },
        );
        await closeSettings(s);

        // The token half — cheap, and it names the failure precisely when the
        // stylesheet itself is what regressed.
        expect(isTrueBlack(await tokenAsRgb(s, "--paper")), "--paper under AMOLED").toBe(true);
        expect(isTrueBlack(await tokenAsRgb(s, "--paper-2")), "--paper-2 under AMOLED").toBe(true);

        // The half that matters: what is actually painted.
        const MIN_SHARE = 0.08;
        const surfaces = await paintedSurfaces(s, MIN_SHARE);
        expect(
          surfaces.length,
          `no element painted an opaque background covering ${MIN_SHARE * 100}% of the ` +
            `viewport, which means the sweep found nothing to judge rather than ` +
            `finding everything correct`,
        ).toBeGreaterThan(0);

        const lit = surfaces.filter((x) => !isTrueBlack(x.color));
        expect(
          lit,
          `under AMOLED these structural surfaces are still emitting light:\n` +
            lit
              .map((x) => `  ${x.what} — ${x.color} over ${(x.share * 100).toFixed(1)}% of the viewport`)
              .join("\n") +
            `\nOn an OLED panel a subpixel is off at 0 and lit at anything above it, ` +
            `so a near-black here is not a near-miss: it is the feature not working.`,
        ).toEqual([]);

        // The counter-assertion. A theme that painted everything black would
        // satisfy every line above and have no visible structure at all.
        const line1 = await tokenAsRgb(s, "--line-1");
        expect(
          isTrueBlack(line1),
          `--line-1 is ${line1} under AMOLED — the separator token is true black, so ` +
            `every divider, pane seam and sidebar edge is invisible. Black surfaces ` +
            `alone are not the goal; black surfaces with visible seams are.`,
        ).toBe(false);
      },
    );
  });
});
