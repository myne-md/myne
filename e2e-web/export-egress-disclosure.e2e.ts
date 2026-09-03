// The plaintext-egress sentence is said BEFORE the file is handed over, and
// Cancel is a free exit. myne-md/myne#556, the `export.note-file` bullet.
//
// # Why this can only be a browser scenario
//
// Myne says its plaintext egress once, at the decision point. On desktop that
// "once" is the OS save dialog's TITLE: the sentence is on screen while the
// user is still choosing whether and where, and dismissing the dialog costs
// nothing. `src/notes/exportFlow.ts` says so in its own header, and the
// `confirmEgress` hook exists because a browser download has no title and no
// dismissable step — `deliverFile` resolves with the file already handed to the
// browser.
//
// So this dialog exists ONLY on the download path, which is the web client.
// The four `e2e/note-export*` suites drive the save-dialog path and cannot
// reach it: there is no branch to reach, the hook is never called there.
//
// # What is asserted, and what is deliberately not
//
// Asserted: the notice appears after choosing a format and BEFORE anything is
// delivered, its sentence is the load-bearing literal rather than a
// paraphrase, and Cancel dismisses it leaving the app usable.
//
// NOT asserted here: that the bytes never reached disk. Observing the absence
// of a download needs a configured download directory in the browser
// capabilities, which this lane does not set up yet; the bullet's delivery half
// belongs with that change. Ordering is what this file owns, and ordering is
// the property `exportFlow.ts` calls the whole point: a disclosure delivered
// after `deliverFile` is not a disclosure, it is a notification that plaintext
// has already left.
//
// # The literal, not a substring
//
// `EXPORT_PLAIN_MARKDOWN_SENTENCE` is load-bearing copy. A `toContain` would
// pass against a sentence that had grown a hedge or lost its second clause, and
// the second clause ("it is not encrypted") is the whole disclosure.

import { expect, it } from "vitest";
import { describeE2E } from "./support/scenario";
import { startBundleServer } from "./support/server";
import { newBrowserSession } from "./support/session";
import { DRIVER_PORT } from "./support/worker-ports";
import type { SupportedBrowser } from "./support/harness";
import { loadVaultFixture, seedVault } from "./support/opfs-seed";
import {
  clickContextMenuItem,
  clickContextMenuLeaf,
  createNote,
  openNoteContextMenu,
} from "./support/flows";
import { EXPORT_PLAIN_MARKDOWN_SENTENCE } from "../src/lib/load-bearing-copy";

const BUNDLE_DIR = process.env.MYNE_WEB_E2E_BUNDLE_DIR ?? "web/dist";
const BROWSER = (process.env.MYNE_WEB_E2E_BROWSER ?? "chrome") as SupportedBrowser;
const SYNC_ORIGIN = "https://sync.example.test";
const UNLOCK_TIMEOUT_MS = 30_000;

describeE2E("the download path says the egress sentence before it delivers", () => {
  it("shows the verbatim sentence on choosing Markdown, and Cancel leaves the app usable", async () => {
    const vault = loadVaultFixture();
    const server = await startBundleServer({ root: BUNDLE_DIR, syncOrigin: SYNC_ORIGIN });
    let browser: Awaited<ReturnType<typeof newBrowserSession>> | undefined;
    try {
      browser = await newBrowserSession({
        baseUrl: `http://127.0.0.1:${DRIVER_PORT}`,
        browser: BROWSER,
      });
      const { session } = browser;

      await session.navigate(`${server.origin}/__seed`);
      await seedVault(session, vault);
      await session.navigate(`${server.origin}/`);

      const unlockField = await session.waitForElement('input[type="password"]', {
        timeoutMs: UNLOCK_TIMEOUT_MS,
      });
      await unlockField.sendKeys(vault.password);
      await (await session.findElement('[data-testid="unlock.submit"]')).click();
      await session.waitForElement('[data-testid="editor.bottom-bar"]', {
        timeoutMs: UNLOCK_TIMEOUT_MS,
      });

      // The fixture vault holds no notes, so one is made here: the export menu
      // needs a note row to open on.
      await createNote(session);
      await session.waitForElement('[data-testid="notes.row"]', {
        timeoutMs: UNLOCK_TIMEOUT_MS,
      });

      // The notice must NOT be on screen before a format is chosen. Without
      // this, a build that showed it at some unrelated moment — or a stale one
      // left over from an earlier action — would satisfy every assertion below
      // while proving nothing about ordering.
      expect(
        (await session.byTestIdAll("export.egress-notice")).length,
        "the egress notice may not be on screen before a format is chosen",
      ).toBe(0);

      await openNoteContextMenu(session);
      await clickContextMenuItem(session, "export", "export-markdown");
      // A LEAF: it performs the export and dismisses the menu, so the wait is
      // for the menu to GO rather than for it to still hold items.
      await clickContextMenuLeaf(session, "export-markdown");

      const notice = await session.waitForElement('[data-testid="export.egress-notice"]', {
        timeoutMs: 15_000,
      });
      expect(notice, "the download path must ask before it delivers").toBeDefined();

      const sentence = await session.findElement('[data-testid="export.egress-sentence"]');
      expect(
        (await sentence.textContent()).trim(),
        "the disclosure is load-bearing copy and is rendered verbatim, not paraphrased",
      ).toBe(EXPORT_PLAIN_MARKDOWN_SENTENCE);

      // Cancel is a free exit: the notice goes and the editor is still there.
      await (await session.findElement('[data-testid="export.egress-cancel"]')).click();
      await session.waitUntil(
        async () =>
          (await session.byTestIdAll("export.egress-notice")).length === 0 ? true : null,
        { label: "the egress notice dismissed on Cancel", timeoutMs: 10_000 },
      );
      await session.waitForElement('[data-testid="editor.bottom-bar"]', { timeoutMs: 10_000 });
    } finally {
      await browser?.teardown().catch(() => {});
      await server.close();
    }
  });
});
