// Creating an account in a browser, and the ordering that makes it safe
// (myne-md/myne#174; `decisions.md` 2026-08-15).
//
// # Why this lane and not the desktop one
//
// Both clients compile the same creation flow, so by this lane's own rule that
// would owe a scenario to `e2e/` and nothing here. What is web-SPECIFIC is the
// part that has no desktop counterpart at all: where sync is required, creation
// registers the account with the server BETWEEN the local write and the phrase
// display, and a failure erases the container and reports that nothing was
// created. Desktop has no server leg in creation and never enters that step.
//
// # The assertion that matters, and why it gets its own test
//
// `recovery-flow.md` §2.4 is a no-re-display commitment: the phrase is shown
// exactly once, ever. Show it before registration succeeds and a failure leaves
// the user holding 24 words for an account that does not exist — and a retry
// mints a DIFFERENT phrase, so the words they wrote down are silently wrong for
// the vault they end up with. That is permanent data loss with no error message
// attached to it, which is precisely the class of bug a happy-path scenario
// walks straight past. So the ordering is asserted on its own, over STATE (what
// the DOM holds, and what storage holds afterwards) rather than over a return
// value.
//
// Vault-count precondition: **0** — a clean profile, first run.

import { expect, it } from "vitest";
import { describeE2E } from "./support/scenario";
import { startBundleServer } from "./support/server";
import { newBrowserSession } from "./support/session";
import { openApp, waitForAnyTestId, createFirstRunIdentity } from "./support/flows";
import { DRIVER_PORT } from "./support/worker-ports";
import type { SupportedBrowser } from "./support/harness";
import type { Session } from "./support/session";

const BUNDLE_DIR = process.env.MYNE_WEB_E2E_BUNDLE_DIR ?? "web/dist";
const BROWSER = (process.env.MYNE_WEB_E2E_BROWSER ?? "chrome") as SupportedBrowser;

/** A sync origin that resolves to nothing, so registration cannot succeed. */
const DEAD_SYNC_ORIGIN = "https://sync.unreachable.test";

const PASSWORD = "correct horse battery staple 7!";


/**
 * Tick the three acknowledgements and continue past the first-run briefing.
 *
 * The wait between the two is load-bearing rather than defensive. "Continue" is
 * `disabled` until all three are acked, a disabled button answers WebDriver with
 * `element not interactable`, and `Element.click()` polls that for ten seconds
 * before failing — so a scenario that clicks straight after the last checkbox
 * races React's re-render and fails with a timeout that reads like a hang rather
 * than like "the button was disabled". Waiting on the button's own state instead
 * makes the dependency explicit.
 */
async function passBriefing(session: Session): Promise<void> {
  const acks = await session.byTestIdAll("create.briefing-ack");
  expect(acks.length, "the briefing must present its acknowledgements").toBeGreaterThan(0);
  for (const ack of acks) {
    await ack.scrollIntoView();
    await ack.click();
  }
  await session.waitUntil(
    async () =>
      (await session.execute<boolean>(
        `return document.querySelector('[data-testid="create.briefing-continue"]')?.disabled === false;`,
      ))
        ? true
        : null,
    { label: "briefing continue enabled", timeoutMs: 10_000 },
  );
  const cont = await session.byTestId("create.briefing-continue");
  // The briefing is taller than the headless viewport, and the scroll container
  // is an inner element rather than the document, which chromedriver's own
  // auto-scroll does not reach: the button reports `element not interactable`
  // with `elementFromPoint` returning null at its centre. Measured, not guessed
  // — the button sat at y=467 in a 413px viewport.
  await cont.scrollIntoView();
  await cont.click();
}

/**
 * Reach the password step from the create-account entry, whichever screens sit
 * in front of it.
 *
 * Two of them do since myne-md/myne#468: the first-run briefing, which appears
 * only on a first run, and the vault-name step, which always does. Branching on
 * which one is showing rather than assuming an order is what this whole suite
 * does at every entry, because the browser client's route into creation depends
 * on what the container already holds.
 *
 * A THIRD one stands in front of them since myne-md/myne#768: the first-run
 * identity ceremony. The create door now lands on `/first-run`, not on vault
 * creation, because an identity covers every vault a person makes. This
 * scenario used to wait straight for `create.briefing`/`create.name-input` and
 * timed out at 30 s on a screen that had simply moved one step earlier, which
 * reads as the creation flow being broken rather than as one ceremony being
 * inserted; the ceremony itself is covered separately by
 * `identity-first-entry.e2e.ts`.
 *
 * The ceremony is completed rather than skipped (`first-run.identity.cancel`
 * exists) because abandoning it re-probes to the identity home and never
 * reaches vault creation. It is network-free, so it completes against this
 * file's unreachable origin.
 */
async function reachPasswordStep(session: Session): Promise<void> {
  const first = await waitForAnyTestId(
    session,
    ["first-run.root", "create.briefing", "create.name-input"],
    30_000,
  );
  if (first === "first-run.root") {
    await createFirstRunIdentity(session);
  }
  const stage =
    first === "first-run.root"
      ? await waitForAnyTestId(session, ["create.briefing", "create.name-input"], 30_000)
      : first;
  if (stage === "create.briefing") {
    await passBriefing(session);
  }
  // The name step. A name is typed rather than skipped: it heads the recovery
  // kit and the file the kit saves, so an empty one exercises the branch where
  // nothing is written.
  const name = await session.byTestId("create.name-input", { timeoutMs: 30_000 });
  await name.scrollIntoView();
  await name.sendKeys("Web Kasa");
  const nameNext = await session.byTestId("create.name-continue");
  await nameNext.scrollIntoView();
  await nameNext.click();
  await session.byTestId("create.password-input", { timeoutMs: 30_000 });
}

describeE2E("web account creation", () => {
  it("offers a create door on the entry screen, which the old rule forbade", async () => {
    // The affordance itself is the reversal made visible. Until 2026-08-15 a
    // browser with no account could only be told to go install something.
    const server = await startBundleServer({
      root: BUNDLE_DIR,
      syncOrigin: DEAD_SYNC_ORIGIN,
    });
    try {
      const browser = await newBrowserSession({
        baseUrl: `http://127.0.0.1:${DRIVER_PORT}`,
        browser: BROWSER,
      });
      try {
        await openApp(browser.session, server.origin);
        await browser.session.byTestId("account-entry.input", { timeoutMs: 30_000 });
        const door = await browser.session.byTestIdAll("account-entry.create-account");
        expect(door.length, "the entry screen must offer account creation").toBe(1);
      } finally {
        await browser.teardown();
      }
    } finally {
      await server.close();
    }
  });

  it("never shows the phrase before the account exists on the server", async () => {
    // The registration leg is pointed at an origin that does not resolve, so it
    // MUST fail. The property under test is what the user sees while it fails.
    const server = await startBundleServer({
      root: BUNDLE_DIR,
      syncOrigin: DEAD_SYNC_ORIGIN,
    });
    try {
      const browser = await newBrowserSession({
        baseUrl: `http://127.0.0.1:${DRIVER_PORT}`,
        browser: BROWSER,
      });
      try {
        await openApp(browser.session, server.origin);
        await browser.session.byTestId("account-entry.input", { timeoutMs: 30_000 });
        await (await browser.session.byTestId("account-entry.create-account")).click();

        // Briefing (first-run only, and owed to a browser user exactly as much
        // as to a desktop one), then the vault name, then the password.
        await reachPasswordStep(browser.session);
        await (
          await browser.session.byTestId("create.password-input", { timeoutMs: 30_000 })
        ).sendKeys(PASSWORD);
        await (await browser.session.byTestId("create.confirm-input")).sendKeys(PASSWORD);
        await (await browser.session.byTestId("create.submit")).click();

        // Argon2id, then the provisioning step. The phrase grid must NOT be
        // reachable at any point along the way.
        const landed = await waitForAnyTestId(
          browser.session,
          ["create.provisioning", "create.phrase-grid", "create.session-lost-start-over"],
          180_000,
        );
        expect(
          landed,
          "creation must go through provisioning before the phrase, never straight to the grid",
        ).not.toBe("create.phrase-grid");

        // The failure is terminal and says so. `create.phrase-grid` must never
        // have rendered: a phrase shown for an account that does not exist is
        // the data-loss trap this ordering exists to prevent.
        const outcome = await waitForAnyTestId(
          browser.session,
          ["create.session-lost-start-over", "create.phrase-grid"],
          180_000,
        );
        expect(
          outcome,
          "a failed registration must report that nothing was created, not show a phrase",
        ).toBe("create.session-lost-start-over");

        const grids = await browser.session.byTestIdAll("create.phrase-grid");
        expect(grids.length, "no phrase grid may exist after a failed registration").toBe(0);
      } finally {
        await browser.teardown();
      }
    } finally {
      await server.close();
    }
  });

  it("leaves no vault container behind when registration fails", async () => {
    // The state half of the previous test, asserted against STORAGE rather than
    // against the screen. A flow that reported the failure correctly and left a
    // half-made container behind would pass the assertions above and still be
    // wrong: on this client a vault with no account behind it is a thing the
    // rules say cannot exist (`decisions.md` 2026-07-26, sync required).
    const server = await startBundleServer({
      root: BUNDLE_DIR,
      syncOrigin: DEAD_SYNC_ORIGIN,
    });
    try {
      const browser = await newBrowserSession({
        baseUrl: `http://127.0.0.1:${DRIVER_PORT}`,
        browser: BROWSER,
      });
      try {
        await openApp(browser.session, server.origin);
        await browser.session.byTestId("account-entry.input", { timeoutMs: 30_000 });
        await (await browser.session.byTestId("account-entry.create-account")).click();
        await reachPasswordStep(browser.session);
        await (
          await browser.session.byTestId("create.password-input", { timeoutMs: 30_000 })
        ).sendKeys(PASSWORD);
        await (await browser.session.byTestId("create.confirm-input")).sendKeys(PASSWORD);
        await (await browser.session.byTestId("create.submit")).click();
        await waitForAnyTestId(browser.session, ["create.session-lost-start-over"], 180_000);

        // Walk OPFS directly. `vault.meta` is the file whose presence means "a
        // vault lives here", and it is what the boot probe reads.
        const leftovers = await browser.session.executeAsync<string[]>(
          `
          const done = arguments[arguments.length - 1];
          (async () => {
            try {
              const root = await navigator.storage.getDirectory();
              const found = [];
              const walk = async (dir, path, depth) => {
                if (depth > 4) return;
                for await (const [name, handle] of dir.entries()) {
                  if (name === "vault.meta") { found.push(path + "/" + name); continue; }
                  if (handle.kind === "directory") await walk(handle, path + "/" + name, depth + 1);
                }
              };
              await walk(root, "", 0);
              done(found);
            } catch {
              done([]);
            }
          })();
          `,
        );
        expect(
          leftovers,
          "a failed registration must erase the container it wrote, not leave an orphan vault",
        ).toEqual([]);
      } finally {
        await browser.teardown();
      }
    } finally {
      await server.close();
    }
  });
});
