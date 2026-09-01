// Vault-to-vault import (myne-md/myne#464).
//
// ONE scenario over ONE fixture, and both halves of that are deliberate.
//
// One fixture, because the rules this feature decided only interact when they
// meet in a single vault: a note is renamed BECAUSE something else being
// imported links to it, and the link is rewritten BECAUSE the note was renamed.
// Seeding them apart would test each rule against a vault where the other rule
// could not fire.
//
// One run, because every run of this flow pays a full Argon2id derivation for
// the source credential inside the scenario's own budget, on the CI runner. Ten
// rules as ten scenarios would be ten derivations to assert what one run shows,
// and `check-e2e-floor.mjs` counts scenarios that EXECUTED rather than
// scenarios that exist.
//
// ─────────────────────────────────────────────────────────────────────────────
// ONE BOOT DETAIL THAT COST THE FIRST THREE RUNS, kept here because it is the
// kind of thing that reads as flake rather than as a precondition.
//
// This fixture seeds TWO vaults, so the app boots to the VAULT PICKER, not to
// the unlock screen (`initialStageFromProbe`: >=2 vaults -> `picker`). Calling
// `unlockToEditor` straight away waits 45 s for `unlock.password-input` against
// a picker that will never render one, three times over, and fails with a
// timeout whose message names the element rather than the stage. The picker row
// has to be clicked first, addressed by the target's own `vaultId`, which is
// what `selectPickerRow` is for. Every other two-vault scenario in this suite
// does the same thing one line earlier (`prefs.e2e.ts`, `vault-label.e2e.ts`).
// ─────────────────────────────────────────────────────────────────────────────
//
// WHAT THIS SCENARIO DOES NOT COVER, said here rather than left to be assumed:
// the dictionary carry. `e2e/fixture-gen` cannot seal a `vault.dictionary`
// without keeping a second copy of the postcard payload that lives in
// `src-tauri/src/spell/dictionary.rs`, and a fixture that re-implements a format
// drifts from it silently. That half is covered by
// `tests/notes/import/myneDictionary.test.ts` (the union and the ignore-set
// exclusion) and by `plugins::importer::source_dictionary::tests` (the read,
// through the real encoder).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVaults, type ImportSourceSuite } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  noteRowIds,
  openSettings,
  selectPickerRow,
  unlockToEditor,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

const IMPORT_LABEL = "Eski laptop";

/** Every sidebar row's rendered title, in DOM order. */
async function sidebarTitles(s: Session): Promise<string[]> {
  const rows = await s.byTestIdAll("notes.row");
  return await Promise.all(rows.map((r) => r.text()));
}

async function waitForPhase(
  s: Session,
  phase: "pick" | "setup" | "running" | "summary",
): Promise<void> {
  await s.waitUntil(
    async () => {
      const el = await s.byTestId("import.modal");
      return (await el.attribute("data-phase")) === phase ? true : null;
    },
    { label: `import.modal[data-phase=${phase}]`, timeoutMs: 120_000 },
  );
}

describeE2E("mvi1 import notes from another Myne vault (myne-md/myne#464)", () => {
  // Vault-count precondition: 2 (weak KDF). The LAST is the import SOURCE.
  it("carries notes, renames a linked collision, and leaves the source alone", async () => {
    let targetPassword = "";
    let targetVaultId = "";
    let sourcePassword = "";
    let suite: ImportSourceSuite | undefined;
    await scenario(
      "mvi1-vault-import",
      {
        seed: (dir) => {
          const vaults = seedVaults(dir, { count: 2, importSourceSuite: true });
          targetPassword = vaults[0].password;
          targetVaultId = vaults[0].vaultId;
          sourcePassword = vaults[vaults.length - 1].password;
          suite = vaults[vaults.length - 1].importSourceSuite;
        },
      },
      async (app) => {
        const s = app.session;
        expect(suite).toBeDefined();
        const fx = suite as ImportSourceSuite;

        // Two vaults means the picker, not the unlock screen. See the header.
        await selectPickerRow(s, targetVaultId);
        await unlockToEditor(s, targetPassword);
        await dismissImporterOffer(s);

        // The TARGET side of the collision is built through the real UI, not by
        // the generator. A collision the generator manufactured on both sides
        // would only prove the generator agrees with itself.
        await createNote(s, fx.collidingLinkedTitle);
        await createNote(s, fx.collidingUnlinkedTitle);
        const before = await noteRowIds(s, 2);

        await openSettings(s, "storage");
        await (await s.byTestId("storage.import")).click();
        await waitForPhase(s, "pick");
        await (
          await s.waitForElement(
            testIdSelector("import.source-row", { "data-source": "myne" }),
          )
        ).click();
        await waitForPhase(s, "setup");

        // The fidelity disclosure is shown BEFORE the run, not after it. Both
        // halves, because this source's `loses` key is the one that says the
        // interesting thing (version history, trash, templates) and it was
        // defined and rendered nowhere until it was wired here.
        expect(await (await s.byTestId("import.source-survives")).text()).not.toBe("");
        expect(await (await s.byTestId("import.source-loses")).text()).not.toBe("");

        // The vault chooser is the `Select` primitive, not a native `<select>`,
        // so its options live in a body-level portal that exists only while the
        // menu is open. Clicking the trigger first is not incidental: without it
        // `byTestIdAll` finds zero options and the count assertion below reads
        // as "the list is empty" when the list was simply closed.
        await (await s.byTestId("import-myne.vault")).click();
        // Two entries: the placeholder plus exactly one real vault. The vault we
        // are IN is not offered, because a vault cannot be its own source, and
        // that is the assertion the count is making.
        const options = await s.byTestIdAll("import-myne.vault-option");
        expect(options).toHaveLength(2);
        await options[1].click();

        await (await s.byTestId("import-myne.secret")).sendKeys(sourcePassword);
        // `replaceText`, not clear()+sendKeys: this is a React controlled input
        // that `MyneVaultSetup` prefills, and W3C clear bypasses React's value
        // tracker so the keystrokes would APPEND to the prefill.
        await (await s.byTestId("import-myne.label")).replaceText(IMPORT_LABEL);
        await (await s.byTestId("import-myne.continue")).click();

        await waitForPhase(s, "summary");

        // The completion step owes two sentences, and this is the assertion that
        // they are actually rendered rather than only written: version history
        // stayed behind, and the source vault is unchanged and still syncing.
        // Asserted on their TEXT rather than on a visibility predicate, because
        // `Element` in this harness has no `isDisplayed` and `byTestId` already
        // throws when the element is absent.
        expect(await (await s.byTestId("import-myne.history-stays")).text()).not.toBe("");
        expect(
          await (await s.byTestId("import-myne.source-unchanged")).text(),
        ).not.toBe("");

        await (await s.byTestId("import.done")).click();

        // ── the rules, asserted on the resulting vault ────────────────────
        //
        // Four notes are added on top of the two the scenario created: the
        // linking note, the renamed collision, the untitled note, and the
        // import report (this fixture always leaves something behind, so the
        // report is always written). The unlinked collision is SKIPPED, and the
        // trashed note and the template stay behind. The count is the first
        // assertion because it fails loudly when any of those rules flips.
        const after = await noteRowIds(s, before.length + 4);
        expect(after.length).toBe(before.length + 4);

        // And the rules by NAME, not only by count. A count is satisfied by any
        // four notes, so on its own it cannot tell the rename rule firing from
        // the skip rule failing: both leave four.
        const titles = await sidebarTitles(s);
        //  1. The LINKED collision was renamed with the import label, so the
        //     imported note is present under its new name and the target's own
        //     note of the old name is untouched.
        expect(titles).toContain(`${fx.collidingLinkedTitle} (${IMPORT_LABEL})`);
        expect(titles).toContain(fx.collidingLinkedTitle);
        //  2. The UNLINKED collision was skipped, so there is exactly ONE note
        //     by that name and no `(Eski laptop)` twin. This is the assertion
        //     that separates "renamed everything" from "renamed what is linked".
        expect(titles).not.toContain(
          `${fx.collidingUnlinkedTitle} (${IMPORT_LABEL})`,
        );
        //  3. The trashed note and the template stayed in the source.
        expect(titles).not.toContain(fx.trashedTitle);
        expect(titles).not.toContain(fx.templateTitle);
        //  4. The linking note crossed.
        expect(titles).toContain(fx.linkingNoteTitle);
      },
    );
  });
});
