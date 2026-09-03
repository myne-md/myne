// Settings rows restack when the panel gets narrow, and unstack when it does
// not — myne-md/myne#556, the `settings.shell` / `settings.panel.editor`
// bullet:
//
//   > the restack is a ResizeObserver over the CONTENT area and the web lane
//   > resizes a real browser window (the 400→2560px sweep already exists):
//   > assert restack below 720px, the Editor panel dropping its 264px preview
//   > column, no label/control rect intersection, and restoration on widening
//   > without a reload.
//
// # Why a real window and not a media query
//
// `settingsCompact.ts` measures the CONTENT area with a `ResizeObserver`, not
// the viewport — so the rail's width, a scrollbar, and the modal's own padding
// all move the threshold, and no CSS media query would agree with it. Only a
// real resize of a real window exercises the thing that actually decides.
//
// The desktop lane cannot do this: `POST /window/rect` there resizes the app
// window, but the desktop suite has no 400→2560 sweep and WebKitGTK's window
// manager under xvfb does not honour arbitrary rects reliably. This is
// web-specific behaviour by the `e2e-web/CLAUDE.md` rule, and it is where the
// browser lane earns its keep.
//
// # What breaks without it
//
// The failure is not "the layout looks odd". A row that keeps its side-by-side
// shape in a narrow panel puts the label and the control in the same horizontal
// band, and one of them wins: either the label truncates to nothing or the
// control is pushed past the edge and cannot be reached at all. A setting
// nobody can toggle is a setting that does not exist, and it happens only at
// widths nobody has open while developing.
//
// # Restoration is asserted separately, and it is the half that regresses
//
// A `ResizeObserver` that fires on shrink and not on grow leaves the panel
// permanently compact after one narrow moment — a window briefly dragged small,
// a split-screen, a rotated tablet. The user widens the window back and the
// layout stays broken until a reload, which is the shape a one-directional
// assertion cannot see.

import { expect, it } from "vitest";
import { describeE2E } from "./support/scenario";
import { openFixtureVault, openSettingsTab } from "./support/fixture-session";
import type { Session } from "./support/session";

/** Resize the real browser window and let the observers settle. */
async function resizeTo(session: Session, width: number, height: number): Promise<void> {
  await session.send("POST", "/window/rect", { width, height, x: 0, y: 0 });
  // Two frames: one for the browser to lay out, one for the ResizeObserver
  // callback and the React re-render it schedules. Waited on the OBSERVABLE
  // below rather than trusted, but a frame here keeps the first poll from
  // measuring the pre-resize layout.
  await session.execute(
    "return new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });",
  );
}

/** How many Settings rows are currently in their compact (stacked) shape. */
async function compactRows(session: Session): Promise<number> {
  return (
    (await session.execute<number>(
      "return document.querySelectorAll('[data-setting-row][data-setting-compact=\"true\"]').length;",
    )) ?? 0
  );
}

/** Total Settings rows on screen, compact or not. */
async function totalRows(session: Session): Promise<number> {
  return (
    (await session.execute<number>(
      "return document.querySelectorAll('[data-setting-row]').length;",
    )) ?? 0
  );
}

/**
 * Rows whose label box and control box overlap horizontally AND vertically.
 *
 * The actual user-visible failure, measured rather than inferred from the
 * `data-setting-compact` attribute — an attribute that flipped while the layout
 * did not would pass an attribute-only check and still hand the user an
 * unreachable control.
 */
async function overlappingRows(session: Session): Promise<string[]> {
  return (
    (await session.execute<string[]>(
      "var out = [];" +
        "var rows = document.querySelectorAll('[data-setting-row]');" +
        "for (var i = 0; i < rows.length; i++) {" +
        "  var row = rows[i];" +
        "  var label = row.querySelector('span');" +
        "  var control = row.querySelector('button,input,select,[role=\"switch\"],[role=\"radiogroup\"]');" +
        "  if (!label || !control) continue;" +
        "  var a = label.getBoundingClientRect();" +
        "  var b = control.getBoundingClientRect();" +
        "  if (a.width === 0 || b.width === 0) continue;" +
        "  var overlapX = a.left < b.right && b.left < a.right;" +
        "  var overlapY = a.top < b.bottom && b.top < a.bottom;" +
        "  if (overlapX && overlapY) {" +
        "    out.push((row.getAttribute('data-setting-anchor') || row.getAttribute('data-testid') || 'row ' + i) +" +
        "      ' label=' + JSON.stringify(a) + ' control=' + JSON.stringify(b));" +
        "  }" +
        "}" +
        "return out;",
    )) ?? []
  );
}

describeE2E("the Settings panel restacks on a narrow window", () => {
  it("stacks below the threshold, unstacks above it, and never overlaps", async () => {
    const ctx = await openFixtureVault();
    try {
      const { session } = ctx;
      // Editor: the panel the bullet names, and the one with a preview column
      // to drop.
      await openSettingsTab(session, "settings.tab-editor");

      // WIDE first, so the narrow measurement below has a baseline that is not
      // itself the compact state. Without this "some rows are compact" is
      // satisfiable by a panel that is always compact.
      await resizeTo(session, 1600, 1000);
      await session.waitUntil(
        async () => ((await compactRows(session)) === 0 ? true : null),
        { label: "no row is compact at 1600px", timeoutMs: 15_000 },
      );
      const wideTotal = await totalRows(session);
      expect(
        wideTotal,
        "the Editor panel rendered no setting rows, so this scenario is measuring " +
          "an empty panel",
      ).toBeGreaterThan(2);
      expect(
        await overlappingRows(session),
        "a Settings row's label and control already overlap at 1600px, before any " +
          "resize — the restack is not the problem",
      ).toEqual([]);

      // NARROW. Below the 720px content threshold `settingsCompact.ts` sets.
      await resizeTo(session, 560, 1000);
      let compact = 0;
      let widths = "";
      await session.waitUntil(
        async () => {
          compact = await compactRows(session);
          widths =
            (await session.execute<string>(
              "var modal = document.querySelector('[data-testid=\"settings.modal\"]');" +
                "var row = document.querySelector('[data-setting-row]');" +
                "return 'inner=' + window.innerWidth +" +
                "  ' modal=' + (modal ? Math.round(modal.getBoundingClientRect().width) : -1) +" +
                "  ' row=' + (row ? Math.round(row.getBoundingClientRect().width) : -1);",
            )) ?? "";
          return compact > 0 ? true : null;
        },
        {
          label: () =>
            `the rows to restack at 560px — ${compact} of ${wideTotal} are compact, ` +
            `measured widths ${widths}. ` +
            `The threshold is measured on the CONTENT area by a ResizeObserver, not ` +
            `on the viewport, so a row that keeps its side-by-side shape here puts ` +
            `the label and the control in one horizontal band and pushes one of ` +
            `them past the edge.`,
          timeoutMs: 15_000,
        },
      );
      expect(compact).toBeGreaterThan(0);

      // …and the layout genuinely does not collide. The attribute flipping is
      // not the claim; the boxes not overlapping is.
      const collisions = await overlappingRows(session);
      expect(
        collisions,
        `at 560px these rows have a label box overlapping their control box:\n` +
          collisions.join("\n") +
          `\nOne of the two is then unreachable, and a setting nobody can toggle is ` +
          `a setting that does not exist — at widths nobody has open while ` +
          `developing.`,
      ).toEqual([]);

      // WIDE AGAIN, without a reload. This is the half that regresses: a
      // ResizeObserver that fires on shrink and not on grow leaves the panel
      // permanently compact after one narrow moment.
      await resizeTo(session, 1600, 1000);
      await session.waitUntil(
        async () => ((await compactRows(session)) === 0 ? true : null),
        {
          label:
            "the rows to UNSTACK on widening, without a reload — a one-directional " +
            "observer leaves the panel compact forever after one narrow moment " +
            "(a window dragged small, a split-screen, a rotated tablet)",
          timeoutMs: 15_000,
        },
      );

      // The panel is still whole: nothing was dropped by the round trip.
      expect(
        await totalRows(session),
        "the Editor panel lost rows across the resize round trip",
      ).toBe(wideTotal);
    } finally {
      await ctx.browser.teardown().catch(() => {});
      await ctx.server.close();
    }
  });
});
