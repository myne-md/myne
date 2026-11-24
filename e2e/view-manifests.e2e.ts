// View manifests E2E (view-manifests, myne-md/myne#922).
//
// Three stories, three boots. Each one is a different promise and a different
// precondition, and merging them would make one red read as three.
//
//   vm1  IMPORT → consent → approve → the view renders. The story this feature
//        exists for: a file somebody sent you becomes a working view, and the
//        summary you approve it on is computed from the file rather than
//        declared beside it.
//   vm2  A view that arrives with no approval for THIS device refuses to run,
//        and approving it from the refusal makes it run. The arrival is
//        simulated the way a sync merge would deliver it (`upsert_saved_view`
//        through real IPC plus a WebView reload), not by importing a second
//        file, because import and sync are different doors and only the second
//        one is the "another device changed this" case.
//   vm3  BULK set one declared field over a table selection, see the partial
//        refusal reported per note, and restore the action in one step.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE PICKER. Import opens the OS file dialog, which WebDriver cannot drive, so
// `plugin:dialog|open` is intercepted from the page seat — the sanctioned stub
// `import-myne-vault.e2e.ts` uses (and whose `return` bug that file's comment
// records: W3C evaluates the script as a FUNCTION BODY, so a bare expression's
// completion value is discarded). Everything past the picker is the real
// `read_view_manifest` IPC, the real strict reader, the real prefs write.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS DOES NOT PROVE, said here rather than left to be inferred.
//
// vm2 proves that APPROVAL DOES NOT FOLLOW A DEFINITION: a version this device
// never approved refuses to run, and approving names the version shown. It does
// NOT prove that the approval MAP is device-local for the sync merge, because a
// single device and a single vault cannot observe a merge classification at all.
// That property is a Rust unit test over the classification table
// (`view_approvals_are_device_local_and_never_arrive_by_sync`,
// `core/src/plugins/sync/prefs_merge.rs`), and an E2E that claimed it here would
// be green whatever the classification said.
//
// vm3 asserts the RESTORED BYTES by opening each written note in source mode
// after the restore, not merely that the restore reported success. The refused
// note is asserted to be untouched for the same reason: a restore that also
// reverted a note the action never wrote would be a different bug wearing a
// green tick.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  clickRibbonUntilVisible,
  clickUntilVisible,
  dismissImporterOffer,
  dismissImporterOfferIfPresent,
  editorSourceText,
  pageSeatInvoke,
  replaceFieldText,
  runPaletteAction,
  searchAndOpenNote,
  setViewsEnabled,
  unlockToEditor,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

const IPC_TIMEOUT = 15_000;

/** The one view id every scenario in this file uses. Chosen rather than random
 *  so a failure names the same thing in the app, the prefs blob and this file. */
const VIEW_ID = "e2e-books";

/**
 * A `.myneview` file, written into the session's data dir so the seeded tree and
 * the file under test live and die together, and so nothing has to be rooted at
 * an absolute path outside the harness.
 *
 * The shape is the real one: `owner` appears ONLY in the filter (no column,
 * no sort, no grouping), which is exactly the key an under-declaring author
 * would have hidden, so vm1's consent assertion is about the derivation rather
 * than about a list the file also carries.
 */
function writeManifest(
  dir: string,
  name: string,
  view: Record<string, unknown>,
): string {
  const file = path.join(dir, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(view), "utf8");
  return file;
}

function manifestV1(): Record<string, unknown> {
  return {
    columns: ["status"],
    filters: { kind: "property", key: "owner", op: "==", value: "me" },
    id: VIEW_ID,
    name: "E2E Books",
    version: 1,
    view_type: "table",
    write_fields: ["status"],
  };
}

/** Version 2 of the same definition, for the simulated arrival. The name is
 *  unchanged on purpose: the reader should be able to tell it is the same view
 *  at a new version, which is the whole point of the version. */
function manifestV2(): Record<string, unknown> {
  return { ...manifestV1(), columns: ["status", "owner"], version: 2 };
}

/**
 * Intercept `plugin:dialog|open` from the page seat and answer with `chosen`.
 *
 * The wrapper goes on the writable global `fetch` carrying Tauri's
 * custom-protocol IPC, answers ONLY that one URL with a synthetic ok-Response,
 * and delegates every other request to the native fetch. `__TAURI_INTERNALS__`
 * itself is non-writable on the production build, which is why this seam rather
 * than the invoke function is the one that can be replaced.
 */
async function patchDialogOpen(s: Session, chosen: string): Promise<boolean> {
  return await s.execute<boolean>(
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

/** Create notes through real IPC (frontmatter typed into the Live editor is
 *  cursor-fragile), then reload so the note cache and the vault-indices reindex
 *  see them. The `saved-views-table-list.e2e.ts` precedent. Returns the ids in
 *  the order given, which is what lets vm3 drive a specific note. */
async function seedFrontmatterNotes(
  s: Session,
  plaintexts: readonly string[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const plaintext of plaintexts) {
    const r = await pageSeatInvoke(
      s,
      "plugin:notes|note_create",
      { plaintext },
      IPC_TIMEOUT,
    );
    expect(r.err, "note_create should succeed").toBeUndefined();
    ids.push(String(r.ok));
  }
  await s.refresh();
  await s.byTestId("editor.root", { timeoutMs: 30_000 });
  await dismissImporterOfferIfPresent(s);
  return ids;
}

/** Open the Views manager from the command palette (its only entry point; it is
 *  deliberately NOT behind the device-local sidebar toggle). */
async function openManager(s: Session): Promise<void> {
  await runPaletteAction(s, "views.manage", "manage views");
  await s.byTestId("views-manager.modal");
}

/** Run one import through the real dialog stub and stop at the `ready` step,
 *  which is where nothing has been written yet. Returns the file path it used. */
async function importToReady(s: Session, file: string): Promise<void> {
  expect(await patchDialogOpen(s, file), "the dialog stub took").toBe(true);
  await (await s.byTestId("views-manager.import")).click();
  await s.byTestId("view-import.body");
  await (await s.byTestId("view-import.pick")).click();
  await s.byTestId("view-import.ready", { timeoutMs: 20_000 });
}

/** Wait until the manager's row for `VIEW_ID` reports the approval state
 *  `approved`. The attribute is the row's own projection of the same comparison
 *  the host makes, so this waits on the app's answer rather than on a click
 *  having landed. */
async function waitManagerRowApproved(
  s: Session,
  approved: boolean,
): Promise<void> {
  await s.waitUntil(
    async () => {
      for (const row of await s.byTestIdAll("views-manager.row")) {
        if ((await row.attribute("data-view-id")) !== VIEW_ID) continue;
        return (await row.attribute("data-approved")) === String(approved)
          ? true
          : null;
      }
      return null;
    },
    { label: `manager row ${VIEW_ID} data-approved=${String(approved)}` },
  );
}

/** Create an all-pages view through the real UI ("+ New view" → empty save). */
async function createAllPagesView(s: Session): Promise<void> {
  await clickRibbonUntilVisible(s, "views.show", "views.flyout");
  await clickUntilVisible(s, "views.new-button", "view-filter.modal");
  await (await s.byTestId("view-filter.save")).click();
  await s.waitForGone(testIdSelector("view-filter.modal"));
  await s.byTestId("editor.view-host");
  await s.byTestId("view.cards");
  // The create click DISMISSED the flyout, and every caller's next step is a row
  // action, so re-open it and wait for the row rather than leaving the caller to
  // discover an empty list. (The `saved-views-table-list.e2e.ts` precedent.)
  await clickRibbonUntilVisible(s, "views.show", "views.flyout");
  await s.waitUntil(
    async () => ((await s.byTestIdAll("views.row")).length === 1 ? true : null),
    { label: "the new view lands as one flyout row" },
  );
}

/** Right-click the flyout row whose visible label is `label`, then pick a menu
 *  item by its `data-item-id`. `textContent()` because the label sits in a
 *  nested span the W3C getText drops. */
async function rowMenuAction(
  s: Session,
  label: string,
  itemId: string,
): Promise<void> {
  const rows = await s.byTestIdAll("views.row");
  for (const r of rows) {
    if ((await r.textContent()).includes(label)) {
      await r.rightClick();
      await (
        await s.waitForElement(
          testIdSelector("notes.context-menu-item", { "data-item-id": itemId }),
        )
      ).click();
      return;
    }
  }
  throw new Error(`no views.row labelled "${label}"`);
}

/** Pick one `SearchableSelect` option; a MULTI-select keeps its menu open after
 *  toggling, so it is dismissed through the trigger's own open→close toggle
 *  (Escape is not driver-focusable inside the portal under WebKitWebDriver). */
async function pickSelectOption(
  s: Session,
  root: string,
  value: string,
  opts?: { multi?: boolean },
): Promise<void> {
  await (await s.byTestId(root)).click();
  await (
    await s.waitForElement(
      testIdSelector(`${root}-option`, { "data-value": value }),
    )
  ).click();
  if (opts?.multi) {
    await (await s.byTestId(root)).click();
    await s.waitForGone(testIdSelector(`${root}-menu`));
  }
}

describeE2E("vm1 import a manifest, read the consent summary, approve, render (myne-md/myne#922)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("stores nothing until the user chooses, shows what the file reads, and renders after approval", async () => {
    let password = "";
    let file = "";
    await scenario(
      "vm1-import-consent-approve",
      {
        seed: (dir) => {
          password = seedVault(dir).password;
          file = writeManifest(dir, "books.myneview", manifestV1());
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await setViewsEnabled(s, true);
        await seedFrontmatterNotes(s, [
          "---\ntitle: Alpha\nowner: me\nstatus: urgent\n---\nbody alpha",
          "---\ntitle: Beta\nowner: me\nstatus: later\n---\nbody beta",
        ]);

        await openManager(s);
        await s.byTestId("views-manager.empty");
        await importToReady(s, file);

        // The summary is computed from the definition, and the key that appears
        // ONLY in the filter is the case an under-declaring author would have
        // hidden. `owner` is in no column and in no sort or group key.
        await s.waitUntil(
          async () => {
            const reads = await (await s.byTestId("view-consent.reads")).textContent();
            return reads.includes("owner") && reads.includes("status") ? true : null;
          },
          { label: "consent lists the filter-only property as read" },
        );
        const selection = await (await s.byTestId("view-consent.selection")).textContent();
        expect(selection, "the selection names the property condition").toContain("owner");
        const writes = await (await s.byTestId("view-consent.writes")).textContent();
        expect(writes, "the writable set is the declared one").toContain("status");
        // A summary never claims the whole vault: the derivation has no such case.
        expect(
          (await (await s.byTestId("view-consent.root")).textContent()).toLowerCase(),
        ).not.toContain("all properties");

        // NOTHING is stored yet: the manager behind the dialog is still empty.
        await s.byTestId("views-manager.empty");

        // Store → the definition lands, and this device has NOT approved it.
        await (await s.byTestId("view-import.store")).click();
        await s.byTestId("view-import.stored", { timeoutMs: 20_000 });
        await waitManagerRowApproved(s, false);
        const state = await (await s.byTestId("views-manager.row-state")).textContent();
        expect(state, "an imported view is pending, never pre-approved").toContain(
          "Needs approval",
        );

        // Approve from the panel that shows the summary, then open it.
        await (await s.byTestId("view-import.approve")).click();
        await waitManagerRowApproved(s, true);
        await (await s.byTestId("view-import.close")).click();

        await (await s.byTestId("views-manager.row-open")).click();
        await s.byTestId("editor.view-host");
        await s.byTestId("view.table", { timeoutMs: 30_000 });
        await s.waitUntil(
          async () =>
            (await s.byTestIdAll("view.table-row")).length === 2 ? true : null,
          { label: "the imported view selects the two notes it declares" },
        );
      },
    );
  });
});

describeE2E("vm2 an unapproved version refuses to run until this device approves it (myne-md/myne#922)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("renders a pending refusal for a version this device never approved, then runs it after approving", async () => {
    let password = "";
    let file = "";
    await scenario(
      "vm2-pending-approval",
      {
        seed: (dir) => {
          password = seedVault(dir).password;
          file = writeManifest(dir, "books-v1.myneview", manifestV1());
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await setViewsEnabled(s, true);
        await seedFrontmatterNotes(s, [
          "---\ntitle: Alpha\nowner: me\nstatus: urgent\n---\nbody alpha",
          "---\ntitle: Beta\nowner: me\nstatus: later\n---\nbody beta",
        ]);

        // Land v1 and approve it, so the arrival below is an UPDATE of a view
        // this device has already agreed to.
        await openManager(s);
        await importToReady(s, file);
        await (await s.byTestId("view-import.store")).click();
        await s.byTestId("view-import.stored", { timeoutMs: 20_000 });
        await (await s.byTestId("view-import.approve")).click();
        await waitManagerRowApproved(s, true);
        // The import dialog is a nested modal OVER the manager: leaving it open
        // makes every manager control un-clickable, which is what a ten-second
        // "interactable" timeout looked like the first time.
        await (await s.byTestId("view-import.close")).click();
        await (await s.byTestId("views-manager.row-open")).click();
        await s.byTestId("view.table", { timeoutMs: 30_000 });

        // A second device's higher version arrives the way sync delivers it: the
        // definition is written into `saved_views` with no approval entry for the
        // new version, and the WebView reloads. This is NOT the import door.
        const r = await pageSeatInvoke(
          s,
          "plugin:prefs|upsert_saved_view",
          { view: manifestV2() },
          IPC_TIMEOUT,
        );
        expect(r.err, "the arriving definition is stored").toBeUndefined();
        await s.refresh();
        await s.byTestId("editor.root", { timeoutMs: 30_000 });
        await dismissImporterOfferIfPresent(s);

        // The manager says so on the row, and its open action is refused.
        await openManager(s);
        await waitManagerRowApproved(s, false);
        expect(
          await (await s.byTestId("views-manager.row-open")).attribute("disabled"),
          "the manager refuses to open a pending version",
        ).not.toBeNull();
        // Close the manager through its own control, then reach the view by the
        // SIDEBAR door (a flyout row) rather than through this modal: the
        // refusal has to be a property of RUNNING a view, not of one button.
        await (await s.byTestId("views-manager.modal-close")).click();
        await s.waitForGone(testIdSelector("views-manager.modal"));
        await clickRibbonUntilVisible(s, "views.show", "views.flyout");
        await (await s.byTestId("views.row")).click();
        await s.byTestId("editor.view-pending", { timeoutMs: 30_000 });
        // The query did not run: there is no table and no card grid behind the
        // refusal, which is the difference between "gated" and "hidden".
        expect(
          (await s.byTestIdAll("view.table")).length,
          "no table renders while the decision is open",
        ).toBe(0);
        expect(
          (await s.byTestIdAll("view.cards")).length,
          "no card grid renders while the decision is open",
        ).toBe(0);

        // Approve where the refusal is, and the same tab runs.
        await (await s.byTestId("editor.view-pending-approve")).click();
        await s.byTestId("view.table", { timeoutMs: 30_000 });
        await s.waitUntil(
          async () =>
            (await s.byTestIdAll("view.table-row")).length === 2 ? true : null,
          { label: "the approved version runs and selects its two notes" },
        );
      },
    );
  });
});

describeE2E("vm3 bulk set one declared field with a partial refusal and one restore (myne-md/myne#922)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("writes what it can, reports the note that changed elsewhere, and restores the written bytes in one action", async () => {
    let password = "";
    await scenario(
      "vm3-bulk-set-restore",
      {
        // **v0.1 on purpose.** A note in the current on-disk format is a CRDT
        // note whose change graph is its own history, so a field write captures
        // no snapshot and the restore is not offered at all (the component test
        // `tableView.test.tsx` covers that arm). The restore this scenario exists
        // for needs a note the host snapshots, which is the v0.1 generation.
        seed: (dir) => void (password = seedVault(dir, { generation: "v0.1" }).password),
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await setViewsEnabled(s, true);

        const [alphaId, betaId, gammaId] = await seedFrontmatterNotes(s, [
          "---\ntitle: Alpha\nowner: me\nstatus: urgent\n---\nbody alpha",
          "---\ntitle: Beta\nowner: me\nstatus: urgent\n---\nbody beta",
          "---\ntitle: Gamma\nowner: me\nstatus: later\n---\nbody gamma",
        ]);
        expect(alphaId, "Alpha has an id").toBeTruthy();
        expect(betaId, "Beta has an id").toBeTruthy();
        expect(gammaId, "Gamma has an id").toBeTruthy();

        // A table view that declares `status` writable. The local save approves
        // it on this device in the same write (that is the edit path's rule), so
        // the bulk action below is allowed to write at all.
        await createAllPagesView(s);
        await rowMenuAction(s, "New view", "view-settings");
        await s.byTestId("view-settings.modal");
        await (await s.byTestId("view-settings.view-type-table")).click();
        await pickSelectOption(s, "view-settings.columns", "status", { multi: true });
        await pickSelectOption(s, "view-settings.write-fields", "status", { multi: true });
        await (await s.byTestId("view-settings.save")).click();
        await s.waitForGone(testIdSelector("view-settings.modal"));
        await s.byTestId("view.table", { timeoutMs: 30_000 });
        await s.byTestId("view.bulk-bar");
        await s.waitUntil(
          async () =>
            (await s.byTestIdAll("view.table-row")).length === 3 ? true : null,
          { label: "three rows over the three seeded notes" },
        );
        const viewId = await (
          await s.byTestId("editor.view-host")
        ).attribute("data-view-id");
        expect(viewId, "the open view names itself").toBeTruthy();

        // ONE note changes underneath the table, through the same production
        // command the feature ships. The table still shows `urgent` for it, so
        // the bulk action's value-anchored precondition is about to be wrong for
        // exactly that note and for no other. Deterministic, unlike racing a
        // second window.
        const drifted = await pageSeatInvoke(
          s,
          "plugin:notes|note_set_field",
          {
            noteId: betaId,
            viewId: String(viewId),
            field: "status",
            expectedValue: "urgent",
            newValue: "elsewhere",
          },
          IPC_TIMEOUT,
        );
        expect(drifted.err, "the concurrent write lands").toBeUndefined();

        // Select all three and set the declared field to one value.
        //
        // Clicked through a re-finding retry, and each click confirmed by the
        // SELECTED COUNT rather than by the click returning: the table re-renders
        // as each row is selected (the bulk bar mounts on the first one), so a
        // handle collected up front is replaced before the second click and the
        // driver reports `stale element reference` from its interactable poll.
        for (let want = 1; want <= 3; want++) {
          await s.waitUntil(
            async () => {
              const rows = await s.byTestIdAll("view.bulk-select-row");
              const states = await Promise.all(rows.map((row) => row.attribute("aria-checked")));
              if (states.filter((state) => state === "true").length >= want) return true;
              const next = states.findIndex((state) => state !== "true");
              if (next < 0) return null;
              try {
                await rows[next]!.click();
              } catch {
                return null;
              }
              return null;
            },
            { label: `${want} of 3 rows selected`, timeoutMs: 20_000 },
          );
        }
        await replaceFieldText(s, "view.bulk-value", "done");
        // Same reason as the row clicks: the bar re-renders between the find and
        // the click, so the handle is re-taken on every poll.
        await s.waitUntil(
          async () => {
            const [apply] = await s.byTestIdAll("view.bulk-apply");
            if (apply === undefined) return null;
            try {
              await apply.click();
              return true;
            } catch {
              return null;
            }
          },
          { label: "the bulk apply action accepts the click", timeoutMs: 20_000 },
        );

        // Two landed, one refused, and the refusal is reported PER NOTE with the
        // host's own reason rather than folded into a count.
        await s.byTestId("view.bulk-report", { timeoutMs: 30_000 });
        await s.waitUntil(
          async () => {
            const report = await (await s.byTestId("view.bulk-report")).textContent();
            return report.includes("2") && report.includes("that field changed somewhere else")
              ? true
              : null;
          },
          { label: "two written and one refusal naming the drifted field" },
        );
        // The refusal names WHICH note it is about, by id rather than by position:
        // a report that only says "one refused" leaves the reader to guess. The
        // lines are read through the report's own `data-note-id` attribute, the
        // same observability hook the row carries.
        await s.waitUntil(
          async () => {
            const lines = await s.execute<Array<{ id: string; text: string }>>(
              "return Array.from(document.querySelectorAll(" +
                "'[data-testid=\"view.bulk-report\"] p[data-note-id]'))" +
                ".map(function (p) {" +
                "  return { id: p.getAttribute('data-note-id'), text: p.textContent || '' };" +
                "});",
            );
            if (lines.length !== 1) return null;
            return lines[0]!.id === betaId && lines[0]!.text.includes("Beta")
              ? true
              : null;
          },
          { label: "exactly one refusal line, naming the drifted note by id" },
        );

        // ONE action restores everything the action wrote.
        //
        // Clicked through a re-finding retry rather than one handle: the bulk bar
        // re-renders when the report grows, so a node found a moment earlier is
        // replaced before the click lands and the driver reports `stale element
        // reference` from its interactable poll.
        await s.waitUntil(
          async () => {
            const [button] = await s.byTestIdAll("view.bulk-restore");
            if (button === undefined) return null;
            try {
              await button.click();
              return true;
            } catch {
              return null;
            }
          },
          { label: "the restore action accepts the click", timeoutMs: 30_000 },
        );
        await s.byTestId("view.bulk-restored", { timeoutMs: 30_000 });
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("view.bulk-restored")).textContent()).includes("2")
              ? true
              : null,
          { label: "restored 2" },
        );

        // THE BYTES, not the absence of an error. Alpha and Gamma come back to
        // what they held before the set; Beta is still the value the concurrent
        // write put there, because the action never wrote it.
        await searchAndOpenNote(s, "Alpha", alphaId);
        await s.byTestId("editor.content");
        const alpha = await editorSourceText(s);
        expect(alpha, "Alpha is back to its pre-action value").toContain("status: urgent");

        await searchAndOpenNote(s, "Gamma", gammaId);
        await s.byTestId("editor.content");
        const gamma = await editorSourceText(s);
        expect(gamma, "Gamma is back to its pre-action value").toContain("status: later");

        await searchAndOpenNote(s, "Beta", betaId);
        await s.byTestId("editor.content");
        const beta = await editorSourceText(s);
        expect(beta, "the refused note keeps the value the other writer set").toContain(
          "status: elsewhere",
        );
      },
    );
  });
});
