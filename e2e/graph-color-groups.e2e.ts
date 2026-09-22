// Graph color-groups paint suite (graph-connection-ux-polish task 8). A color
// group is an ordered rule pairing a filter with one of the eight categorical
// `--group-*` design tokens; the graph renderer consumes the resolved
// note-id → color-key map AT PAINT TIME and resolves each key off the canvas's
// own computed style — so group colors follow the theme, dark mode and a
// custom theme's token override for free.
//
//   gc1 — author a tag rule and watch it PAINT without re-laying-out: with two
//         tagged notes in the graph, `data-colored-node-count` starts at "0";
//         adding a rule and pointing its filter at `#alpha` takes it to "1"
//         while `data-layout-nonce` stays pinned at "1" (the pane's existing
//         flashbang-free probe, reused here for "editing a rule repaints, it
//         does not re-run the layout" — the load-bearing constraint that colour
//         is a render-time LAYER and never part of the layout model). The
//         canvas's actual pixels are then read back to prove the matching node
//         really carries the group colour and the unmatched one does not.
//         Switching the colour repaints in the new token; switching the THEME
//         bumps `data-palette-nonce` (the canvas re-resolved its tokens) and
//         repaints in the theme's value — again with no layout re-run. Finally
//         a CUSTOM theme carrying its own `--group-rose` override is applied,
//         and the node repaints in the theme author's value: the two theme
//         mechanisms are different (`applyTheme` sets `<html data-theme>`,
//         `applyCustomTheme` writes `--*` onto its inline style) and only
//         driving both proves the canvas's single attribute observer covers
//         each of them.
//
//   gc2 — the rules SURVIVE A RESTART (task 7's persistence criterion). A rule
//         is authored in full — name, a non-default palette colour, a tag
//         filter — and the graph is watched painting it; then the vault is
//         locked and re-unlocked (the app's own restart-equivalent remount,
//         `gs1`'s persistence act) and the SAME three things are asserted from
//         disk truth: the canvas paints the node in that colour again with no
//         rule authored this session, and reopening the panel lists exactly
//         one rule carrying its name, its enabled state, its colour and its
//         tag condition. Colour groups live in `vault.prefs` (task 2), NOT in
//         the device-local workspace descriptor the panel's physics settings
//         use — so this scenario is the read-back proof for a different blob
//         than `gs1`'s, and neither stands in for the other.
//
// Why data-* AND pixels, unlike its sibling suites: the graph body is a
// force-laid-out <canvas>, so `graph-layout-persistence.e2e.ts` and
// `graph-settings.e2e.ts` deliberately assert bounded `data-*` observability
// rather than pixels. Here the whole claim under test IS a pixel colour, so the
// bounded attributes carry the "did it re-run the layout" half and one
// `getImageData` scan carries the "is that node actually teal" half. The
// attributes read here are DENY-list clean (a count and two opaque monotonic
// nonces — never a note id, a title or a coordinate; SYNC-8).
//
// KDF: weak generator fixture (SYNC-9 — params are vault.meta-resident).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  closeSettings,
  createNote,
  dismissImporterOffer,
  lockAndReunlock,
  openSettings,
  openSettledGraphPane,
  pageSeatInvoke,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { testIdSelector, type Element, type Session } from "./support/webdriver";

const HERE = dirname(fileURLToPath(import.meta.url));

/** A complete, valid custom theme (every required-core token) that ALSO
 *  overrides one palette token — the ct2 Catppuccin fixture with
 *  `--group-rose` re-pointed at a colour no built-in theme uses, so the pixel
 *  read cannot pass by accident. Built here rather than as a second fixture
 *  file: ct2 owns that file and must keep asserting its own values. */
const OVERRIDE_RGB: [number, number, number] = [255, 0, 255];
const CUSTOM_THEME_NAME = "gc1-group-override";
const CUSTOM_THEME_JSON = JSON.stringify({
  ...(JSON.parse(
    readFileSync(join(HERE, "fixtures", "themes", "catppuccin-mocha.json"), "utf8"),
  ) as Record<string, string>),
  "--group-rose": "#ff00ff",
});

// Distinct note titles so the graph has nodes to lay out. Shared by both
// scenarios — each runs in its own data dir, so the fixture is the same shape
// and the titles are opaque tokens either way.
const TITLES = ["gc1notealfa7k2m9qx4w8e5rj0aa", "gc1notebravo3f6h1zn8c2vb5kk0"];
// Leading space so the FIRST inline tag has the required (^|\s) boundary even
// after typeIntoEditor's sacrificial probe char (the tb1 precedent). Bravo also
// WIKILINKS to alfa — see `seedTaggedNotes`.
const MARKS = [" #alfagroup", ` [[${TITLES[0]}]] #bravogroup`];

/** Two notes, only the first tagged `#alfagroup`, with the second LINKING to
 *  the first — the fixture both scenarios lay out and colour.
 *
 *  The link is load-bearing for the pixel reads, not decoration. Two
 *  *disconnected* nodes are held together only by the weak centre force while
 *  repulsion pushes them apart, and `GraphCanvas` has no fit-to-view: a node
 *  can settle outside the canvas box entirely, at which point its colour has no
 *  pixels to count and the probe fails for a reason that has nothing to do with
 *  colour groups. Observed directly — a canvas carrying ~144 opaque pixels
 *  total (≈70 per node) dropping to one node's worth. One edge binds the pair
 *  the way `graph-settings.e2e.ts`'s chain fixture does. */
async function seedTaggedNotes(s: Session): Promise<void> {
  for (let i = 0; i < TITLES.length; i += 1) {
    await createNote(s, TITLES[i] as string);
    await typeIntoEditor(s, MARKS[i] as string);
    await waitForSaved(s);
  }
}

/** The leading three channels of a computed `rgb(...)` / `rgba(...)` string. */
function parseRgb(raw: string): [number, number, number] {
  const parts = raw.match(/\d+/g) ?? [];
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

/** Resolve a `--group-*` design token to the concrete `rgb(...)` string the
 *  canvas will have painted with, under whatever theme is currently applied. */
async function tokenRgb(s: Session, token: string): Promise<[number, number, number]> {
  const raw = await s.execute<string>(
    "var probe = document.createElement('span');" +
      "probe.style.color = 'var(" +
      token +
      ")';" +
      "document.body.appendChild(probe);" +
      "var v = getComputedStyle(probe).color;" +
      "probe.remove();" +
      "return v;",
  );
  return parseRgb(raw);
}

/** The rule row's own colour swatch, as the browser actually computes it. The
 *  swatch carries no colour-key attribute (its colour IS its `background:
 *  var(--…)` style), so the read goes through computed style rather than an
 *  attribute — production code stays untouched. */
async function rowSwatchRgb(s: Session): Promise<[number, number, number]> {
  const raw = await s.execute<string | null>(
    "var el = document.querySelector('[data-testid=\"editor.color-group-swatch\"]');" +
      "return el ? getComputedStyle(el).backgroundColor : null;",
  );
  if (raw === null) throw new Error("no color-group row swatch on the page");
  return parseRgb(raw);
}

/** How many pixels of the graph canvas are (near-)exactly `rgb`. The nodes are
 *  filled discs, so a matched node contributes a solid block of them; an
 *  unmatched colour contributes none beyond antialiasing noise, hence the
 *  tolerance-free comparison and the generous "> 20" threshold at the call
 *  sites rather than "> 0". */
async function pixelCount(
  s: Session,
  rgb: [number, number, number],
): Promise<number> {
  return await s.execute<number>(
    "var c = document.querySelector('[data-testid=\"editor.graph-canvas\"]');" +
      "if (!c) return -1;" +
      "var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;" +
      "var n = 0;" +
      "for (var i = 0; i < d.length; i += 4) {" +
      "  if (d[i] === arguments[0] && d[i + 1] === arguments[1] && d[i + 2] === arguments[2] && d[i + 3] > 200) n += 1;" +
      "}" +
      "return n;",
    [rgb[0], rgb[1], rgb[2]],
  );
}

/** The canvas's `data-palette-nonce` — the opaque monotonic counter it bumps
 *  when it re-resolves its design tokens. Read through a FRESH query rather
 *  than a held handle: the settings modal that drives the theme switch can
 *  remount the pane underneath, and a stale WebDriver element reference would
 *  fail the poll for the wrong reason. `null` while the canvas is unmounted. */
async function paletteNonce(s: Session): Promise<string | null> {
  return await s.execute<string | null>(
    "var c = document.querySelector('[data-testid=\"editor.graph-canvas\"]');" +
      "return c ? c.getAttribute('data-palette-nonce') : null;",
  );
}

/** Fill the rule-filter modal that is ALREADY open, through the shared filter
 *  builder, the same modal Saved Views uses, here restricted to tag+folder.
 *  It does not open the modal: since myne-md/myne#727's curation pass, `Add
 *  rule` opens it directly and the rule only exists once it is saved, so the
 *  create path and the edit path differ in how they OPEN it and not in how they
 *  fill it. */
async function fillRuleFilterModal(s: Session, tag: string): Promise<void> {
  await s.byTestId("view-filter.modal", { timeoutMs: 8_000 });
  await (await s.byTestId("view-filter.add-condition-first")).click();
  await s.byTestId("view-filter.condition");
  // The new condition already defaults to type "tag" (the only sensible
  // default now that the builder is restricted to tag+folder here), so only
  // the value needs picking.
  await (await s.byTestId("view-filter.condition-value")).click();
  await (
    await s.waitForElement(
      testIdSelector("view-filter.condition-value-option", { "data-value": tag }),
    )
  ).click();
  await (await s.byTestId("view-filter.save")).click();
  await s.waitForGone(testIdSelector("view-filter.modal"));
}

/**
 * `data-canvas-model-nonce`, once it has stopped moving.
 *
 * Reading it straight after a condition the PANE satisfied is a race: the pane's
 * attributes are written during React's render, and the canvas's `[model]` effect
 * (which is what writes this one) runs after the commit. The first read can
 * therefore catch the previous value, which is a flake rather than a finding
 * (myne-md/myne#727).
 */
async function settledModelNonce(
  s: Session,
  canvas: Element,
  timeoutMs = 5_000,
): Promise<string | null> {
  let last: string | null = null;
  let run = 0;
  await s.waitUntil(
    async () => {
      const cur = await canvas.attribute("data-canvas-model-nonce");
      run = cur !== null && cur === last ? run + 1 : 0;
      last = cur;
      return run >= 2 ? true : null;
    },
    { label: "canvas model nonce settled", timeoutMs, intervalMs: 150 },
  );
  return last;
}

describeE2E("gc1 color groups paint the graph without re-running the layout", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("authors a tag rule, repaints on colour + theme change, never re-lays-out", async () => {
    let password = "";
    await scenario(
      "gc1-graph-color-groups",
      {
        seed: (dir) => {
          password = seedVault(dir).password;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Two tagged notes: only the first carries #alfagroup.
        await seedTaggedNotes(s);

        const { pane, canvas } = await openSettledGraphPane(s);
        // No rules yet → every node neutral.
        expect(await pane.attribute("data-colored-node-count")).toBe("0");

        const olive = await tokenRgb(s, "--group-olive");
        expect(await pixelCount(s, olive)).toBe(0);

        // --- Author one rule: #alfagroup → the palette's first colour. -------
        await (await s.byTestId("editor.graph-settings-gear")).click();
        await s.byTestId("editor.graph-settings-panel");
        await (await s.byTestId("editor.color-group-add")).click();
        await fillRuleFilterModal(s, "alfagroup");
        await s.byTestId("editor.color-group-row");

        await s.waitUntil(
          async () =>
            (await pane.attribute("data-colored-node-count")) === "1" ? true : null,
          { label: "one node matched the rule", timeoutMs: 10_000 },
        );
        // The load-bearing assertion: a rule edit REPAINTS, it does not
        // re-build the model or re-run the layout.
        expect(await pane.attribute("data-layout-nonce")).toBe("1");
        // This FIRST rule edit is the one case that does rebuild the canvas
        // (task 18): it is a bare `hasTag` rule, so it introduces a tag NODE,
        // and the tag nodes are part of the model the canvas lays out. The
        // canvas-side counter is captured here rather than asserted at zero,
        // because the honest claim is "everything AFTER the hub arrived is
        // repaint-only", which is what the three assertions below check.
        const canvasModelNonce = await settledModelNonce(s, canvas);
        expect(canvasModelNonce).not.toBeNull();
        // …and the rule really did put a TAG NODE in the picture (task 18): the
        // tag it filters on is a bare `hasTag` rule, so it claims a hub. This is
        // the E2E half of "tags become nodes", the model-side half is in
        // `tests/notes/graphModel.test.ts`.
        expect(await pane.attribute("data-tag-node-count")).toBe("1");

        // …and the matching node really is painted in the group colour.
        await s.waitUntil(
          async () => ((await pixelCount(s, olive)) > 20 ? true : null),
          { label: "matched node painted olive", timeoutMs: 10_000 },
        );

        // --- Change the rule's colour: repaint in the new token, no relayout.
        const rose = await tokenRgb(s, "--group-rose");
        expect(await pixelCount(s, rose)).toBe(0);
        await (await s.byTestId("editor.color-group-swatch")).click();
        await (
          await s.waitForElement(
            testIdSelector("editor.color-group-palette-swatch", {
              "data-color-key": "group-rose",
            }),
          )
        ).click();
        await s.waitUntil(
          async () => ((await pixelCount(s, rose)) > 20 ? true : null),
          { label: "matched node repainted rose", timeoutMs: 10_000 },
        );
        expect(await pixelCount(s, olive)).toBe(0);
        expect(await pane.attribute("data-layout-nonce")).toBe("1");
        expect(await pane.attribute("data-colored-node-count")).toBe("1");
        // A COLOUR change moves no hub and must not rebuild the canvas: this is
        // the repaint-only contract in the one place it can be observed
        // directly (myne-md/myne#727 task 18).
        expect(await settledModelNonce(s, canvas)).toBe(canvasModelNonce);
        expect(await pane.attribute("data-tag-node-count")).toBe("1");

        // --- Theme switch: the canvas re-resolves its tokens and repaints in
        // the new theme's value for the SAME colour key — still no relayout.
        const nonceBefore = await paletteNonce(s);
        await openSettings(s, "appearance");
        await (await s.byTestId("settings.theme-dark")).click();
        await closeSettings(s);
        await s.waitUntil(
          async () => {
            const cur = await paletteNonce(s);
            return cur !== null && cur !== nonceBefore ? true : null;
          },
          { label: "canvas re-resolved its palette on theme switch" },
        );
        const roseDark = await tokenRgb(s, "--group-rose");
        expect(roseDark).not.toEqual(rose); // the token really did change value
        await s.waitUntil(
          async () => ((await pixelCount(s, roseDark)) > 20 ? true : null),
          { label: "node repainted in the dark-theme token", timeoutMs: 10_000 },
        );
        expect(await pane.attribute("data-layout-nonce")).toBe("1");
        expect(await settledModelNonce(s, canvas)).toBe(canvasModelNonce);

        // --- A CUSTOM theme's own token override wins too. The built-in
        // switch above moves `<html data-theme>`; a custom theme instead writes
        // `--*` onto `<html>`'s inline style, so this is the second, genuinely
        // different mechanism the canvas's attribute observer has to catch.
        // Sealed through the real `themes_import` IPC from the page seat (ct2's
        // sanctioned pattern — the OS file dialog is undriveable), then applied
        // through the real Settings row.
        expect(await pixelCount(s, OVERRIDE_RGB)).toBe(0);
        const imported = await pageSeatInvoke(
          s,
          "plugin:themes|themes_import",
          { name: CUSTOM_THEME_NAME, paletteJson: CUSTOM_THEME_JSON },
          15_000,
        );
        if (imported.err !== undefined) {
          throw new Error("themes_import failed: " + JSON.stringify(imported.err));
        }
        await openSettings(s, "appearance");
        const rowSel = testIdSelector("settings.custom-theme-row", {
          "data-theme-name": CUSTOM_THEME_NAME,
        });
        await s.waitForElement(rowSel);
        await (await s.byTestId("settings.custom-theme-apply")).click();
        await s.waitUntil(
          async () =>
            (await (await s.findElement(rowSel)).attribute("data-active")) === "true" || null,
          { label: "custom-theme row data-active === true" },
        );
        await closeSettings(s);

        await s.waitUntil(
          async () => ((await pixelCount(s, OVERRIDE_RGB)) > 20 ? true : null),
          { label: "node repainted in the custom theme's override", timeoutMs: 10_000 },
        );
        expect(await pane.attribute("data-layout-nonce")).toBe("1");
        expect(await pane.attribute("data-colored-node-count")).toBe("1");
        expect(await settledModelNonce(s, canvas)).toBe(canvasModelNonce);
      },
    );
  });
});

/** The rule's name. In-source scenario content, not a credential (SYNC-13) —
 *  and deliberately not a word any default copy contains, so reading it back
 *  cannot pass on placeholder text. */
const RULE_NAME = "gc2ruleteal9w3q";
/** Not the palette's first entry (a fresh rule defaults to `group-olive`), so
 *  the colour read back after the restart proves the STORED value rather than
 *  the default. */
const RULE_COLOR_KEY = "group-teal";
const RULE_COLOR_TOKEN = "--group-teal";

describeE2E("gc2 color-group rules survive a restart", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("re-paints from disk truth and re-lists name, colour and filter after lock → re-unlock", async () => {
    let password = "";
    await scenario(
      "gc2-graph-color-groups-persist",
      {
        seed: (dir) => {
          password = seedVault(dir).password;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await seedTaggedNotes(s);

        const { pane } = await openSettledGraphPane(s);
        expect(await pane.attribute("data-colored-node-count")).toBe("0");

        // --- Author one rule, completely: name, a non-default colour, filter.
        await (await s.byTestId("editor.graph-settings-gear")).click();
        await s.byTestId("editor.graph-settings-panel");
        await (await s.byTestId("editor.color-group-add")).click();
        await fillRuleFilterModal(s, "alfagroup");
        await s.byTestId("editor.color-group-row");

        const nameInput = await s.byTestId("editor.color-group-name");
        await nameInput.sendKeys(RULE_NAME);
        await nameInput.sendKeys(""); // Enter → blur → commit (the real gesture)

        await (await s.byTestId("editor.color-group-swatch")).click();
        await (
          await s.waitForElement(
            testIdSelector("editor.color-group-palette-swatch", {
              "data-color-key": RULE_COLOR_KEY,
            }),
          )
        ).click();

        // The filter was set when the rule was CREATED, above, so there is no
        // second edit pass here any more.

        const teal = await tokenRgb(s, RULE_COLOR_TOKEN);
        await s.waitUntil(
          async () =>
            (await pane.attribute("data-colored-node-count")) === "1" ? true : null,
          { label: "one node matched the rule", timeoutMs: 10_000 },
        );
        await s.waitUntil(
          async () => ((await pixelCount(s, teal)) > 20 ? true : null),
          { label: "matched node painted teal", timeoutMs: 10_000 },
        );

        // --- Restart. Lock drops the keys and unmounts the whole workspace;
        // re-unlocking rebuilds it from what is actually on disk, so
        // everything asserted below came back out of `vault.prefs` rather than
        // out of this session's React state.
        await lockAndReunlock(s, password);

        const { pane: pane2 } = await openSettledGraphPane(s);

        // The rule is LIVE again with nothing authored this session: the graph
        // paints the same node in the same group colour.
        await s.waitUntil(
          async () =>
            (await pane2.attribute("data-colored-node-count")) === "1" ? true : null,
          { label: "rule still matches one node after restart", timeoutMs: 15_000 },
        );
        await s.waitUntil(
          async () => ((await pixelCount(s, teal)) > 20 ? true : null),
          { label: "matched node painted teal after restart", timeoutMs: 15_000 },
        );

        // …and the EDITOR lists it: exactly one rule, with the name, enabled
        // state and colour it was given.
        await (await s.byTestId("editor.graph-settings-gear")).click();
        await s.byTestId("editor.graph-settings-panel");
        await s.byTestId("editor.color-groups-list");
        expect((await s.byTestIdAll("editor.color-group-row")).length).toBe(1);
        expect(await (await s.byTestId("editor.color-group-name")).property<string>("value")).toBe(
          RULE_NAME,
        );
        expect(await (await s.byTestId("editor.color-group-enabled")).attribute("aria-checked")).toBe(
          "true",
        );
        expect(await rowSwatchRgb(s)).toEqual(teal);

        // The FILTER survived too, as a filter and not just as a painted
        // pixel: reopening the builder shows the one tag condition, with
        // `alfagroup` still the selected value.
        await (await s.byTestId("editor.color-group-edit-filter")).click();
        await s.byTestId("view-filter.modal", { timeoutMs: 8_000 });
        expect((await s.byTestIdAll("view-filter.condition")).length).toBe(1);
        const valueTrigger = await s.byTestId("view-filter.condition-value");
        await valueTrigger.click();
        const selected = await s.waitForElement(
          testIdSelector("view-filter.condition-value-option", { "data-value": "alfagroup" }),
        );
        expect(await selected.attribute("data-active")).toBe("true");
        // Close the (portaled) option menu before dismissing the modal, or the
        // overlay eats the Cancel click.
        await valueTrigger.click();
        await s.waitForGone(testIdSelector("view-filter.condition-value-menu"));
        await (await s.byTestId("view-filter.cancel")).click();
        await s.waitForGone(testIdSelector("view-filter.modal"));
      },
    );
  });
});
