// The note export menu offers only the formats a BROWSER can produce.
// myne-md/myne#556, the `notes.export` bullet: capability gating, proved by
// absence, in the client whose capability set differs.
//
// # Why this belongs to the web lane and not the desktop one
//
// The `Export…` submenu is built once, in the shared tree
// (`src/notes/noteExportMenu.ts`), and the list it returns is a function of
// `hasCapability("pdfExport")`. Desktop has that capability and web does not
// (`web/src/platform/capabilities.ts` lists `pdfExport` and `vaultExport` as
// absent), so the desktop suite drives the branch where every format is
// offered and CANNOT drive the branch where one is withheld. That asymmetry is
// exactly the case `design-notes.md` 2026-07-26 keeps in `e2e-web/`: shared
// behaviour is tested once on desktop, and what differs by seam is tested here.
//
// # Absence, not disablement
//
// `decisions.md` 2026-07-26 is normative that an absent capability is OMITTED
// rather than rendered disabled: a greyed control is an offer the platform
// cannot honour. So the assertion is that no `export-pdf` row EXISTS, not that
// one exists carrying `disabled`. A build that started rendering it greyed
// would pass a presence-and-attribute check and fail this one, which is the
// right way round.
//
// # The counter-assertion, and why it is half the scenario
//
// "No PDF row" is also what an unopened menu looks like, what a menu that
// failed to render looks like, and what a wrong selector looks like. Each of
// those would pass a bare absence check forever. So the three formats web CAN
// produce are asserted PRESENT in the same read: markdown, HTML and plain text.
// The pair is the test — one says the gate withheld something, the other says
// the menu was there to withhold it from.

import { expect, it } from "vitest";
import { describeE2E } from "./support/scenario";
import { startBundleServer } from "./support/server";
import { newBrowserSession } from "./support/session";
import { DRIVER_PORT } from "./support/worker-ports";
import type { SupportedBrowser } from "./support/harness";
import { loadVaultFixture, seedVault } from "./support/opfs-seed";
import { clickContextMenuItem, createNote, openNoteContextMenu } from "./support/flows";
import { testIdSelector } from "./support/session";

const BUNDLE_DIR = process.env.MYNE_WEB_E2E_BUNDLE_DIR ?? "web/dist";
const BROWSER = (process.env.MYNE_WEB_E2E_BROWSER ?? "chrome") as SupportedBrowser;
const SYNC_ORIGIN = "https://sync.example.test";
const UNLOCK_TIMEOUT_MS = 30_000;

describeE2E("the export submenu withholds the format a page cannot produce", () => {
  it("offers Markdown, HTML and plain text, and no PDF row exists at all", async () => {
    const vault = loadVaultFixture();
    const server = await startBundleServer({ root: BUNDLE_DIR, syncOrigin: SYNC_ORIGIN });
    let browser: Awaited<ReturnType<typeof newBrowserSession>> | undefined;
    try {
      browser = await newBrowserSession({
        baseUrl: `http://127.0.0.1:${DRIVER_PORT}`,
        browser: BROWSER,
      });
      const { session } = browser;

      // Seed on `/__seed`, then boot on `/` — the ordering `support/opfs-seed.ts`
      // documents, since OPFS is origin-scoped and the app reads at boot.
      await session.navigate(`${server.origin}/__seed`);
      await seedVault(session, vault);
      await session.navigate(`${server.origin}/`);

      const unlockField = await session.waitForElement('input[type="password"]', {
        timeoutMs: UNLOCK_TIMEOUT_MS,
      });
      await unlockField.sendKeys(vault.password);
      await (await session.findElement(testIdSelector("unlock.submit"))).click();
      await session.waitForElement(testIdSelector("editor.bottom-bar"), {
        timeoutMs: UNLOCK_TIMEOUT_MS,
      });

      // The fixture vault holds no notes (`unlock-from-fixture.e2e.ts` says so
      // in its own comment), so one is created here rather than seeded: the
      // context menu needs a row to open on.
      await createNote(session);

      await session.waitForElement(testIdSelector("notes.row"), {
        timeoutMs: UNLOCK_TIMEOUT_MS,
      });

      // The menu's own contents, so a failure names what the gesture actually
      // produced. "The export row never appeared" has three causes that look
      // identical from a bare timeout — the menu did not open, it opened
      // without that row, or the row carries another id — and only the list
      // separates them. `openNoteContextMenu` carries the measurement behind
      // not using the driver's right-click here.
      const opened = await openNoteContextMenu(session);
      expect(
        opened,
        `the export parent row is missing from the note context menu. Menu items: ${JSON.stringify(opened)}`,
      ).toContain("export");
      // One level down since myne-md/myne#611: the formats live under one
      // `Export…` row rather than four top-level ones. Opening the parent is
      // what mounts the leaves, so a scenario that asserted absence without it
      // would be reading a menu that never had any format row in it.
      const ids = await clickContextMenuItem(session, "export", "export-markdown");
      // Present: the three a browser can deliver through `platform/download.ts`.
      for (const id of ["export-markdown", "export-html", "export-txt"]) {
        expect(
          ids,
          `${id} must be offered on web — its absence would mean the submenu did ` +
            `not open, which is also what the PDF assertion below would read as a pass`,
        ).toContain(id);
      }
      // Absent: omitted rather than disabled, per decisions.md 2026-07-26.
      expect(
        ids,
        "a page cannot render a PDF, and `pdfExport` is in web's absent set, so the " +
          "row may not exist at all — a disabled one is an offer the platform cannot honour",
      ).not.toContain("export-pdf");
    } finally {
      await browser?.teardown().catch(() => {});
      await server.close();
    }
  });
});
