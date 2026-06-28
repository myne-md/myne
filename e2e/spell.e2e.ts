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

import { it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  closeSettings,
  createNote,
  dismissImporterOffer,
  editorText,
  openSettings,
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
function squiggleFor(s: Session, word: string, timeoutMs = 30_000): Promise<Element> {
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
        await (await s.byTestId("notes.row")).click(); // reopen the note post-reload
        await squiggleGoneFor(s, WORD);

        // The toggle itself reads back Off (mount effect reads the pref).
        await openSettings(s, "editor");
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
        await (await s.byTestId("notes.row")).click(); // reopen the note post-reload
        await squiggleFor(s, WORD);
      },
    );
  });
});
