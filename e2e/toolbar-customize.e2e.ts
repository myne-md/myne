// Floating-toolbar customization suite (MYND-336, PR #98
// polish/editor-outline; Settings list
// `src/components/settings/ToolbarCustomizeSettings.tsx`, vocabulary
// `src/notes/toolbarItems.ts`, live feed `src/notes/ToolbarLayoutSync.tsx`,
// renderer `editor/src/toolbar/plugin.ts`).
//
// Pins the customize → render contract through the production binary:
//
//   tc1: the Settings → Editor "Toolbar" list hides/shows a control and the
//     floating selection toolbar follows: hiding "highlight" drops its button
//     from the next toolbar render, un-hiding restores it; both states READ
//     BACK from disk across a Settings reopen (the persistence regression this
//     PR fixed: the list loads `prefsRead()` in a mount effect). Every
//     vocabulary row is toggleable: the five list/quote/wikilink rows used to be
//     pinned "Coming soon" and are asserted ENABLED here, which is the pin-lift
//     proof (issue #970, item 1).
//
//   tc3: the commands behind those five rows actually run: switching "quote" on
//     makes its button appear on the selection toolbar, pressing it prefixes the
//     line with "> ", and the setting survives a reopen.
//
// Driving notes: the floating toolbar needs a non-empty text selection.
// This suite double-clicks the note's single word (`Element.doubleClick`,
// the folder-row MYND-370 primitive) — the PR's mouseup catch-all
// re-evaluates the toolbar on every double-click, so the surface-and-check
// runs inside ONE retry loop: each iteration re-selects (a fresh render
// that re-reads the fed layout) and only a render matching the expected
// highlight presence/absence passes — a late prefs propagation heals on
// the next iteration instead of flaking. `.cm-toolbar` (a CM-plugin
// surface, the `.cm-content` selector-exception class) is the positive
// control that the toolbar IS up when asserting the button's absence.
// `toolbar.highlight` is the one renderable control carrying a testid,
// which is what makes it the byTestId-observable hide/show probe.
//
// In-source scenario constants are not credentials; SYNC-13 applies to
// passwords/phrases, which never appear in any assert below. KDF: weak
// generator fixture (unlock reads params from vault.meta).
//
// ⚠ PLATFORM: the harness drives the production binary via tauri-driver and is
// Linux-only — authored to the conventions but MUST be run green 3× in the
// container (`./scripts/e2e-local.sh`) before merge; not executed on the
// authoring machine (macOS). See e2e/AGENTS.md "definition of done".

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  closeSettings,
  createNote,
  dismissImporterOffer,
  openSettings,
  selectSettingsTopic,
  typeIntoEditor,
  unlockToEditor,
} from "./support/flows";
import { KEY } from "./support/keyboard";
import { testIdSelector, type Session } from "./support/webdriver";

const EDITOR = testIdSelector("editor.content");
const CM_CONTENT = `${EDITOR} .cm-content`;
const CM_LINE = `${EDITOR} .cm-content .cm-line`;
// The floating selection toolbar mounts on document.body as `.cm-toolbar` —
// a CodeMirror-plugin surface (the `.cm-content` selector-exception class;
// its only testid-carrying renderable control is `toolbar.highlight`).
const FLOATING_TOOLBAR = ".cm-toolbar";

/** The five ids that used to be pinned "Coming soon" (`EDITOR_TOOLBAR_PENDING_IDS`
 *  until issue #970 implemented them; the on-disk vocabulary is frozen, so the
 *  literal list is stable to assert). */
const FORMERLY_PENDING_IDS = ["bulletList", "numberedList", "checklist", "quote", "wikilink"];

/** Non-empty DOM selection inside the focused editor, or null. Anchored on
 *  `.cm-focused` + `.cm-content` the way `task-row-selection` does: a selection
 *  elsewhere on the page satisfies a bare length check and tells CM nothing. */
async function selectionInEditor(s: Session): Promise<boolean> {
  return s.execute<boolean>(
    "var sel = window.getSelection();" +
      "if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;" +
      "if (!document.querySelector('.cm-editor.cm-focused')) return false;" +
      "var content = document.querySelector('[data-testid=\"editor.content\"] .cm-content');" +
      "if (!content) return false;" +
      "return content.contains(sel.anchorNode) || content.contains(sel.focusNode);",
  );
}

/** Put a non-empty selection on the note's target line, or say it could not.
 *
 *  Three selection strategies per call, cheapest first:
 *  1. Keyboard on the ELEMENT (`HOME` then sticky `Shift+End`). `Element.sendKeys`
 *     targets the node directly and works with or without prior focus — the
 *     lesson `ai-degradation` and `writing-assistant` both record about
 *     `pressKey`/Actions delivering to whatever happens to hold focus.
 *  2. Measured `doubleClickAt` on the word's glyph box (the ftp1 lesson: element
 *     origin (0,0) sits in the line-height leading).
 *  3. `tripleClickAt` on the same box — CM6's `detail: 3` line-selection gesture.
 *
 *  A mouseup is not required: CM6's `selectionSet` update already calls
 *  `ToolbarView.refresh()`. Re-selecting each poll iteration is load-bearing (a
 *  fresh render re-reads the layout fed by ToolbarLayoutSync). */
async function ensureSelection(s: Session): Promise<boolean> {
  // 1. Keyboard selection on the content node.
  const [content] = await s.findElements(CM_CONTENT);
  if (content !== undefined) {
    try {
      await content.clickOnce();
      await content.sendKeys(KEY.HOME);
      await content.sendKeys(KEY.SHIFT + KEY.END);
    } catch {
      // fall through to the mouse strategies
    }
  }
  if (!(await selectionInEditor(s))) {
    // 2/3. Measure the word (or first non-empty line) and hit its glyph box.
    const hit = await s.execute<string>(
      "var lines = document.querySelectorAll('[data-testid=\"editor.content\"] .cm-content .cm-line');" +
        "var target = null;" +
        "for (var i = 0; i < lines.length; i++) {" +
        "  var t = (lines[i].textContent || '').toLowerCase();" +
        "  if (t.indexOf('vurguhedefkelime42x') >= 0 || t.indexOf('siralamahedefkelime42x') >= 0 || t.indexOf('blokhedefkelime42x') >= 0) { target = lines[i]; break; }" +
        "  if (!target && t.trim()) target = lines[i];" +
        "}" +
        "if (!target) return '';" +
        "target.scrollIntoView({ block: 'center', inline: 'center' });" +
        "var range = document.createRange();" +
        "range.selectNodeContents(target);" +
        "var rects = range.getClientRects();" +
        "var box = null;" +
        "for (var j = 0; j < rects.length; j++) {" +
        "  if (rects[j].width > 0 && rects[j].height > 0) { box = rects[j]; break; }" +
        "}" +
        "var lineRect = target.getBoundingClientRect();" +
        "var ox = 4, oy = Math.round(lineRect.height / 2);" +
        "if (box) {" +
        "  ox = Math.round(box.left + box.width / 2 - lineRect.left);" +
        "  oy = Math.round(box.top + box.height / 2 - lineRect.top);" +
        "}" +
        "return JSON.stringify({" +
        "  idx: Array.prototype.indexOf.call(lines, target)," +
        "  ox: Math.max(0, ox), oy: Math.max(0, oy)" +
        "});",
    );
    if (hit !== "") {
      const { idx, ox, oy } = JSON.parse(hit) as { idx: number; ox: number; oy: number };
      const lines = await s.findElements(CM_LINE);
      const target = lines[idx];
      if (target !== undefined) {
        try {
          await target.scrollIntoView();
          await target.doubleClickAt(ox, oy);
          if (!(await selectionInEditor(s))) {
            await target.tripleClickAt(ox, oy);
          }
        } catch {
          // next poll re-finds
        }
      }
    }
  }
  return selectionInEditor(s);
}

/** Surface the floating toolbar until the named control is present or absent.
 *
 *  `controlId` is the vocabulary id the button renders under
 *  (`data-testid="toolbar.<id>"`, and every control carries one since issue #970;
 *  before that only the highlight cluster did, which is why the hide/show probe
 *  had to be the highlight button). */
async function surfaceToolbarControl(
  s: Session,
  controlId: string,
  present: boolean,
): Promise<void> {
  await s.waitUntil(
    async () => {
      if (!(await ensureSelection(s))) return null;
      try {
        await s.waitForElement(FLOATING_TOOLBAR, { timeoutMs: 2_000 });
      } catch {
        return null; // selection/toolbar not up yet — re-select
      }
      const found = await s.findElements(testIdSelector(`toolbar.${controlId}`));
      return (found.length > 0) === present ? true : null;
    },
    {
      label: `floating toolbar up, ${controlId} ${present ? "present" : "absent"}`,
      timeoutMs: 30_000,
    },
  );
}

/** The highlight hide/show probe tc1 drives (kept as its own name: the label in
 *  a failure message should say what the scenario was probing for). */
async function surfaceToolbar(s: Session, expectHighlight: boolean): Promise<void> {
  await surfaceToolbarControl(s, "highlight", expectHighlight);
}

/** The customize list's checkbox for one vocabulary id. */
async function customizeToggle(s: Session, itemId: string) {
  return s.waitForElement(
    testIdSelector("settings.toolbar-customize.toggle", { "data-item-id": itemId }),
  );
}

/** Poll the highlight toggle's persisted read-back (the list loads
 *  `prefsRead()` in a mount effect — poll, don't snapshot the pre-effect
 *  default; the pf1 discipline). */
async function expectHighlightToggleReadsBack(s: Session, checked: boolean): Promise<void> {
  await s.waitUntil(
    async () =>
      (await (await customizeToggle(s, "highlight")).property<boolean>("checked")) === checked ||
      null,
    { label: `highlight toggle reads back ${checked ? "checked" : "unchecked"}` },
  );
}


/** The customize list's row ids, in rendered order. */
async function customizeOrder(s: Session): Promise<string[]> {
  const rows = await s.findElements(testIdSelector("settings.toolbar-customize.move-up"));
  const ids: string[] = [];
  for (const row of rows) ids.push((await row.attribute("data-item-id")) ?? "?");
  return ids;
}

/**
 * The floating toolbar's controls, in DOM order, as stable per-control
 * signatures.
 *
 * NOT by testid: only the highlight cluster carries one
 * (`editor/src/toolbar/plugin.ts`), so a testid-keyed read sees two controls out
 * of a dozen and an order comparison over it is very nearly vacuous — which is
 * how this helper's first draft failed, and correctly.
 *
 * The signature is `aria-label` or `title` or the button's text, whichever the
 * control has. All three are localised, and that is fine here: the comparison is
 * between two reads inside ONE run, so it needs stability, not portability.
 */
async function toolbarOrder(s: Session): Promise<string[]> {
  return s.execute<string[]>(
    "var bar = document.querySelector(arguments[0]);" +
      "if (!bar) return [];" +
      "return Array.prototype.slice" +
      "  .call(bar.querySelectorAll('.cm-toolbar-button'))" +
      "  .map(function (el) {" +
      "    return el.getAttribute('aria-label') || el.getAttribute('title') ||" +
      "      (el.textContent || '').trim() || el.className;" +
      "  });",
    [FLOATING_TOOLBAR],
  );
}

describeE2E("tc1 toolbar customize: hide/show follows + persists; pending rows pinned (MYND-336)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("hiding highlight drops its button, un-hiding restores it, both survive a Settings reopen", async () => {
    let password = "";
    await scenario(
      "tc1-toolbar-customize",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // A single-word note body: double-click selects the whole word, the
        // unambiguous real-UI path to a non-empty selection under this driver
        // (Shift+Arrow send-keys drops Shift — the hc1 scope note).
        await createNote(s, "Arac Cubugu Notu");
        await typeIntoEditor(s, "vurguhedefkelime42x");

        // Baseline: the default layout renders the highlight control.
        await surfaceToolbar(s, true);

        // Settings → Editor → Toolbar list. Every row is live: the five that
        // used to be pinned "Coming soon" render now (issue #970, item 1), so a
        // disabled toggle here would claim a control cannot be shown when the
        // toolbar would happily show it.
        await openSettings(s, "editor");
        // The toolbar customisation lives in the Editor panel's `editing` topic
        // since myne-md/myne#885; only the active topic's body is mounted, so
        // every re-open owes the topic (the strip remembers it for the session,
        // which makes this a no-op after the first call).
        await selectSettingsTopic(s, "editor", "editing");
        await s.byTestId("settings.toolbar-customize");
        for (const id of FORMERLY_PENDING_IDS) {
          expect(
            await (await customizeToggle(s, id)).enabled(),
            `"${id}" is a renderable control now and its toggle must be live`,
          ).toBe(true);
        }

        // Hide "highlight" (a renderable, toggleable row): starts shown…
        await expectHighlightToggleReadsBack(s, true);
        await (await customizeToggle(s, "highlight")).click();
        await expectHighlightToggleReadsBack(s, false);
        await closeSettings(s);

        // …and the floating toolbar no longer renders its button (the
        // toolbar itself is up — the positive control inside surfaceToolbar).
        await surfaceToolbar(s, false);

        // Persistence across a Settings REOPEN (the regression this PR
        // fixed): the mount effect re-reads vault.prefs from disk, so the
        // hidden state must read back — not reset to the default.
        await openSettings(s, "editor");
        await selectSettingsTopic(s, "editor", "editing");
        await expectHighlightToggleReadsBack(s, false);

        // Un-hide → the button is back on the next selection.
        await (await customizeToggle(s, "highlight")).click();
        await expectHighlightToggleReadsBack(s, true);
        await closeSettings(s);
        await surfaceToolbar(s, true);

        // And the show-all state ALSO survives a reopen (the stored hidden set
        // is non-empty by construction: the five addable ids stay hidden until
        // asked for, so it cannot be mistaken for "never customized").
        await openSettings(s, "editor");
        await selectSettingsTopic(s, "editor", "editing");
        await expectHighlightToggleReadsBack(s, true);
        await closeSettings(s);
      },
    );
  });
});

// tc2 — myne-md/myne#557's `settings.block.toolbar-customize` /
// `editor.formatting-toolbar` bullet.
//
// # Why this bullet exists at all
//
// The roster row asked a person to REORDER the formatting toolbar by dragging a
// row, then check the toolbar's order and that it survives a restart. It was
// kept manual because the harness cannot start a native HTML5 drag session.
//
// That premise is true and irrelevant: `ToolbarCustomizeSettings.tsx` ships
// move-up / move-down BUTTONS beside every draggable row, with their own
// testids, and they call the same `move(id, delta)` the drag does. Reordering
// therefore needs no drag at all — the drag is one input to a reorder, not the
// reorder.
//
// # What is asserted, and what is deliberately not
//
// Asserted: the list's own order moves, the FLOATING TOOLBAR's rendered button
// order follows it, and both read back after Settings is closed and reopened
// (the mount effect re-reads `vault.prefs` from disk, so a reopen is the
// persistence proof — the same shape tc1 uses for hide/show).
//
// Not asserted: that a drag produces the same result. That is the one part a
// WebDriver seat genuinely cannot drive, and it stays a roster row; what this
// retires is the ORDER-follows-and-persists half, which is all of the row
// except the input method.
describeE2E("tc2 toolbar reorder follows the move buttons and persists (myne-md/myne#557)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("moving a row down reorders the floating toolbar and survives a Settings reopen", async () => {
    let password = "";
    await scenario(
      "tc2-toolbar-reorder",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Sira Notu");
        await typeIntoEditor(s, "siralamahedefkelime42x");

        // Baseline: the toolbar is up and we know its order.
        await surfaceToolbar(s, true);
        const toolbarBefore = await toolbarOrder(s);
        expect(
          toolbarBefore.length,
          "no toolbar buttons found — the order comparison would be vacuous",
        ).toBeGreaterThan(2);

        await openSettings(s, "editor");
        await selectSettingsTopic(s, "editor", "editing");
        await s.byTestId("settings.toolbar-customize");
        const listBefore = await customizeOrder(s);
        expect(listBefore.length).toBeGreaterThan(2);

        // Move the FIRST row down one. Its own move-up is disabled while it is
        // first, which is why the first row is the unambiguous starting point.
        const moved = listBefore[0];
        const wasSecond = listBefore[1];
        await (
          await s.waitForElement(
            testIdSelector("settings.toolbar-customize.move-down", { "data-item-id": moved }),
          )
        ).click();

        // The list re-renders with the two swapped.
        await s.waitUntil(
          async () => {
            const now = await customizeOrder(s);
            return now[0] === wasSecond && now[1] === moved ? true : null;
          },
          { label: `"${moved}" moved below "${wasSecond}" in the list` },
        );

        await closeSettings(s);

        // The FLOATING TOOLBAR follows. This is the half the list alone cannot
        // prove: a reorder that only moved the settings rows would leave the
        // toolbar exactly as it was and pass every assertion above.
        await surfaceToolbar(s, true);
        await s.waitUntil(
          async () => {
            const now = await toolbarOrder(s);
            return now.length === toolbarBefore.length && now.join() !== toolbarBefore.join()
              ? true
              : null;
          },
          { label: "the floating toolbar re-rendered in the new order" },
        );
        const toolbarAfter = await toolbarOrder(s);
        // Same buttons, different order — a reorder, not a hide.
        expect([...toolbarAfter].sort()).toEqual([...toolbarBefore].sort());
        expect(toolbarAfter.join()).not.toBe(toolbarBefore.join());

        // Persistence: reopening Settings re-reads `vault.prefs` from disk, so
        // the new order has to come back rather than resetting to the default.
        await openSettings(s, "editor");
        await selectSettingsTopic(s, "editor", "editing");
        await s.waitUntil(
          async () => {
            const now = await customizeOrder(s);
            return now[0] === wasSecond && now[1] === moved ? true : null;
          },
          { label: "the reorder read back after a Settings reopen" },
        );
        await closeSettings(s);
      },
    );
  });
});

// tc3: myne-md/myne#970 item 1: the five "Coming soon" rows are implemented.
//
// The pin existed because the renderer skipped those five ids while the Settings
// list advertised them ("Coming soon", toggle disabled). Everything needed was
// already there: `editorCommands` in `editor/src/toolbar/commands.ts` has had
// bulletList / numberedList / checklist / quote / wikilink all along, and the
// mobile keyboard bar drives the same table, so the fix was the renderer, not
// the commands, and the honest test is the end of the chain: switch the row ON
// in Settings, watch the button appear on the selection toolbar, press it, and
// see the line become a quote.
//
// The `aria-pressed` read is the oracle rather than the rendered text on purpose:
// the marker a block prefix writes is a REPLACE decoration in the live editor
// (`editorText()` returns what is drawn, not what is stored), so the rendered
// string is the wrong thing to assert on. `aria-pressed` is driven by
// `currentBlockType()`, which parses the LINE, so "true" means the document
// really holds a quote, and it is the same signal the user sees.
describeE2E("tc3 the formerly Coming-soon toolbar commands render and run (myne-md/myne#970)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("switching quote on puts its button on the toolbar, and pressing it quotes the line", async () => {
    let password = "";
    await scenario(
      "tc3-toolbar-block-commands",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        await createNote(s, "Blok Komutlari");
        await typeIntoEditor(s, "blokhedefkelime42x");

        // Baseline: default-hidden, so the button is NOT on the toolbar. This is
        // the half that proves the next assertion is about the setting rather
        // than about a control that renders unconditionally.
        await surfaceToolbar(s, true);
        await surfaceToolbarControl(s, "quote", false);

        // Switch it on.
        await openSettings(s, "editor");
        await selectSettingsTopic(s, "editor", "editing");
        await s.byTestId("settings.toolbar-customize");
        await (await customizeToggle(s, "quote")).click();
        await s.waitUntil(
          async () => ((await (await customizeToggle(s, "quote")).property<boolean>("checked")) ? true : null),
          { label: "the quote row reads back checked" },
        );
        await closeSettings(s);

        // The toolbar follows, and the press actually runs the command.
        await surfaceToolbarControl(s, "quote", true);
        await s.waitUntil(
          async () => {
            // Re-selecting each iteration keeps a live selection under the poll:
            // the click itself must find the toolbar up, and a stale render would
            // answer "not pressed" forever.
            if (!(await ensureSelection(s))) return null;
            const [button] = await s.findElements(testIdSelector("toolbar.quote"));
            if (button === undefined) return null;
            if ((await button.attribute("aria-pressed")) === "true") return true;
            await button.clickOnce();
            return null;
          },
          { label: "the quote button applies '> ' and reports itself pressed", timeoutMs: 30_000 },
        );

        // Persistence: the setting is a vault pref, so a reopen reads it back.
        await openSettings(s, "editor");
        await selectSettingsTopic(s, "editor", "editing");
        await s.waitUntil(
          async () =>
            (await (await customizeToggle(s, "quote")).property<boolean>("checked")) ? true : null,
          { label: "the quote row survived a Settings reopen" },
        );
        await closeSettings(s);
      },
    );
  });
});
