// JR — joining a device with the recovery phrase (myne-md/myne#468, tasks 7+8).
//
// The user these exist for has lost every other device. A password join waits
// for an existing device to approve it, and there is none, so until this change
// the waiting screen was a dead end with a Cancel button. Two doors now:
//
//   JR-1  the waiting screen's escape: joined with the password, pending, then
//         "use my recovery phrase" — self-approved, straight into the editor,
//         no password reset (the user just typed the password).
//   JR-2  the join form's second path: the phrase INSTEAD of the password —
//         self-approved, then the recovery flow's mandatory password reset,
//         because a user who needed the phrase may not know the password.
//
// Device A only exists to put the account on the server. It never approves
// anything, which is the whole point: B must get in with nobody's help.

import { describe, expect, it } from "vitest";
import { harnessSupported } from "./support/session";
import type { Session } from "./support/webdriver";
import { startSyncServer, syncServerSupported } from "./support/sync-server";
import { launchDevice, syncConfigSeed } from "./support/multi-device";
import { seedVault } from "./support/fixtures";
import {
  clickByTestId,
  closeSettings,
  completePasswordReset,
  dismissImporterOffer,
  openSyncDevices,
  unlockToEditor,
} from "./support/flows";

const driver = harnessSupported();
const server = syncServerSupported();
const ready = driver.ok && server.ok;
if (!ready) {
  console.warn(
    `[e2e] sync-join-recovery skipped: ${!driver.ok ? driver.reason : server.reason}`,
  );
}
const describeJr = ready ? describe : describe.skip;

const NEW_PASSWORD = "Wv4#tQ9!kP2&nR7m-jr2";

/** Type the phrase into the join's 24-cell grid, one word per cell. */
async function typePhrase(session: Session, phrase: string): Promise<void> {
  const cells = await session.byTestIdAll("join.phrase-cell");
  const words = phrase.split(" ");
  expect(cells.length).toBe(24);
  for (let i = 0; i < 24; i++) await cells[i].sendKeys(words[i]);
}

/** Device A: seed a vault, unlock it, enrol it, so the account exists server-side. */
async function accountOnServer(url: string) {
  let account = "";
  let password = "";
  let phrase = "";
  const a = await launchDevice(0, {
    seedConfig: syncConfigSeed(url),
    seed: (appDataDir) => {
      const v = seedVault(appDataDir, { password: "JoinRecovery-7-otters!" });
      account = v.account;
      password = v.password;
      phrase = v.phrase;
    },
  });
  await unlockToEditor(a.session, password);
  await dismissImporterOffer(a.session);
  await openSyncDevices(a.session);
  await (await a.session.byTestId("sync.enroll.account-input")).sendKeys(account);
  await (await a.session.byTestId("sync.enroll.password-input")).sendKeys(password);
  await (await a.session.byTestId("sync.enroll.submit")).click();
  await a.session.byTestId("sync.enroll.approved", { timeoutMs: 30_000 });
  await closeSettings(a.session);
  return { a, account, password, phrase };
}

describeJr("JR sync join with the recovery phrase", () => {
  it("JR-1 the waiting screen's escape gets a device in with nobody to approve it", async () => {
    const srv = await startSyncServer();
    const { a, account, password, phrase } = await accountOnServer(srv.url);
    try {
      const b = await launchDevice(1, { seedConfig: syncConfigSeed(srv.url) });
      try {
        await (await b.session.byTestId("welcome.join-cta", { timeoutMs: 30_000 })).click();
        await b.session.byTestId("join.modal", { timeoutMs: 30_000 });
        await (await b.session.byTestId("join.server-input")).sendKeys(srv.url);
        await (await b.session.byTestId("join.account-input")).sendKeys(account);
        await (await b.session.byTestId("join.password-input")).sendKeys(password);
        await (await b.session.byTestId("join.submit")).click();

        // Waiting — and A will never approve.
        await b.session.byTestId("join.pending", { timeoutMs: 30_000 });
        await (await b.session.byTestId("join.use-phrase")).click();
        await b.session.byTestId("join.pending-phrase", { timeoutMs: 10_000 });
        await typePhrase(b.session, phrase);
        await (await b.session.byTestId("join.phrase-submit")).click();

        // Self-approved: the editor, with no password reset on the way.
        await b.session.byTestId("editor.root", { timeoutMs: 60_000 });
        expect(
          await b.session.byTestIdAll("recover.reset.password-input"),
          "the escape demanded a password reset from a user who had just typed it",
        ).toHaveLength(0);
        // Nothing of the phrase is left in the live DOM.
        expect((await b.session.source()).includes(phrase)).toBe(false);
      } finally {
        await b.teardown();
      }
    } finally {
      await a.teardown();
      await srv.teardown();
    }
  }, 300_000);

  it("JR-2 joining with the phrase instead of the password lands in the password reset", async () => {
    const srv = await startSyncServer();
    const { a, account, phrase } = await accountOnServer(srv.url);
    try {
      const b = await launchDevice(1, { seedConfig: syncConfigSeed(srv.url) });
      try {
        await (await b.session.byTestId("welcome.join-cta", { timeoutMs: 30_000 })).click();
        await b.session.byTestId("join.modal", { timeoutMs: 30_000 });
        await (await b.session.byTestId("join.server-input")).sendKeys(srv.url);
        await (await b.session.byTestId("join.account-input")).sendKeys(account);

        await (await b.session.byTestId("join.mode-recovery")).click();
        // The warning is on screen before the grid is filled.
        await b.session.byTestId("join.phrase-warning");
        await typePhrase(b.session, phrase);
        // `clickByTestId`, not a raw click: the join card grew a device-name
        // field and a 24-cell grid, so its submit sits below the fold of the
        // modal's own scrolling body, and WebDriver's scroll-into-view does not
        // reliably reach a nested `overflow: auto` in WebKit. Measured
        // 2026-10-24: `element not interactable` for the full 10 s budget on a
        // button that was enabled and on screen one scroll away.
        await clickByTestId(b.session, "join.submit");

        // No waiting screen at all: self-approved, then the chained reset.
        await b.session.byTestId("recover.reset.password-input", { timeoutMs: 60_000 });
        expect(await b.session.byTestIdAll("join.pending")).toHaveLength(0);
        await completePasswordReset(b.session, NEW_PASSWORD);
        await b.session.byTestId("editor.root", { timeoutMs: 60_000 });
        expect((await b.session.source()).includes(phrase)).toBe(false);
      } finally {
        await b.teardown();
      }
    } finally {
      await a.teardown();
      await srv.teardown();
    }
  }, 300_000);
});
