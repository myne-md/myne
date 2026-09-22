// Keyboard reach and region traversal, in the real render
// (myne-md/myne#728, task 18).
//
// The jsdom tier under `tests/a11y/` covers roles, names and the pure rules,
// and it covers them well. What it cannot cover is the thing this feature is
// actually about: whether a person holding only a keyboard can GET anywhere.
// Focus movement, `inert`, the skip link's ordering and a live region's text
// are all properties of a running app with a layout engine, and every one of
// them can be correct in the DOM and wrong on screen.
//
// Five scenarios, each the real-render half of a task whose jsdom half is
// already green:
//
//   AK-1  the three-region cycle (task 2), including the region roots and
//         their names (task 9)
//   AK-2  the sidebar tree: one Tab stop, arrows inside, the announcement
//         (tasks 6 and 7)
//   AK-3  the note tab strip's tabs/tabpanel pairing (task 3)
//   AK-4  the skip link: second in the Tab order, and it lands in `main`
//         (task 9)
//   AK-5  `inert` on the background while a modal is open (task 8)
//
// Vault-count precondition: 1 per scenario. Linux-only harness; self-skips
// off-platform via describeE2E.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  openSettings,
  rowMenuPick,
  unlockToEditor,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";
import { KEY, pressKey, activeSignature } from "./support/keyboard";

/** The `data-region` of the region containing focus, or null. */
function focusedRegion(session: Session): Promise<string | null> {
  return session.execute<string | null>(
    "var el = document.activeElement;" +
      "if (!el) return null;" +
      "var root = el.closest('[data-region]');" +
      "return root ? root.getAttribute('data-region') : null;",
  );
}

/** Accessible-ish name of the region root carrying `id`, or null when absent. */
function regionName(session: Session, id: string): Promise<string | null> {
  return session.execute<string | null>(
    "var el = document.querySelector('[data-region=\"' + arguments[0] + '\"]');" +
      "return el ? el.getAttribute('aria-label') : null;",
    [id],
  );
}

/** `role` of the region root carrying `id`, or null. */
function regionRole(session: Session, id: string): Promise<string | null> {
  return session.execute<string | null>(
    "var el = document.querySelector('[data-region=\"' + arguments[0] + '\"]');" +
      "return el ? el.getAttribute('role') : null;",
    [id],
  );
}

describeE2E("AK-1 F6 cycles the three regions (myne#728)", () => {
  it("each press lands in the next region, and the regions are named landmarks", async () => {
    // Vault-count precondition: 1.
    let fixture!: SeededVault;
    await scenario(
      "ak1-regions",
      { seed: (appDataDir) => { fixture = seedVault(appDataDir); } },
      async (app) => {
        await app.session.byTestId("unlock.password-input", { timeoutMs: 20_000 });
        await unlockToEditor(app.session, fixture.password);
        await dismissImporterOffer(app.session);
        await createNote(app.session, "RegionCycleNote");

        // The landmarks first: a cycle through three unnamed regions would
        // "pass" while telling a screen-reader user nothing.
        expect(await regionRole(app.session, "sidebar")).toBe("navigation");
        expect(await regionRole(app.session, "editor")).toBe("main");
        expect(await regionRole(app.session, "right-panel")).toBe("complementary");
        for (const id of ["sidebar", "editor", "right-panel"]) {
          const name = await regionName(app.session, id);
          expect(name, `region ${id} is named`).toBeTruthy();
        }

        // Walk the cycle. The ORDER is the assertion, not merely that focus
        // moved: a cycle that always lands in the same region also "moves".
        const visited: Array<string | null> = [];
        for (let i = 0; i < 4; i++) {
          await pressKey(app.session, KEY.F6);
          await app.session.waitUntil(
            async () => ((await focusedRegion(app.session)) !== null ? true : null),
            { label: `F6 press ${i + 1} landed in a region`, timeoutMs: 5_000 },
          );
          visited.push(await focusedRegion(app.session));
        }
        // Three distinct regions, then back to the first: the wrap is what
        // makes it a cycle rather than a walk that ends.
        expect(new Set(visited.slice(0, 3)).size).toBe(3);
        expect(visited[3]).toBe(visited[0]);
      },
    );
  });
});

describeE2E("AK-2 the sidebar is one Tab stop with arrows inside (myne#728)", () => {
  it("the tree is a named tree, the selection moves on arrows, and it announces", async () => {
    // Vault-count precondition: 1.
    let fixture!: SeededVault;
    await scenario(
      "ak2-sidebar-tree",
      { seed: (appDataDir) => { fixture = seedVault(appDataDir); } },
      async (app) => {
        await app.session.byTestId("unlock.password-input", { timeoutMs: 20_000 });
        await unlockToEditor(app.session, fixture.password);
        await dismissImporterOffer(app.session);
        await createNote(app.session, "TreeAlphaNote");
        await createNote(app.session, "TreeBetaNote");

        // The container really is a tree, and it is named. Both were only
        // assertable against the source until now: `NoteList` cannot be
        // rendered in jsdom without a provider harness that does not exist.
        //
        // Selected by testid, NOT by `[role="tree"]` (myne#728, review): the
        // sidebar holds TWO trees since this pass and Favorites is the
        // earlier one in document order, so the bare role selector changes
        // subject the moment a note is favourited. This fixture favourites
        // nothing, so the old selector passed for a reason it never stated.
        const tree = await app.session.execute<{ role: string | null; name: string | null }>(
          "var el = document.querySelector('[data-testid=\"notes.tree\"]');" +
            "return el ? { role: el.getAttribute('role'), name: el.getAttribute('aria-label') } : { role: null, name: null };",
        );
        expect(tree.role).toBe("tree");
        expect(tree.name).toBeTruthy();

        // Exactly ONE Tab stop for the whole list, however many notes it holds.
        const stops = await app.session.execute<number>(
          "var tree = document.querySelector('[data-testid=\"notes.tree\"]');" +
            "if (!tree) return -1;" +
            "var inRows = tree.querySelectorAll('[role=\"treeitem\"][tabindex=\"0\"]').length;" +
            "var onRoot = tree.getAttribute('tabindex') === '0' ? 1 : 0;" +
            "return inRows + onRoot;",
        );
        expect(stops, "one Tab stop for the whole tree").toBe(1);

        // Arrows move the SELECTION inside it, and the polite region says so.
        const announced = (): Promise<string> =>
          app.session.execute<string>(
            "var el = document.querySelector('[data-testid=\"notes.selection-announcement\"]');" +
              "return el ? el.textContent || '' : '';",
          );
        const before = await announced();
        await pressKey(app.session, KEY.ARROW_DOWN);
        await app.session.waitUntil(
          async () => ((await announced()) !== before ? true : null),
          { label: "the selection announcement changed", timeoutMs: 5_000 },
        );
        const after = await announced();
        expect(after.trim().length, "the region is never empty").toBeGreaterThan(0);
        expect(after).not.toBe(before);
      },
    );
  });
});

describeE2E("AK-3 the note tab strip is a tablist with a panel (myne#728)", () => {
  it("one Tab stop, arrows switch tabs, and the pane body is the named panel", async () => {
    // Vault-count precondition: 1.
    let fixture!: SeededVault;
    await scenario(
      "ak3-tabstrip",
      { seed: (appDataDir) => { fixture = seedVault(appDataDir); } },
      async (app) => {
        await app.session.byTestId("unlock.password-input", { timeoutMs: 20_000 });
        await unlockToEditor(app.session, fixture.password);
        await dismissImporterOffer(app.session);
        await createNote(app.session, "TabOneNote");
        await createNote(app.session, "TabTwoNote");
        // MEASURED, and the first version of this scenario was wrong about it:
        // creating a note REUSES the focused pane's active tab, so two creates
        // leave ONE tab open and the assertion below failed at 1. A second tab
        // comes from the row's own "open in new tab", which is the same
        // workspace action the production gesture reaches (`rowMenuPick`'s
        // header explains why the menu rather than a middle-click).
        const firstId = await app.session.execute<string | null>(
          "var rows = document.querySelectorAll('[data-testid=\"notes.row\"]');" +
            "for (var i = 0; i < rows.length; i++) {" +
            "  if ((rows[i].textContent || '').indexOf('TabOneNote') !== -1) return rows[i].getAttribute('data-note-id');" +
            "}" +
            "return null;",
        );
        expect(firstId, "the first note has a sidebar row").toBeTruthy();
        await rowMenuPick(app.session, firstId as string, "open-in-new-tab");
        await app.session.waitUntil(
          async () =>
            (await app.session.byTestIdAll("editor.tab")).length >= 2 ? true : null,
          { label: "a second tab opened", timeoutMs: 8_000 },
        );

        const strip = await app.session.execute<{
          tabs: number;
          stops: number;
          panelLabelled: boolean;
          nested: number;
        }>(
          "var list = document.querySelector('[data-testid=\"editor.tab-strip\"] [role=\"tablist\"]');" +
            "if (!list) return { tabs: 0, stops: -1, panelLabelled: false, nested: -1 };" +
            "var tabs = list.querySelectorAll('[role=\"tab\"]');" +
            "var stops = list.querySelectorAll('[role=\"tab\"][tabindex=\"0\"]').length;" +
            "var panel = document.querySelector('[role=\"tabpanel\"][aria-labelledby]');" +
            "var labelled = false;" +
            "if (panel) {" +
            "  var id = panel.getAttribute('aria-labelledby');" +
            "  var tab = id ? document.getElementById(id) : null;" +
            "  labelled = !!(tab && tab.getAttribute('role') === 'tab');" +
            "}" +
            "var nested = list.querySelectorAll('[role=\"tab\"] button, [role=\"tab\"] a, [role=\"tab\"] [tabindex=\"0\"]').length;" +
            "return { tabs: tabs.length, stops: stops, panelLabelled: labelled, nested: nested };",
        );
        expect(strip.tabs, "two notes are open").toBeGreaterThanOrEqual(2);
        expect(strip.stops, "one Tab stop for the whole strip").toBe(1);
        // The pairing task 3 wired: the panel names itself after the ACTIVE
        // tab, so the id has to resolve to a real `role="tab"`.
        expect(strip.panelLabelled, "the pane body is a panel named by its tab").toBe(true);
        // `nested-interactive`: the per-tab close is a mouse affordance and
        // must not be focusable inside the tab widget.
        expect(strip.nested, "nothing focusable nested inside a tab").toBe(0);
      },
    );
  });
});

describeE2E("AK-4 the skip link is the second stop and lands in main (myne#728)", () => {
  it("capture escape first, skip link second, and activating it enters the editor", async () => {
    // Vault-count precondition: 1.
    let fixture!: SeededVault;
    await scenario(
      "ak4-skip-link",
      { seed: (appDataDir) => { fixture = seedVault(appDataDir); } },
      async (app) => {
        await app.session.byTestId("unlock.password-input", { timeoutMs: 20_000 });
        await unlockToEditor(app.session, fixture.password);
        await dismissImporterOffer(app.session);
        await createNote(app.session, "SkipTargetNote");

        // MEASURED, and the first version of this scenario was wrong about it:
        // blurring does NOT reset the Tab sequence to the document start. The
        // engine resumes from where the previously focused element sat, so the
        // first Tab landed on `editor.frontmatter-title` and the assertion read
        // like a broken skip link rather than a broken probe.
        //
        // The claim is an ORDER, so it is asserted as one. First, the capture
        // escape really is first in the document's own focus order; then, one
        // Tab from it reaches the skip link. Neither depends on where focus
        // happened to be when the scenario started.
        const firstInDom = await app.session.execute<string | null>(
          "var sel = 'a[href], button:not([disabled]), input:not([disabled]), " +
            "select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"]), " +
            "[contenteditable=\"true\"]';" +
            "var all = document.querySelectorAll(sel);" +
            "for (var i = 0; i < all.length; i++) {" +
            "  if (all[i].closest('[inert]')) continue;" +
            "  return all[i].getAttribute('data-testid');" +
            "}" +
            "return null;",
        );
        expect(firstInDom, "the capture escape is first in the focus order").toBe(
          "screen-capture-escape.trigger",
        );

        await app.session.execute(
          "var el = document.querySelector('[data-testid=\"screen-capture-escape.trigger\"]');" +
            "if (el) el.focus();",
        );
        expect(await activeSignature(app.session)).toBe(
          "testid:screen-capture-escape.trigger",
        );
        await pressKey(app.session, KEY.TAB);
        expect(await activeSignature(app.session)).toBe("testid:app.skip-to-content");

        // Activated with SPACE, and the key is a HARNESS finding rather than a
        // preference. Measured in this container, focusing the button and
        // pressing each in turn: U+E007 (Enter) produces no click, U+E006
        // (Return) produces no click, U+E00D (Space) clicks and focus lands in
        // `editor/cm-content`. The first version of this scenario pressed
        // Enter and timed out on the landing with every other assertion green,
        // which reads exactly like a broken skip link and was a broken probe.
        //
        // What that does NOT establish is that Enter fails for a real user: a
        // real WebKitGTK window activates a focused button on Enter, and this
        // is the Actions API's synthesis of it that does not. A user pressing
        // Enter on the skip link is therefore covered by the MANUAL keyboard
        // pass (docs/dev/accessibility-checklist.md section 1), not by this.
        await pressKey(app.session, KEY.SPACE);
        await app.session.waitUntil(
          async () => ((await focusedRegion(app.session)) === "editor" ? true : null),
          { label: "the skip link landed in the editor region", timeoutMs: 5_000 },
        );
        expect(await focusedRegion(app.session)).toBe("editor");
      },
    );
  });
});

describeE2E("AK-5 the background is inert while a modal is open (myne#728)", () => {
  it("opening Settings inerts the shell, and closing it restores exactly what it took", async () => {
    // Vault-count precondition: 1.
    let fixture!: SeededVault;
    await scenario(
      "ak5-inert",
      { seed: (appDataDir) => { fixture = seedVault(appDataDir); } },
      async (app) => {
        await app.session.byTestId("unlock.password-input", { timeoutMs: 20_000 });
        await unlockToEditor(app.session, fixture.password);
        await dismissImporterOffer(app.session);

        const inertCount = (): Promise<number> =>
          app.session.execute<number>("return document.querySelectorAll('[inert]').length;");
        const before = await inertCount();

        await openSettings(app.session);
        const during = await inertCount();
        expect(during, "the shell around the modal went inert").toBeGreaterThan(before);

        // And the modal itself is NOT inside an inert subtree, which is the
        // silent way this breaks: the dialog renders, looks right, and
        // refuses every click.
        const modalReachable = await app.session.execute<boolean>(
          "var m = document.querySelector('[data-testid=\"settings.modal\"]');" +
            "return !!(m && !m.closest('[inert]'));",
        );
        expect(modalReachable, "the modal is not inert itself").toBe(true);

        await pressKey(app.session, KEY.ESCAPE);
        await app.session.waitForGone(testIdSelector("settings.modal"));
        // Restored to EXACTLY what it was: an owner that cleared every inert
        // it found would also un-inert a collapsed sidebar.
        expect(await inertCount()).toBe(before);
      },
    );
  });
});
