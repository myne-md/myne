// Import notes from a `.myne-backup` (myne-md/myne#816; formerly vault-to-vault
// import, myne-md/myne#464).
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
// the backup's credential inside the scenario's own budget, on the CI runner.
// Ten rules as ten scenarios would be ten derivations to assert what one run
// shows, and `check-e2e-floor.mjs` counts scenarios that EXECUTED rather than
// scenarios that exist.
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW THE BACKUP IS PRODUCED AND PICKED, since neither is driveable directly.
//
// The source vault is EXPORTED to a real `.myne-backup` through the production
// `plugin:backup|vault_export_backup` command, invoked from the page seat. Locked
// export is supported by design (SYNC-6), so the target vault stays the open one
// and no second unlock is needed.
//
// The OS file picker cannot be driven by WebDriver, so `plugin:dialog|open` is
// intercepted from the page seat — the same sanctioned stub `note-export.e2e.ts`
// uses for `plugin:dialog|save`: the wrapper goes on the writable global `fetch`,
// only that one IPC URL is answered, and every other request reaches the native
// fetch. Everything past the picker is the real import.
// ─────────────────────────────────────────────────────────────────────────────
//
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

import path from "node:path";
import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVaults, type ImportSourceSuite } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  noteRowIds,
  openSettings,
  pageSeatInvoke,
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

/**
 * Answer `plugin:dialog|open` with `chosen`, from the page seat. Returns whether
 * the patch took (a non-writable `fetch` would silently keep the real transport
 * and open a real, undriveable dialog).
 */
async function patchDialogOpen(s: Session, chosen: string): Promise<boolean> {
  return await s.execute<boolean>(
    // **`return`, and its absence is why this scenario never passed.** W3C's
    // `execute/sync` evaluates the script as a FUNCTION BODY, so the result is
    // whatever the script RETURNS and a bare expression's completion value is
    // discarded: without the leading `return` the driver hands back nothing,
    // `patched` is `null`, and the assertion reads as "the patch did not take"
    // while the patch was never asked whether it had. Every other
    // result-reading script in this harness starts with `return`; this one was
    // the exception.
    "return (() => {" +
      "  const url = window.__TAURI_INTERNALS__.convertFileSrc('plugin:dialog|open', 'ipc');" +
      "  const origFetch = window.fetch.bind(window);" +
      "  window.__e2eDialogOpenPath = arguments[0];" +
      "  window.fetch = function (input, init) {" +
      "    const u = typeof input === 'string' ? input : (input && input.url);" +
      "    if (u === url) {" +
      "      return Promise.resolve(new Response(JSON.stringify(window.__e2eDialogOpenPath), {" +
      "        headers: { 'content-type': 'application/json', 'Tauri-Response': 'ok' }," +
      "      }));" +
      "    }" +
      "    return origFetch(input, init);" +
      "  };" +
      "  return window.fetch !== origFetch;" +
      "})()",
    [chosen],
  );
}

describeE2E("mvi1 import notes from a .myne-backup (myne-md/myne#816)", () => {
  // Vault-count precondition: 2 (weak KDF). The LAST is the import SOURCE.
  it("carries notes, renames a linked collision, and leaves the source alone", async () => {
    let targetPassword = "";
    let targetVaultId = "";
    let sourceVaultId = "";
    let sourcePassword = "";
    let suite: ImportSourceSuite | undefined;
    await scenario(
      "mvi1-backup-import",
      {
        seed: (dir) => {
          const vaults = seedVaults(dir, { count: 2, importSourceSuite: true });
          targetPassword = vaults[0].password;
          targetVaultId = vaults[0].vaultId;
          sourceVaultId = vaults[vaults.length - 1].vaultId;
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

        // Export the SOURCE vault to a real `.myne-backup`. The export reads an
        // EXISTING vault from disk and supports the locked state (SYNC-6), so the
        // target vault stays the open one.
        const backupPath = path.join(app.dataHome, "source.myne-backup");
        const exported = await pageSeatInvoke(
          s,
          "plugin:backup|vault_export_backup",
          { vaultId: sourceVaultId, destination: backupPath },
          60_000,
        );
        if (exported.err !== undefined) {
          throw new Error("export failed: " + JSON.stringify(exported.err));
        }

        // The OS picker is undriveable; hand the import the file we just wrote.
        const patched = await patchDialogOpen(s, backupPath);
        expect(patched).toBe(true);

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
        // interesting thing (version history, trash, templates).
        expect(await (await s.byTestId("import.source-survives")).text()).not.toBe("");
        expect(await (await s.byTestId("import.source-loses")).text()).not.toBe("");

        // Pick the backup (stubbed picker), then the backup's own credential.
        await (await s.byTestId("import-myne.choose-backup")).click();
        await (await s.byTestId("import-myne.secret")).sendKeys(sourcePassword);
        // `replaceText`, not clear()+sendKeys: this is a React controlled input
        // that `MyneVaultSetup` prefills, and W3C clear bypasses React's value
        // tracker so the keystrokes would APPEND to the prefill.
        await (await s.byTestId("import-myne.label")).replaceText(IMPORT_LABEL);
        await (await s.byTestId("import-myne.continue")).click();

        await waitForPhase(s, "summary");

        // The completion step owes two sentences: version history stayed behind,
        // and the source vault is unchanged and still syncing.
        expect(await (await s.byTestId("import-myne.history-stays")).text()).not.toBe("");
        expect(
          await (await s.byTestId("import-myne.source-unchanged")).text(),
        ).not.toBe("");

        await (await s.byTestId("import.done")).click();

        // ── the rules, asserted on the resulting vault ────────────────────
        //
        // Four notes are added on top of the two the scenario created: the
        // linking note, the renamed collision, the untitled note, and the
        // import report. The unlinked collision is SKIPPED, and the trashed note
        // and the template stay behind. The count is the first assertion
        // because it fails loudly when any of those rules flips.
        const after = await noteRowIds(s, before.length + 4);
        expect(after.length).toBe(before.length + 4);

        // And the rules by NAME, not only by count.
        const titles = await sidebarTitles(s);
        expect(titles).toContain(`${fx.collidingLinkedTitle} (${IMPORT_LABEL})`);
        expect(titles).toContain(fx.collidingLinkedTitle);
        expect(titles).not.toContain(
          `${fx.collidingUnlinkedTitle} (${IMPORT_LABEL})`,
        );
        expect(titles).not.toContain(fx.trashedTitle);
        expect(titles).not.toContain(fx.templateTitle);
        expect(titles).toContain(fx.linkingNoteTitle);
      },
    );
  });
});
