// Settings in-panel topic tabs (myne-md/myne#885, requirement 6).
//
// Two scenarios, one story each.
//
//   st1  the strip inside a settings panel selects a topic, remembers it across
//        a close and a reopen, leaves Up/Down to the shell that cycles the rail,
//        and the panels that are one concern stay a single screen with no strip
//        at all. The AI panel is the worked example and the panel the
//        persistence half is driven on; Account is the second split panel,
//        driven to prove the strip is the shared component's behaviour rather
//        than one panel's.
//
//   st2  the EDITOR panel, which is the panel the requester named: its six
//        topics, and the live specimen that follows the active topic
//        (myne-md/myne#885 tasks 6 and 7). It asserts which specimen band each
//        topic draws, that the date and time print in the reader's chosen
//        format, that a hidden toolbar button leaves the band and comes back,
//        that the task chip's colour and icon-only mode come through, and that
//        the two topics a note specimen cannot depict say so rather than
//        showing a stale copy of the note.
//
// == WHAT st1 PROVES, AND WHAT IT DOES NOT ==
//
//   st1  the strip renders one tab per topic with the first selected; its row is
//        the SAME row as the settings search box (top and bottom edges within a
//        pixel, read from the live layout, which is the requester's own
//        geometry requirement, asserted on both split panels driven here);
//        selecting a topic mounts that topic's body and no other; Left/Right
//        move within the strip; Up/Down still cycle the rail; the selected topic
//        survives closing and reopening the modal; a control belongs to exactly
//        one topic (the other topic's control is absent, not scrolled away); and
//        a single-concern panel (Files) renders no strip at all.
//
// The geometry half is why this file reads rects rather than only the DOM: "its
// top edge aligns with the settings content's separator, at the height of the
// search field" is a claim only a laid-out page can answer, and a jsdom test
// reports every box as zero by zero. Nothing here needs the `local-inference`
// stub build (the strip is not gated on AI being enabled), so these scenarios
// run on both the plain and the AI lanes.
//
// AUTHORED ON A NON-HARNESS HOST (macOS) - the green-3x verification is the
// container run recorded in the task report.
//
// KDF: weak generator fixture (SYNC-9 - params are vault.meta-resident).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  closeSettings,
  dismissImporterOffer,
  enableDeveloperMode,
  openSettings,
  pickSelect,
  selectSettingsTopic,
  unlockToEditor,
} from "./support/flows";
import { KEY, activeTestId, pressKey } from "./support/keyboard";
import { testIdSelector, type Session } from "./support/webdriver";

/** The strip's geometry against the settings search row's, in one round trip.
 *
 *  Both rows are named by their own testid rather than found by walking the DOM:
 *  the search input's immediate parent is the FIELD, whose own border made a
 *  "nearest ancestor with a bottom hairline" walk stop one level short and
 *  compare the strip against the wrong box (measured: the walk returned the
 *  28px field against the 53px strip). `settings.search-row` is that row, and it
 *  exists for this assertion.
 *
 *  Takes the strip's testid rather than hardcoding the AI panel's, because the
 *  geometry is the shared component's claim and is asserted on two panels
 *  below. */
async function stripAndSearchRow(
  s: Session,
  stripTestId: string,
): Promise<{
  stripTop: number;
  stripBottom: number;
  rowTop: number;
  rowBottom: number;
} | null> {
  return s.execute<{
    stripTop: number;
    stripBottom: number;
    rowTop: number;
    rowBottom: number;
  } | null>(
    "var strip = document.querySelector(arguments[0]);" +
      "var row = document.querySelector(arguments[1]);" +
      "if (!strip || !row) return null;" +
      "var sr = strip.getBoundingClientRect();" +
      "var rr = row.getBoundingClientRect();" +
      "return { stripTop: sr.top, stripBottom: sr.bottom, rowTop: rr.top, rowBottom: rr.bottom };",
    [testIdSelector(stripTestId), testIdSelector("settings.search-row")],
  );
}

/** The testids of the mounted topic bodies, so "one at a time" is asserted in
 *  both directions rather than by absence at one known id. */
async function mountedTopics(s: Session, prefix: string): Promise<string[]> {
  return s.execute<string[]>(
    "return Array.from(document.querySelectorAll(arguments[0])).map(function (el) {" +
      " return el.getAttribute('data-testid'); });",
    [`[data-testid^="${prefix}"]`],
  );
}

/** Fail with the four numbers rather than a truncated diff, the same shape the
 *  AI panel's geometry check uses. */
function assertStripSharesTheSearchRow(
  rects: { stripTop: number; stripBottom: number; rowTop: number; rowBottom: number } | null,
  which: string,
): void {
  if (rects === null) {
    throw new Error(`the ${which} strip or the settings search row is not in the layout`);
  }
  const topDelta = Math.abs(rects.stripTop - rects.rowTop);
  const bottomDelta = Math.abs(rects.stripBottom - rects.rowBottom);
  if (topDelta > 1 || bottomDelta > 1) {
    throw new Error(
      `the ${which} strip and the search row are not one line: strip ` +
        `${rects.stripTop}..${rects.stripBottom}, search row ` +
        `${rects.rowTop}..${rects.rowBottom}`,
    );
  }
}

describeE2E("st1 settings in-panel topic tabs (myne-md/myne#885)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("selects a topic, keeps it across a reopen, and leaves the rail's keys alone", async () => {
    let password = "";
    await scenario(
      "st1-settings-topic-tabs",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // The AI panel is behind Developer mode (MYND-593). `enableDeveloperMode`
        // leaves Settings OPEN, which the rail click below relies on.
        await enableDeveloperMode(s);
        await openSettings(s, "ai");
        await s.byTestId("settings.ai-panel");

        // ── The strip exists, one tab per topic, and the first is selected ──
        const strip = await s.byTestId("settings.ai-tabs", { timeoutMs: 15_000 });
        expect(await strip.attribute("role")).toBe("tablist");
        for (const topic of ["answering", "models", "limits", "advanced"]) {
          const tab = await s.byTestId(`settings.ai-tab-${topic}`);
          expect(await tab.attribute("role")).toBe("tab");
        }
        expect(
          await (await s.byTestId("settings.ai-tab-answering")).attribute("aria-selected"),
        ).toBe("true");

        // ── The strip's row IS the search box's row ───────────────────────────
        // The requester's geometry: the tab strip sits at the top of the settings
        // content, aligned with the search field's own separator. Read from the
        // layout, because that is the only place the claim can be answered.
        assertStripSharesTheSearchRow(await stripAndSearchRow(s, "settings.ai-tabs"), "AI");

        // ── One topic's body at a time ────────────────────────────────────────
        expect(await mountedTopics(s, "settings.ai-topic-")).toEqual(["settings.ai-topic-answering"]);

        await (await s.byTestId("settings.ai-tab-models")).click();
        await s.waitForElement(testIdSelector("settings.ai-topic-models"), {
          timeoutMs: 10_000,
        });
        expect(await mountedTopics(s, "settings.ai-topic-")).toEqual(["settings.ai-topic-models"]);
        // Models holds the auto-tag switch and the tag role's own row together
        // since Tagging folded into it (myne-md/myne#867).
        await s.byTestId("ai.auto-tag-toggle");
        await s.byTestId("ai.model-select-tag");
        expect((await s.byTestIdAll("settings.ai-topic-answering")).length).toBe(0);
        expect((await s.byTestIdAll("settings.ai-topic-limits")).length).toBe(0);

        // ── Left/Right move within the strip, and the focus follows ───────────
        // The click above focused the Models tab, so the arrow lands on it.
        await pressKey(s, KEY.ARROW_RIGHT);
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("settings.ai-tab-limits")).attribute("aria-selected")) ===
            "true"
              ? true
              : null,
          { label: "ArrowRight moves the strip to the next topic", timeoutMs: 10_000 },
        );
        if ((await activeTestId(s)) !== "settings.ai-tab-limits") {
          throw new Error("the strip selected the next topic without moving focus to it");
        }
        await pressKey(s, KEY.ARROW_LEFT);
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("settings.ai-tab-models")).attribute("aria-selected")) ===
            "true"
              ? true
              : null,
          { label: "ArrowLeft moves the strip back", timeoutMs: 10_000 },
        );

        // ── Up/Down are the RAIL's, not the strip's ───────────────────────────
        // The interaction a careless tab implementation breaks: `SettingsModal`
        // cycles the rail with the vertical arrows on `window`, and a strip that
        // consumed them would leave the user unable to reach another panel from
        // the keyboard. `network` follows `ai` in the roster.
        await pressKey(s, KEY.ARROW_DOWN);
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("settings.tab-network")).attribute("aria-selected")) ===
            "true"
              ? true
              : null,
          { label: "ArrowDown still cycles the rail", timeoutMs: 15_000 },
        );
        // The strip went with the panel, which is the second half of the claim:
        // the rail moved and the strip did not stay behind.
        await s.waitForGone(testIdSelector("settings.ai-tabs"));

        // ── The selected topic survives closing and reopening the modal ───────
        await openSettings(s, "ai");
        await s.byTestId("settings.ai-panel");
        // Back on the AI panel, the strip is the one the session left: Models.
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("settings.ai-tab-models")).attribute("aria-selected")) ===
            "true"
              ? true
              : null,
          { label: "the topic held across a rail switch", timeoutMs: 15_000 },
        );

        await closeSettings(s);
        await openSettings(s, "ai");
        await s.byTestId("settings.ai-panel");
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("settings.ai-tab-models")).attribute("aria-selected")) ===
            "true"
              ? true
              : null,
          { label: "the topic held across a close and reopen", timeoutMs: 15_000 },
        );
        expect(await mountedTopics(s, "settings.ai-topic-")).toEqual(["settings.ai-topic-models"]);

        // ── A SECOND split panel, so the strip is not proven on AI alone ──────
        // The Vault panel's `danger` topic is the reason that panel was split at all: it
        // holds the irreversible erase, and the split's whole job is to give it a
        // destination instead of a scroll past the icon picker. The claim here is
        // the same one the AI segment makes, on a panel whose topics come from a
        // different roster entry and whose bodies replace each other rather than
        // scroll.
        await (await s.byTestId("settings.tab-vault")).click();
        await s.byTestId("settings.vault-tabs", { timeoutMs: 15_000 });
        expect(
          await (await s.byTestId("settings.vault-tab-vault")).attribute("aria-selected"),
        ).toBe("true");
        expect(await mountedTopics(s, "settings.vault-topic-")).toEqual([
          "settings.vault-topic-vault",
        ]);
        // The vault topic's own control is on screen and the danger topic's is
        // not, which is the "exactly one home" half rather than the selection
        // half.
        await s.byTestId("settings.change-password-cta");
        expect((await s.byTestIdAll("settings.delete-vault-cta")).length).toBe(0);

        assertStripSharesTheSearchRow(
          await stripAndSearchRow(s, "settings.vault-tabs"),
          "Vault",
        );

        await (await s.byTestId("settings.vault-tab-danger")).click();
        await s.waitForElement(testIdSelector("settings.vault-topic-danger"), {
          timeoutMs: 10_000,
        });
        expect(await mountedTopics(s, "settings.vault-topic-")).toEqual([
          "settings.vault-topic-danger",
        ]);
        // The erase CTA is reachable from its own topic, and the vault topic is
        // gone rather than merely scrolled away.
        await s.byTestId("settings.delete-vault-cta");
        expect((await s.byTestIdAll("settings.change-password-cta")).length).toBe(0);

        // ── A single-concern panel renders no strip ───────────────────────────
        // Files is the user's own example of a tab that should stay one screen.
        // The claim is the ABSENCE of a strip on that panel, not the presence of
        // one somewhere else.
        await (await s.byTestId("settings.tab-files")).click();
        await s.waitForElement(testIdSelector("settings.files-panel"), { timeoutMs: 15_000 });
        expect((await s.byTestIdAll("settings.files-tabs")).length).toBe(0);
        expect((await s.byTestIdAll("settings.ai-tabs")).length).toBe(0);
        expect((await s.byTestIdAll("settings.vault-tabs")).length).toBe(0);

        await closeSettings(s);
      },
    );
  });
});

/** The topic the preview is currently showing, from its own attribute. */
async function previewTopic(s: Session): Promise<string | null> {
  return await (
    await s.byTestId("settings.editor-preview", { timeoutMs: 15_000 })
  ).attribute("data-topic");
}

/** The rendered text of one band, or `""` when the band is not drawn. */
async function bandText(s: Session, testId: string): Promise<string> {
  const found = await s.byTestIdAll(testId);
  return found.length === 0 ? "" : (await found[0]!.textContent()).trim();
}

/** Whether one toolbar button is drawn in the preview's toolbar band. */
async function previewToolbarHas(s: Session, itemId: string): Promise<boolean> {
  return (await s.byTestIdAll(`settings.editor-preview-toolbar-${itemId}`)).length > 0;
}

/** Hide or show one toolbar button through the customisation list. */
async function toggleToolbarItem(s: Session, itemId: string): Promise<void> {
  const toggle = await s.waitForElement(
    testIdSelector("settings.toolbar-customize.toggle", { "data-item-id": itemId }),
  );
  await toggle.scrollIntoView();
  await toggle.click();
}

describeE2E("st2 the Editor panel's topics drive its preview (myne-md/myne#885)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("follows the active topic, and reflects the date, toolbar, spell and task settings", async () => {
    let password = "";
    await scenario(
      "st2-editor-topic-preview",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        await openSettings(s, "editor");
        // The strip is the panel's own (six topics), and the default is the
        // first: Text & display.
        const strip = await s.byTestId("settings.editor-tabs", { timeoutMs: 15_000 });
        expect(await strip.attribute("role")).toBe("tablist");
        for (const topic of ["text", "editing", "writing", "tasks", "periodic", "features"]) {
          await s.byTestId(`settings.editor-tab-${topic}`);
        }
        expect(
          await (await s.byTestId("settings.editor-tab-text")).attribute("aria-selected"),
        ).toBe("true");
        expect(await previewTopic(s)).toBe("text");

        // ── The preview is the TOPIC's, not every section at once ───────────
        // The requester's complaint was that it stayed stale. On Text the
        // specimen is the note body and nothing else; the toolbar and task bands
        // belong to other topics.
        expect(await bandText(s, "settings.editor-preview")).toContain("quick brown fox");
        expect((await s.byTestIdAll("settings.editor-preview-toolbar")).length).toBe(0);
        expect((await s.byTestIdAll("settings.editor-preview-task")).length).toBe(0);
        expect((await s.byTestIdAll("settings.editor-preview-datetime")).length).toBe(0);

        // ── Editing: the date/time band and the toolbar band ────────────────
        await selectSettingsTopic(s, "editor", "editing");
        await s.waitUntil(
          async () => ((await previewTopic(s)) === "editing" ? true : null),
          { label: "the preview followed the strip to the Editing topic", timeoutMs: 15_000 },
        );
        await s.byTestId("settings.editor-preview-datetime", { timeoutMs: 10_000 });
        await s.byTestId("settings.editor-preview-toolbar", { timeoutMs: 10_000 });

        // The DATE FORMAT the reader chose, asserted through the rendered text.
        // The band prints a fixed sample (`2026-08-01T14:30`) through the shared
        // display store, which is the same source a note's own dates read.
        await pickSelect(s, "settings.date-format", "iso");
        await pickSelect(s, "settings.time-format", "24h");
        await s.waitUntil(
          async () => {
            const text = await bandText(s, "settings.editor-preview-datetime");
            return text.includes("2026-08-01") && text.includes("14:30") ? true : null;
          },
          {
            label: "the preview printed the date and time in the chosen formats",
            timeoutMs: 15_000,
          },
        );

        // The TOOLBAR: a hidden button leaves the specimen, and comes back.
        expect(await previewToolbarHas(s, "bold")).toBe(true);
        await toggleToolbarItem(s, "bold");
        await s.waitUntil(
          async () => ((await previewToolbarHas(s, "bold")) === false ? true : null),
          { label: "a hidden toolbar button left the preview", timeoutMs: 15_000 },
        );
        expect(
          await previewToolbarHas(s, "italic"),
          "hiding one button must not empty the specimen's toolbar",
        ).toBe(true);
        await toggleToolbarItem(s, "bold");
        await s.waitUntil(
          async () => ((await previewToolbarHas(s, "bold")) === true ? true : null),
          { label: "the button came back when it was shown again", timeoutMs: 15_000 },
        );

        // ── Writing: the spell demo ────────────────────────────────────────
        // Spell check is ON by default (`null` ≡ unset), which is the resolution
        // the editor itself applies, so the demo belongs here out of the box.
        await selectSettingsTopic(s, "editor", "writing");
        await s.byTestId("settings.editor-preview-spell", { timeoutMs: 10_000 });
        expect(
          (await s.byTestIdAll("settings.editor-preview-toolbar")).length,
          "the toolbar band belongs to Editing, not to Writing",
        ).toBe(0);

        // ── Tasks: the chip, from the workspace container ───────────────────
        await selectSettingsTopic(s, "editor", "tasks");
        const chip = await s.byTestId("settings.editor-preview-task-chip", {
          timeoutMs: 10_000,
        });
        expect(await chip.attribute("data-chip-color")).toBe("theme");
        expect(await chip.attribute("data-icon-only")).toBe("false");
        await s.byTestId("settings.editor-preview-task-label");
        const tasksPreview = await s.byTestId("settings.editor-preview");
        expect(
          ((await tasksPreview.textContent()) ?? "").includes("quick brown fox"),
          "the Tasks topic must not draw the note specimen",
        ).toBe(false);

        // Icon-only drops the word, and the colour follows the picker.
        await (await s.byTestId("settings.editor.taskChipIconOnly.control")).click();
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("settings.editor-preview-task-chip")).attribute(
              "data-icon-only",
            )) === "true"
              ? true
              : null,
          { label: "icon-only reached the preview's chip", timeoutMs: 15_000 },
        );
        expect((await s.byTestIdAll("settings.editor-preview-task-label")).length).toBe(0);
        await pickSelect(s, "settings.editor.taskChipColor.control", "danger");
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("settings.editor-preview-task-chip")).attribute(
              "data-chip-color",
            )) === "danger"
              ? true
              : null,
          { label: "the chip colour reached the preview", timeoutMs: 15_000 },
        );

        // ── Periodic notes: nothing a note specimen can honestly show ──────
        // The column is not drawn at all there (myne-md/myne#885 visual pass).
        await selectSettingsTopic(s, "editor", "periodic");
        await s.waitUntil(
          async () =>
            (await s.byTestIdAll("settings.editor-preview")).length === 0 ? true : null,
          { label: "the preview column left with the Periodic notes topic", timeoutMs: 10_000 },
        );

        // ── The topic holds across a close and a reopen, on this panel too ──
        await closeSettings(s);
        await openSettings(s, "editor");
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("settings.editor-tab-periodic")).attribute(
              "aria-selected",
            )) === "true"
              ? true
              : null,
          { label: "the Editor topic held across a close and reopen", timeoutMs: 15_000 },
        );
        expect((await s.byTestIdAll("settings.editor-preview")).length).toBe(0);

        await closeSettings(s);
      },
    );
  });
});

/**
 * The question mark's own state, read in one round trip.
 *
 * `display` rather than presence: the collapsed copy is deliberately IN the
 * document (that is what makes it the control's description while collapsed),
 * so "is it shown" is the only question the DOM can answer. And the paragraphs
 * are counted rather than matched against English, so the assertion survives a
 * copy edit and says the structural thing: three moved paragraphs, not one
 * concatenated string.
 */
async function disclosureState(
  s: Session,
  rowTestId: string,
): Promise<{
  expanded: string | null;
  display: string;
  paragraphs: number;
  copyLength: number;
  inlineHasMovedCopy: boolean;
} | null> {
  return s.execute<{
    expanded: string | null;
    display: string;
    paragraphs: number;
    copyLength: number;
    inlineHasMovedCopy: boolean;
  } | null>(
    "var t = document.querySelector(arguments[0]);" +
      "var e = document.querySelector(arguments[1]);" +
      "var r = document.querySelector(arguments[2]);" +
      "if (!t || !e || !r) return null;" +
      "var copy = (e.textContent || '').trim();" +
      "var inline = (r.textContent || '').replace(copy, '');" +
      "return {" +
      " expanded: t.getAttribute('aria-expanded')," +
      " display: getComputedStyle(e).display," +
      " paragraphs: e.children.length," +
      " copyLength: copy.length," +
      // The RESIDUE paragraph's opening, which is one of the three that moved.
      // The sentence kept on the row is the destructive one, so asserting on
      // that would be true either way.
      " inlineHasMovedCopy: inline.indexOf('It cannot reach a copy taken earlier') !== -1" +
      "};",
    [
      testIdSelector(`${rowTestId}-explain`),
      testIdSelector(`${rowTestId}-explanation`),
      testIdSelector(rowTestId),
    ],
  );
}

function assertDisclosure(
  state: Awaited<ReturnType<typeof disclosureState>>,
  want: { expanded: string; shown: boolean },
): void {
  if (state === null) {
    throw new Error("the row, its question mark or its copy is not in the document");
  }
  if (state.expanded !== want.expanded) {
    throw new Error(
      `the question mark reports aria-expanded=${state.expanded}, expected ${want.expanded}`,
    );
  }
  const shown = state.display !== "none";
  if (shown !== want.shown) {
    throw new Error(
      `the long copy is ${shown ? "shown" : "hidden"} (display: ${state.display}), ` +
        `expected it to be ${want.shown ? "shown" : "hidden"}`,
    );
  }
}

describeE2E("st3 the long-copy affordance beside a setting's title (myne-md/myne#885)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("holds the moved copy behind the question mark, opens it, and closes it on Escape alone", async () => {
    let password = "";
    await scenario(
      "st3-settings-helper-disclosure",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // The row lives in Privacy's `access` topic, which is that panel's
        // default, so the strip needs no click here.
        await openSettings(s, "privacy");
        const ROW = "settings.hide-vault-names";
        await s.byTestId(ROW, { timeoutMs: 15_000 });

        // ── Collapsed: the copy is present, associated, and not shown ────────
        const collapsed = await disclosureState(s, ROW);
        assertDisclosure(collapsed, { expanded: "false", shown: false });
        // Three paragraphs moved behind it (the helper's own, and the two that
        // used to follow it), and none of them is left on the row. The row used
        // to render 776 characters; the point of the move is that the row is no
        // longer an essay, so asserting the copy is GONE from the row is the
        // assertion, not that it exists somewhere.
        expect(collapsed!.paragraphs).toBe(3);
        expect(collapsed!.copyLength).toBeGreaterThan(300);
        expect(collapsed!.inlineHasMovedCopy).toBe(false);

        // ── Keyboard focus opens it ──────────────────────────────────────────
        // `focus()` from the page seat rather than a click, because a click is
        // the POINTER path and this is the one that has to work without one.
        await s.execute(
          "var t = document.querySelector(arguments[0]); if (t) t.focus();",
          [testIdSelector(`${ROW}-explain`)],
        );
        await s.waitUntil(
          async () => {
            const state = await disclosureState(s, ROW);
            return state !== null && state.display !== "none" ? true : null;
          },
          { label: "focus opens the explanation", timeoutMs: 10_000 },
        );
        assertDisclosure(await disclosureState(s, ROW), { expanded: "true", shown: true });

        // ── One Escape closes the disclosure and NOT the dialog ──────────────
        // The same claim `sn1` makes for the accent picker, on a surface that is
        // not a dialog: `SettingsModal` listens for Escape on `window`, so a
        // disclosure that did not stop the key would take the whole panel with
        // it and lose whatever the user was doing.
        await pressKey(s, KEY.ESCAPE);
        await s.waitUntil(
          async () => {
            const state = await disclosureState(s, ROW);
            return state !== null && state.display === "none" ? true : null;
          },
          { label: "Escape closes the explanation", timeoutMs: 10_000 },
        );
        assertDisclosure(await disclosureState(s, ROW), { expanded: "false", shown: false });
        expect(
          (await s.byTestIdAll("settings.modal")).length,
          "one Escape closed the explanation AND the Settings modal behind it",
        ).toBe(1);
        // Focus never left the trigger, which is what "returns focus where it
        // came from" means for a surface that never took it.
        expect(await activeTestId(s)).toBe(`${ROW}-explain`);

        // ── Press opens it, and press closes it again ────────────────────────
        // Driven with Space rather than Enter: `KEY.ENTER` does not activate a
        // button through this driver's Actions API (e2e/AGENTS.md, "Three
        // harness premises"). That is a statement about the driver, not about
        // the control: a real WebKitGTK window activates on Enter, and that half
        // is the manual item this entry carries.
        await (await s.byTestId(`${ROW}-explain`)).click();
        await s.waitUntil(
          async () => {
            const state = await disclosureState(s, ROW);
            return state !== null && state.display !== "none" ? true : null;
          },
          { label: "press opens the explanation", timeoutMs: 10_000 },
        );
        assertDisclosure(await disclosureState(s, ROW), { expanded: "true", shown: true });

        await (await s.byTestId(`${ROW}-explain`)).click();
        await s.waitUntil(
          async () => {
            const state = await disclosureState(s, ROW);
            return state !== null && state.display === "none" ? true : null;
          },
          { label: "a second press closes it", timeoutMs: 10_000 },
        );
        assertDisclosure(await disclosureState(s, ROW), { expanded: "false", shown: false });

        // The row's own control still works: the affordance was added BESIDE it
        // and changed nothing about the switch.
        await s.byTestId("settings.hide-vault-names-toggle");

        await closeSettings(s);
      },
    );
  });
});
