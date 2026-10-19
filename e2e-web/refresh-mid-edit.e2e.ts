// An edit that has not been saved yet survives a page refresh.
// myne-md/myne#556, the `web.lifecycle.refresh-mid-edit` bullet.
//
// # Why this entry had no coverage of any kind
//
// `web.lifecycle.refresh-mid-edit` sits in the manual roster with ZERO manual
// items and ZERO `automatedBy`: nothing human and nothing machine had a verdict
// on it, while the entry's presence read as though the surface were covered.
// The one file that names the surface, `e2e-web/close-tab-flush.e2e.ts`, holds
// a single `it.skip` for a defect that is still open — a tab CLOSE does not
// persist the unflushed edit — so the file exists, runs nothing, and claims
// nothing.
//
// A refresh is a different mechanism from a close and has to be asserted
// separately. `web/src/platform/exit-signals.ts` is explicit that `pagehide` is
// the last reliable moment and `beforeunload` is a warning rather than the
// flush point; a driver navigation fires `pagehide` synchronously in the same
// task, which is exactly the case the open defect's own investigation
// established DOES fire. So the refresh half is answerable today, and pinning
// it is what stops the whole surface reading as "blocked on that defect".
//
// # Why the assertion is the DOCUMENT and not a save indicator
//
// A save indicator says the app believes it saved. What this scenario is about
// is what a second load finds, so the read is the reloaded editor's own text.
// A build that flipped the indicator and dropped the bytes would pass the first
// check and fail this one, which is the right way round.

import { expect, it } from "vitest";
import { describeE2E } from "./support/scenario";
import { startBundleServer } from "./support/server";
import { newBrowserSession } from "./support/session";
import { DRIVER_PORT } from "./support/worker-ports";
import type { SupportedBrowser } from "./support/harness";
import { loadVaultFixture, seedVault } from "./support/opfs-seed";
import { createNote, typeIntoEditor } from "./support/flows";
import { testIdSelector } from "./support/session";

const BUNDLE_DIR = process.env.MYNE_WEB_E2E_BUNDLE_DIR ?? "web/dist";
const BROWSER = (process.env.MYNE_WEB_E2E_BROWSER ?? "chrome") as SupportedBrowser;
const SYNC_ORIGIN = "https://sync.example.test";
const UNLOCK_TIMEOUT_MS = 30_000;

// Distinctive, and deliberately not a word the shell renders anywhere else: a
// substring that also appears in a placeholder, a tooltip or a note title would
// let the reload assertion pass on a document that never came back.
const SENTENCE = "refreshmidedit alfa7k2m9qx4w8e5rj0";

/** The editor's rendered text, or "" when no editor is mounted. */
async function editorText(session: { execute: <T>(s: string) => Promise<T> }): Promise<string> {
  return session.execute<string>(
    "var c = document.querySelector('[data-testid=\"editor.content\"] .cm-content');" +
      "return c ? c.textContent : '';",
  );
}

describeE2E("an unsaved edit survives a refresh", () => {
  // **`it.skip`, and it records a MEASURED defect rather than a flaky test.**
  //
  // Run against develop today this fails, and the measurement is specific: the
  // sentence is in the document before the reload (asserted below, so the run
  // is not proving something about an empty editor), the note SURVIVES the
  // reload (its sidebar row is there, asserted below too), the editor mounts,
  // and the body comes back EMPTY. Content the user typed is gone, and the note
  // is left present-but-empty, which is worse than absent: it looks saved.
  //
  // Its sibling is already recorded. `e2e-web/close-tab-flush.e2e.ts` carries
  // the same shape for a tab CLOSE, with `pagehide` measured as firing and the
  // likely mechanism named as async work started in a teardown handler. Both
  // paths fire `pagehide`, so this is the second observation of one cause
  // rather than a second defect.
  //
  // Skipped rather than `describeE2E.flaky`, for the reason that file gives:
  // quarantine is for tests that sometimes fail, and this one never passes.
  // Filing it as flaky would hide a data-loss finding in a bucket nobody reads.
  it.skip("finds the typed sentence in the document after the page is reloaded", async () => {
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
      await (await session.findElement(testIdSelector("unlock.submit"))).click();
      await session.waitForElement(testIdSelector("editor.bottom-bar"), {
        timeoutMs: UNLOCK_TIMEOUT_MS,
      });

      await createNote(session);
      await typeIntoEditor(session, SENTENCE);

      // The text is in the DOCUMENT before the reload. Without this the whole
      // scenario could pass by typing nothing and finding nothing.
      expect(
        (await editorText(session)).replace(/[^a-z0-9]/gi, ""),
        "the sentence must be in the document before the reload, or the reload proves nothing",
      ).toContain(SENTENCE.replace(/[^a-z0-9]/gi, ""));

      // Reload WITHOUT waiting for any save indicator: what is under test is
      // the unflushed case, and waiting for a save would turn this into a
      // scenario about a document that was already on disk.
      await session.navigate(`${server.origin}/`);

      const field = await session.waitForElement('input[type="password"]', {
        timeoutMs: UNLOCK_TIMEOUT_MS,
      });
      await field.sendKeys(vault.password);
      await (await session.findElement(testIdSelector("unlock.submit"))).click();
      await session.waitForElement(testIdSelector("editor.bottom-bar"), {
        timeoutMs: UNLOCK_TIMEOUT_MS,
      });

      // **Did the NOTE survive, and separately, is it on screen?** These are two
      // questions and the first version asked only the second: a reload lands
      // on the vault shell, and `unlock-from-fixture.e2e.ts` records that with
      // no note to route to no CodeMirror mounts at all. Reading "no editor" as
      // "the edit was lost" would report a routing fact as a data-loss one.
      const rows = await session.execute<number>(
        "return document.querySelectorAll('[data-testid=\"notes.row\"]').length;",
      );
      expect(rows, "the note itself must survive the reload before its text can").toBeGreaterThan(0);
      // Open it the way a user would, since the reload does not route into it.
      await session.execute(
        "document.querySelector('[data-testid=\"notes.row\"]').click();",
      );

      // The editor ELEMENT first, then the text read ONCE. Polling for
      // non-empty text conflates "no editor mounted" with "the document came
      // back empty", and those are different answers: the second is the
      // data-loss one this scenario exists to catch, and a poll would report it
      // as a timeout with no value in the message.
      await session.waitForElement(testIdSelector("editor.content") + " .cm-content", {
        timeoutMs: UNLOCK_TIMEOUT_MS,
      });
      const after = (await editorText(session)).replace(/[^a-z0-9]/gi, "");
      expect(
        after,
        "the edit was typed and the page reloaded before any save completed. `pagehide` is " +
          "the flush point (web/src/platform/exit-signals.ts) and a reload fires it, so the " +
          `sentence has to come back. The reloaded document held: ${JSON.stringify(after.slice(0, 120))}`,
      ).toContain(SENTENCE.replace(/[^a-z0-9]/gi, ""));
    } finally {
      await browser?.teardown().catch(() => {});
      await server.close();
    }
  });
});
