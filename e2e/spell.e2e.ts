// Spell-check suite (spell-checker epic, MYND-264 t6 / MYND-265 t6).
//
// Drives the production binary end-to-end through the real chain: type a
// misspelling in the CodeMirror surface → the Rust spellbook engine (loaded
// with the bundled en-US dictionary on unlock) flags it over IPC → a
// `editor.spell-error` squiggle decoration appears; right-click it → the
// correction menu offers suggestions + add/ignore; applying a suggestion edits
// the buffer and clears the squiggle; "Add to dictionary" clears it by teaching
// the engine the word (persisted to the encrypted vault.dictionary blob).
//
// The squiggle's mere appearance proves the whole stack works together:
// bundled-dict resource resolution → spellbook load on unlock → spell_check IPC
// → the async decoration pipeline. These are exactly the integrations that can
// only be verified against the running binary (the unit/vitest layers mock IPC).
//
// Misspelled markers are in-source scenario constants (the accepted SYNC-13
// exception — note content, never a credential). The needle is a single
// lowercase-alnum token chosen to be a guaranteed non-word in en-US so the
// engine flags it deterministically.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  closeSettings,
  createNote,
  dismissImporterOffer,
  editorText,
  openSettings,
  reopenNoteAfterReload,
  selectSettingsTopic,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import type { Element, Session } from "./support/webdriver";

// `typeIntoEditor` prepends a sacrificial "q" probe to establish the keystroke
// pipeline (support/flows.ts) — it lands glued to the payload's first word, so
// "please…" becomes "qplease…". That coined prefix is ITSELF flagged, leaving a
// second squiggle at the line start. A bare `byTestId("editor.spell-error")`
// would grab THAT one, not the word under test (all squiggles share one
// testid). So every scenario here selects/asserts the squiggle BY WORD TEXT —
// never the first match, never "all squiggles gone". The payload always puts the
// target word SECOND, so the probe never fuses with it.

/** The squiggle Element whose text is exactly `word` (trimmed), polling until it
 *  appears — the per-word replacement for `byTestId("editor.spell-error")`.
 *  Generous budget: re-mounting the spell layer (toggle On, or a reload) reloads
 *  the bundled en-US dictionary + re-tokenizes async, which under full-suite
 *  cumulative load can take well past a snappy isolated run. */
function squiggleFor(s: Session, word: string, timeoutMs = 45_000): Promise<Element> {
  return s.waitUntil(
    async () => {
      for (const el of await s.byTestIdAll("editor.spell-error")) {
        if ((await el.textContent()).trim() === word) return el;
      }
      return null;
    },
    { label: `squiggle for "${word}"`, timeoutMs },
  );
}

/** Wait until NO squiggle carries `word` (the per-word `waitForGone`): the
 *  word-under-test's mark cleared, ignoring the harness probe's stray squiggle. */
function squiggleGoneFor(s: Session, word: string, timeoutMs = 10_000): Promise<true> {
  return s.waitUntil(
    async () => {
      for (const el of await s.byTestIdAll("editor.spell-error")) {
        if ((await el.textContent()).trim() === word) return null; // still present
      }
      return true;
    },
    { label: `squiggle for "${word}" gone`, timeoutMs },
  );
}

// A guaranteed-misspelled prose word, followed by a real word + trailing space
// so the cursor leaves it (the active word is suppressed, SYNC-9) and it sits in
// plain prose (not code / tag / wikilink — the SYNC-3 skip set).
const MISSPELLED = "wrxnggg";
const SENTENCE = `the ${MISSPELLED} word here `;

describeE2E("SP-1 misspelling is flagged with a squiggle (MYND-264)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("a misspelled word in prose gets a editor.spell-error mark", async () => {
    let password = "";
    await scenario(
      "sp1-detect",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Spell Defteri");
        await typeIntoEditor(s, SENTENCE);

        // The squiggle appears once the engine (bundled en-US dict, loaded on
        // unlock) flags the word over IPC + the debounced scan renders it.
        await squiggleFor(s, MISSPELLED);
      },
    );
  });
});

describeE2E("SP-2 correction menu applies a suggestion (MYND-265)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("right-click a squiggle → pick a suggestion → word corrected, squiggle gone", async () => {
    const TYPO = "recieve"; // a real misspelling spellbook suggests "receive" for
    let password = "";
    await scenario(
      "sp2-correct",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Correction Defteri");
        await typeIntoEditor(s, `please ${TYPO} this `);

        const squiggle = await squiggleFor(s, TYPO);
        await squiggle.rightClick();
        await s.byTestId("spell.suggestion-menu", { timeoutMs: 10_000 });

        // Apply the first suggestion row.
        await (await s.byTestId("spell.suggestion-row")).click();

        // The typo is gone from the buffer (replaced by the suggestion) and its
        // squiggle clears on the post-correction re-scan.
        await s.waitUntil(
          async () => (!(await editorText(s)).includes(TYPO) ? true : null),
          { label: "typo replaced by the chosen suggestion" },
        );
        await squiggleGoneFor(s, TYPO);
      },
    );
  });
});

describeE2E("SP-3 add-to-dictionary clears the squiggle (MYND-265/266)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("right-click → Add to dictionary → word is accepted, squiggle gone", async () => {
    const NAME = "myneword"; // a coined word the user wants accepted
    let password = "";
    await scenario(
      "sp3-add",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Dictionary Defteri");
        await typeIntoEditor(s, `the ${NAME} term here `);

        const squiggle = await squiggleFor(s, NAME);
        await squiggle.rightClick();
        await s.byTestId("spell.suggestion-menu", { timeoutMs: 10_000 });
        await (await s.byTestId("spell.action-add")).click();

        // The engine now treats the word as correct (persisted to
        // vault.dictionary); its squiggle clears on the re-scan.
        await squiggleGoneFor(s, NAME);
      },
    );
  });
});

describeE2E("SP-4 settings toggle gates squiggles + persists (MYND-267)", () => {
  // Vault-count precondition: 1 (weak KDF).
  // Drives the REAL Settings → Editor spell controls: the enable toggle
  // gates the squiggle layer live AND across a WebView reload (the `spell_enabled`
  // pref rides MYP1, re-read on editor entry — the prefs.e2e.ts theme template),
  // and the language picker reads back the persisted active set.
  it("toggling spell-check off/on mounts/unmounts squiggles and survives a reload", async () => {
    const WORD = "wrxnggg"; // guaranteed non-word, placed SECOND so the
    // typeIntoEditor "q" probe fuses with "the", never with WORD.
    let password = "";
    await scenario(
      "sp4-settings-toggle",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Settings Defteri");
        await typeIntoEditor(s, `the ${WORD} word here `);
        // Settle the autosave so the note content survives the reloads below.
        await waitForSaved(s);

        // Default-on (SYNC-15): the squiggle is present out of the box.
        await squiggleFor(s, WORD);

        // Settings → Editor → toggle spell-check OFF. The control
        // live-updates the open editor (setSpellConfig window event), so the
        // squiggle clears without a reload.
        await openSettings(s, "editor");
        // The spell controls live in the Editor panel's `writing` topic since
        // myne-md/myne#885; only the active topic's body is mounted.
        await selectSettingsTopic(s, "editor", "writing");
        const toggle = await s.byTestId("settings.spell-check");
        if ((await toggle.attribute("aria-checked")) !== "true") {
          throw new Error("spell toggle did not start On (default-on, SYNC-15)");
        }
        await toggle.click(); // → Off
        await closeSettings(s);
        await squiggleGoneFor(s, WORD);

        // Persistence: a reload re-reads MYP1; the layer stays unmounted.
        await s.refresh();
        await s.byTestId("editor.root", { timeoutMs: 30_000 });
        await reopenNoteAfterReload(s); // reopen post-reload (load-robust)
        await squiggleGoneFor(s, WORD);

        // The toggle itself reads back Off (mount effect reads the pref).
        await openSettings(s, "editor");
        await selectSettingsTopic(s, "editor", "writing");
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("settings.spell-check")).attribute("aria-checked")) ===
              "false" || null,
          { label: "spell toggle reads back Off after reload" },
        );

        // Toggle back ON → the squiggle layer remounts and re-flags WORD.
        await (await s.byTestId("settings.spell-check")).click(); // → On

        // The language control (enabled again) reads back the active set: it is
        // now a searchable multi-select dropdown whose trigger summarises the
        // selected languages by label, so the persisted en-US shows as
        // "English (US)" without opening the menu (v1 default = en-US only).
        await s.waitUntil(
          async () =>
            (
              await (await s.byTestId("settings.spell-language-select")).textContent()
            ).includes("English (US)") || null,
          { label: "en-US language reads back as active" },
        );
        await closeSettings(s);
        await squiggleFor(s, WORD);

        // And the On state persists across a reload too.
        await s.refresh();
        await s.byTestId("editor.root", { timeoutMs: 30_000 });
        await reopenNoteAfterReload(s); // reopen post-reload (load-robust)
        await squiggleFor(s, WORD);
      },
    );
  });
});

// SP-5 — myne-md/myne#557's `editor.spell-check` bullet.
//
// # The distinction this exists to make, which spell.e2e.ts could not make
//
// SP-2 proves Myne's own correction menu opens on a right-click. It does NOT
// prove the platform's menu was suppressed, and those are different claims with
// the same observable on WebKitGTK: the engine offers no native context menu
// there in the first place, so "no native menu appeared" is true whether or not
// the app asked for it. A reviewer on that seat cannot tell them apart either —
// which is exactly why the roster row existed and exactly why it could never
// have answered the question.
//
// `preventDefault()` on the `contextmenu` event IS the suppression, and
// `dispatchEvent` returns `false` precisely when a cancelable event was
// prevented. So the app's own decision is readable from inside the page,
// independent of what the host would have drawn:
//
//   * over a squiggle  → prevented, because Myne is drawing its own menu;
//   * over plain prose → NOT prevented, because there is nothing to replace it
//     with, and swallowing the event there would remove the platform's menu and
//     put nothing in its place.
//
// The second half is the load-bearing one. A blanket `preventDefault` on the
// editor passes any "the app's menu opened" assertion and silently deletes
// copy/paste/lookup everywhere else in the document — on a seat where the native
// menu does exist, which is every seat except this one.
describeE2E("SP-5 the native context menu is suppressed only where Myne replaces it (myne-md/myne#557)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("contextmenu is prevented over a squiggle and left alone over plain prose", async () => {
    const TYPO = "recieve";
    let password = "";
    await scenario(
      "sp5-contextmenu-suppression",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Contextmenu Defteri");
        await typeIntoEditor(s, `please ${TYPO} the parcel `);

        // Wait for the squiggle so the "over a squiggle" case really is one.
        await squiggleFor(s, TYPO);

        // Dispatch a REAL cancelable contextmenu at each target and report
        // whether the app prevented it. `dispatchEvent` returns false exactly
        // when a cancelable event had `preventDefault()` called on it, so this
        // reads the app's DECISION rather than the engine's rendering — which
        // is the whole point, since WebKitGTK renders no native menu either way.
        //
        // The COORDINATES are load-bearing and were the first draft's bug. The
        // handler is `view.posAtCoords({x: event.clientX, y: event.clientY})`
        // (`editor/src/spell/correction-menu.ts`), so an event dispatched with
        // the default 0,0 asks "is there a squiggle at the top-left of the
        // viewport" — answers no, and the assertion reads as a missing
        // suppression. Dispatching at the target's own centre is what makes the
        // probe about the target.
        const probe = (selector: string): Promise<boolean | null> =>
          s.execute<boolean | null>(
            "var el = document.querySelector(arguments[0]);" +
              "if (!el) return null;" +
              "var r = el.getBoundingClientRect();" +
              "if (r.width === 0 || r.height === 0) return null;" +
              "var ev = new MouseEvent('contextmenu', {" +
              "  bubbles: true, cancelable: true," +
              "  clientX: Math.round(r.left + r.width / 2)," +
              "  clientY: Math.round(r.top + r.height / 2)" +
              "});" +
              "return el.dispatchEvent(ev) === false;",
            [selector],
          );

        const overSquiggle = await probe('[data-testid="editor.spell-error"]');
        expect(overSquiggle, "no squiggle element to dispatch on").not.toBeNull();
        expect(
          overSquiggle,
          "the contextmenu was NOT prevented over a squiggle, so on a seat with " +
            "a native menu the platform's would open on top of (or instead of) " +
            "Myne's suggestion menu",
        ).toBe(true);

        // Plain prose: the app must leave the event alone. A blanket
        // preventDefault on the editor would pass every SP-2-shaped assertion
        // and delete the platform's copy/paste/lookup menu everywhere else.
        // A line with no squiggle on it. `.cm-content`'s own centre could land
        // on the misspelled word, which would make this case a second copy of
        // the first — so the payload above ends with plain words and this
        // targets the line element rather than the whole editor.
        const overProse = await probe(".cm-line:last-child");
        expect(overProse, "no editor content to dispatch on").not.toBeNull();
        expect(
          overProse,
          "the contextmenu was prevented over ordinary prose. Myne offers no " +
            "menu there, so this removes the platform's and puts nothing in " +
            "its place — invisible on WebKitGTK, which draws none anyway.",
        ).toBe(false);
      },
    );
  });
});
