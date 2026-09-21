// Saved Views table + list render E2E (Saved Views #7 / MYND-277, #8 / MYND-278).
//
// Pins the two non-cards view types end-to-end against the production binary:
// an all-pages view switched to TABLE via the view-settings modal renders the
// property-column grid (column header + one row per note + group sections when
// `group_by` is set), and switched to LIST renders the dense row list with the
// view's columns as an inline typed-value meta line, ordered by the view's
// sort. Both scenarios drive the REAL seams: `upsert_saved_view` IPC (MYP1)
// through the settings modal, the vault-indices property reindex (the seeded
// `status` key appearing in the group-by/columns pickers), the query engine's
// grouped/sorted `ViewResult`, and the shared row click matrix (row click →
// note opens in the focused tab, replacing the view host).
//
// Setup pattern: notes carrying frontmatter properties are created via
// page-seat IPC + WebView refresh (typing frontmatter through the CM6 Live
// editor is cursor-fragile) — the saved-view-filter-builder vf3 precedent.
// Note titles use the managed `title:` frontmatter key (title precedence
// chain: `title:` ↳ first `# H1` ↳ None; decisions.md 2026-05-15) so the
// table's Name column and the list's primary line carry deterministic text.
//
// The view-settings modal is driven through its real controls: the Segmented
// view-type switch (`view-settings.view-type-${value}`), the single-select
// group-by/sort-key pickers (option click closes), and the MULTI-select
// columns picker (option click toggles, menu STAYS open — closed via the
// trigger's open→close toggle; the portal'd search input is not
// driver-focusable under WebKitWebDriver).
//
// VERIFICATION STATUS (2026-07-17): VERIFIED — green 3× consecutive in the
// container against a fresh production build (1× e2e-buildrun.sh + 2×
// e2e-one.sh, isolated per the full-suite-contamination note), meeting the
// e2e/AGENTS.md definition of done. The suite self-skips off-platform
// (macOS dev host).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  clickUntilVisible,
  dismissImporterOffer,
  dismissImporterOfferIfPresent,
  pageSeatInvoke,
  setViewsEnabled,
  unlockToEditor,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";
import { KEY, activeTestId, pressKey } from "./support/keyboard";

const IPC_TIMEOUT = 15_000;

/** Pick `value` from a custom `SearchableSelect` (testId `root`): open the
 *  trigger, then click the matching `${root}-option`. Single-select closes on
 *  choose; a MULTI-select keeps its menu open after toggling, so pass
 *  `multi: true` to dismiss it via the trigger's close toggle. (Escape on the
 *  portal'd search input is NOT driver-focusable under WebKitWebDriver —
 *  "element not focusable".) */
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
    await (await s.byTestId(root)).click(); // trigger toggle: open → close
    await s.waitForGone(testIdSelector(`${root}-menu`));
  }
}

/** Right-click the view row whose visible label is `label`, then click the
 *  context-menu item with `data-item-id={itemId}`. (Uses `textContent()` —
 *  the label is in a nested span the W3C getText drops.) */
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

/** Seed notes via page-seat IPC (frontmatter typed content), then reload the
 *  WebView so the note cache + vault-indices reindex see them (vf3 pattern —
 *  the notes were created behind the frontend's back). */
async function seedFrontmatterNotes(
  s: Session,
  plaintexts: readonly string[],
): Promise<void> {
  for (const plaintext of plaintexts) {
    const r = await pageSeatInvoke(s, "plugin:notes|note_create", { plaintext }, IPC_TIMEOUT);
    expect(r.err, "note_create should succeed").toBeUndefined();
  }
  await s.refresh();
  await s.byTestId("editor.root", { timeoutMs: 30_000 });
  await dismissImporterOfferIfPresent(s);
}

/** Create an all-pages view via "+ New view" → empty save (cards default),
 *  waiting until it opens as a view tab and lands as a sidebar row. */
async function createAllPagesView(s: Session): Promise<void> {
  // "+ New view" lives INSIDE the Views flyout: it renders while the flyout
  // is shut but is not interactable, so clicking it silently does nothing.
  // Open the flyout first — the same order the passing spec uses.
  await clickUntilVisible(s, "views.section", "views.flyout");
  await clickUntilVisible(s, "views.new-button", "view-filter.modal");
  await (await s.byTestId("view-filter.save")).click();
  await s.waitForGone(testIdSelector("view-filter.modal"));
  await s.byTestId("editor.view-host");
  await s.byTestId("view.cards"); // default view type before the switch
  // The view rows live in the flyout, and the create click CLOSED it.
  // Re-open before counting rows.
  await clickUntilVisible(s, "views.section", "views.flyout");
  await s.waitUntil(
    async () => ((await s.byTestIdAll("views.row")).length === 1 ? true : null),
    { label: "saved view appears in the sidebar" },
  );
}

describeE2E("svt1 table view renders property columns + group sections (MYND-277)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("switches an all-pages view to table with a status column + grouping, renders the grid, and row-click opens the note", async () => {
    let password = "";
    await scenario(
      "svt1-table-render",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        // Views is OPT-IN (`settings.views-enabled`). Without this the Views nav
        // row never renders, so every `views.*` wait below burns its full budget
        // and the spec fails deterministically.
        await setViewsEnabled(s, true);

        // Three notes with a custom `status` property — two share a value so
        // grouping produces sections of size 2 + 1.
        await seedFrontmatterNotes(s, [
          "---\ntitle: Alpha\nstatus: urgent\n---\ntable body alpha",
          "---\ntitle: Beta\nstatus: urgent\n---\ntable body beta",
          "---\ntitle: Gamma\nstatus: later\n---\ntable body gamma",
        ]);

        await createAllPagesView(s);

        // View settings: type=table, columns=[status], group_by=status. The
        // `status` option's presence in both pickers proves the reindex
        // delivered the seeded key (vf3 precedent).
        await rowMenuAction(s, "New view", "view-settings");
        await s.byTestId("view-settings.modal");
        await (await s.byTestId("view-settings.view-type-table")).click();
        await pickSelectOption(s, "view-settings.columns", "status", { multi: true });
        await pickSelectOption(s, "view-settings.group-by", "status");
        await (await s.byTestId("view-settings.save")).click();
        await s.waitForGone(testIdSelector("view-settings.modal"));

        // The table surface replaces the cards surface (real upsert IPC +
        // prefs-nonce refresh re-renders the open view tab).
        await s.byTestId("view.table");
        await s.waitForGone(testIdSelector("view.cards"));

        // The column-header row carries the chosen property column.
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("view.table-header")).textContent()).includes("status")
              ? true
              : null,
          { label: "column header carries the status column" },
        );

        // One data row per note.
        await s.waitUntil(
          async () => ((await s.byTestIdAll("view.table-row")).length === 3 ? true : null),
          { label: "three table rows over the three seeded notes" },
        );

        // Grouping by `status` renders two static group sections whose
        // headings carry the counts (heading renders `<label> · <count>`).
        await s.waitUntil(async () => {
          const headings = await s.byTestIdAll("view.group-heading");
          if (headings.length !== 2) return null;
          const texts = await Promise.all(headings.map((h) => h.textContent()));
          return texts.some((t) => t.includes("urgent") && t.includes("2")) &&
            texts.some((t) => t.includes("later") && t.includes("1"))
            ? true
            : null;
        }, { label: "urgent·2 and later·1 group sections" });

        // A row renders the Name cell + the typed property cell.
        await s.waitUntil(async () => {
          const rows = await s.byTestIdAll("view.table-row");
          const texts = await Promise.all(rows.map((r) => r.textContent()));
          return texts.some((t) => t.includes("Alpha") && t.includes("urgent")) ? true : null;
        }, { label: "a row carries its title and its status cell" });

        // Row click → the note opens in the focused tab, replacing the view
        // host with the note editor (shared click matrix).
        await (await s.byTestId("view.table-row")).click();
        await s.byTestId("editor.content");
        await s.waitForGone(testIdSelector("editor.view-host"));
      },
    );
  });
});

describeE2E("svl1 list view renders sorted rows with a property meta line (MYND-278)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("switches an all-pages view to list with a status column + sort, renders ordered rows, and row-click opens the note", async () => {
    let password = "";
    await scenario(
      "svl1-list-render",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        // Views is OPT-IN (`settings.views-enabled`). Without this the Views nav
        // row never renders, so every `views.*` wait below burns its full budget
        // and the spec fails deterministically.
        await setViewsEnabled(s, true);

        // Two notes whose `status` values order deterministically ("later" <
        // "urgent" lexicographically), so sort asc pins the row order.
        await seedFrontmatterNotes(s, [
          "---\ntitle: Urgent Note\nstatus: urgent\n---\nlist body urgent",
          "---\ntitle: Later Note\nstatus: later\n---\nlist body later",
        ]);

        await createAllPagesView(s);

        // View settings: type=list, columns=[status], sort=status asc (the
        // direction Segmented only renders once a sort key is chosen).
        await rowMenuAction(s, "New view", "view-settings");
        await s.byTestId("view-settings.modal");
        await (await s.byTestId("view-settings.view-type-list")).click();
        await pickSelectOption(s, "view-settings.columns", "status", { multi: true });
        await pickSelectOption(s, "view-settings.sort-key", "status");
        await (await s.byTestId("view-settings.sort-dir-asc")).click();
        await (await s.byTestId("view-settings.save")).click();
        await s.waitForGone(testIdSelector("view-settings.modal"));

        // The list surface replaces the cards surface.
        await s.byTestId("view.list");
        await s.waitForGone(testIdSelector("view.cards"));

        // One row per note; each row's meta line renders the typed `status`
        // value under the title.
        await s.waitUntil(
          async () => ((await s.byTestIdAll("view.list-row")).length === 2 ? true : null),
          { label: "two list rows over the two seeded notes" },
        );
        await s.waitUntil(async () => {
          const rows = await s.byTestIdAll("view.list-row");
          const texts = await Promise.all(rows.map((r) => r.textContent()));
          return texts.some((t) => t.includes("Urgent Note") && t.includes("urgent")) &&
            texts.some((t) => t.includes("Later Note") && t.includes("later"))
            ? true
            : null;
        }, { label: "rows carry title + status meta line" });

        // Sort asc by `status`: "later" sorts before "urgent", so the Later
        // Note leads the DOM order.
        await s.waitUntil(async () => {
          const rows = await s.byTestIdAll("view.list-row");
          if (rows.length !== 2) return null;
          return (await rows[0]!.textContent()).includes("Later Note") ? true : null;
        }, { label: "sort asc puts the later-status row first" });

        // Row click → the note opens in the focused tab, replacing the view
        // host (shared click matrix, same as cards/table).
        await (await s.byTestId("view.list-row")).click();
        await s.byTestId("editor.content");
        await s.waitForGone(testIdSelector("editor.view-host"));
      },
    );
  });
});

describeE2E("svt3 a view row opens from the keyboard (myne#728)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("Tab reaches a table row and an activation key opens its note", async () => {
    // The jsdom tier (`tests/a11y/viewModeRows.test.tsx`) already pins the
    // wiring: role, tabindex, the key handlers and the modifier matrix. What
    // it cannot pin is the half that only a real layout engine decides -
    // whether Tab actually REACHES a row. The rows sit inside a virtualized
    // scroller, and before this change they carried `tabIndex={-1}`, which is
    // legal markup that no Tab ever lands on. That is the failure this
    // scenario exists for, and jsdom has no Tab order to ask.
    let password = "";
    await scenario(
      "svt3-view-row-keyboard",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await setViewsEnabled(s, true);

        await seedFrontmatterNotes(s, [
          "---\ntitle: Keyboard Alpha\nstatus: urgent\n---\nkeyboard body alpha",
          "---\ntitle: Keyboard Beta\nstatus: urgent\n---\nkeyboard body beta",
        ]);
        await createAllPagesView(s);
        await rowMenuAction(s, "New view", "view-settings");
        await s.byTestId("view-settings.modal");
        await (await s.byTestId("view-settings.view-type-table")).click();
        await (await s.byTestId("view-settings.save")).click();
        await s.waitForGone(testIdSelector("view-settings.modal"));
        await s.byTestId("view.table");
        await s.waitUntil(
          async () => ((await s.byTestIdAll("view.table-row")).length === 2 ? true : null),
          { label: "two table rows over the two seeded notes" },
        );

        // Anchor the start point rather than assume it, the way AK-4 does.
        // A first version called `document.body.focus()` and commented that
        // the walk therefore started at the top of the document. That
        // contradicts what this branch measured and recorded two files over:
        // in WebKitGTK the engine resumes the Tab sequence from where the
        // previously focused element sat, and blurring does not reset it
        // (`e2e/AGENTS.md`, and the `_comment_361_to_366` note in
        // `scripts/e2e-scenario-floor.json`). So the walk is anchored on a
        // known element and the anchor is ASSERTED, which makes the 40-stop
        // bound mean something: it is 40 stops from HERE.
        await s.execute(
          "var el = document.querySelector('[data-testid=\"view.table\"]');" +
            "if (el) { el.setAttribute('tabindex', '-1'); el.focus(); }",
        );
        expect(
          await activeTestId(s),
          "the walk starts at the view host, not wherever the last click left focus",
        ).toBe("view.table");

        let reached = false;
        for (let i = 0; i < 40 && !reached; i++) {
          await pressKey(s, KEY.TAB);
          reached = (await activeTestId(s)) === "view.table-row";
        }
        expect(reached, "Tab reaches a table row within 40 stops of the view host").toBe(
          true,
        );

        // Space rather than Enter, and the reason is the harness rather than
        // the app: WebKitGTK's Actions API does not deliver U+E007/U+E006 as
        // an activation here (recorded in e2e/AGENTS.md). The handler reads
        // `e.key` and treats the two identically, and the jsdom tier presses
        // both, so this is a statement about what the DRIVER can send, not
        // about what a user can press.
        await pressKey(s, KEY.SPACE);
        await s.byTestId("editor.content");
        await s.waitForGone(testIdSelector("editor.view-host"));
      },
    );
  });
});
