// Shared multi-step flows for the web E2E lane (MYND-574 task 105).
//
// The desktop lane's `e2e/support/flows.ts` exists because scenarios that
// re-roll "unlock and get to the editor" drift apart, and then a change to the
// unlock screen breaks eleven files in eleven different ways. Same reasoning
// here, over a different entry sequence: a browser's first run is account number
// → password → a vault that does not exist locally yet, which desktop never
// does.
//
// **`byTestId` only.** `e2e/CLAUDE.md`'s non-negotiable, and it applies to this
// lane verbatim: no CSS-class selectors, no text matching. Text selectors break
// on translation and quietly re-pass when the wrong element happens to contain
// the right substring.
//
// **No credential ever reaches a failure message.** Every assertion here is
// shaped so its failure diff carries a testid or a boolean, never a password, an
// account number or a phrase — the same SYNC-13 rule the desktop lane follows,
// and the reason `waitForTestId` reports the ID it was waiting for rather than
// dumping the page.

import type { Session } from "./session";

/** Long enough for a first paint plus the wasm module's instantiation, which is
 *  the slowest thing between navigation and the first testid on this client. */
const BOOT_TIMEOUT_MS = 30_000;
/** Argon2id at production parameters, in a browser, on a CI runner. */
const UNLOCK_TIMEOUT_MS = 60_000;

/** Navigate to the app origin and wait for the boot probe to render something.
 *
 *  The BETA-TERMS gate is part of "something". `AccountBootstrap` renders it
 *  ahead of the account-entry step whenever consent is missing (myne-ops#15),
 *  and a fresh browser profile has no consent — so on the web client it is the
 *  FIRST screen, every time. This helper used to wait only for the three
 *  admitted surfaces, none of which exists behind the gate, and every scenario
 *  in the lane died in `openApp` with a boot timeout: 12 of 20 tests, all with
 *  the same message, which reads like the bundle failing to start rather than
 *  like one screen that was added in front of it.
 *
 *  The desktop lane was given a consent seed (`multi-device.ts`'s
 *  `legalConsentSeed`) in the same change; the web lane has no config dir to
 *  seed, so it accepts the terms the way a user does — through the button. */
export async function openApp(session: Session, origin: string): Promise<void> {
  await session.navigate(origin);
  // Include the gate in the probe so a hang still reports WHICH surface never
  // appeared rather than timing out on three that cannot appear.
  const seen = await waitForAnyTestId(
    session,
    ["bootstrap.beta-terms", "account-entry.input", "unlock.password-input", "editor.root"],
    BOOT_TIMEOUT_MS,
  );
  if (seen === "bootstrap.beta-terms") {
    // OPEN the dialog first. The gate itself renders only a heading, an intro
    // and a "review the terms" button; the accept button lives inside
    // `BetaTermsConsent`, which `AccountBootstrap` mounts with `open={termsOpen}`
    // and `ModalShell` renders as NOTHING while that is false. Waiting for
    // `sync.beta-terms.accept` straight off the gate therefore waits for an
    // element that cannot exist until this click, which is how the lane spent 12
    // of 20 tests timing out inside `openApp` on a message that reads like a
    // dead bundle. The user's own path is review-then-accept; so is this.
    const review = await session.byTestId("bootstrap.beta-terms.open", {
      timeoutMs: BOOT_TIMEOUT_MS,
    });
    await review.click();
    // SCROLL first. The terms carry a long full-text block, and in the browser
    // lane's viewport the accept button sits below it — `/click`'s own
    // scroll-into-view only guarantees the border box intersects the VIEWPORT,
    // which is not the same as revealing an element clipped inside an
    // overflowing container (`support/webdriver.ts` says so at the helper this
    // uses). Without it the click reports "element interactable" forever, which
    // reads like a disabled button and is really one that is off-screen.
    const accept = await session.byTestId("sync.beta-terms.accept", {
      timeoutMs: BOOT_TIMEOUT_MS,
    });
    await accept.scrollIntoView();
    await accept.click();
    await waitForAnyTestId(
      session,
      ["account-entry.input", "unlock.password-input", "editor.root"],
      BOOT_TIMEOUT_MS,
    );
  }
}

/** The first-run identity step: type an account number and continue. */
export async function enterAccountNumber(session: Session, accountNumber: string): Promise<void> {
  const input = await session.byTestId("account-entry.input", { timeoutMs: BOOT_TIMEOUT_MS });
  await input.sendKeys(accountNumber);
  await (await session.byTestId("account-entry.submit")).click();
  // The password step of the bootstrap, NOT the unlock screen: on a first run
  // there is no local vault to unlock yet.
  await session.byTestId("account-bootstrap.password", { timeoutMs: BOOT_TIMEOUT_MS });
}

/**
 * The whole first run: account number, password, and whatever the join returns.
 *
 * Returns which door it landed on rather than asserting one, because BOTH are
 * correct outcomes and which one you get depends on the account's device roster
 * — a browser enrolling on the password path lands `pending` until an existing
 * device approves it (`server-protocol.md` §3.1), and task 92 leaves a browser no
 * other path. A helper that assumed "approved" would fail on the ordinary case.
 */
export async function bootstrapAccount(
  session: Session,
  accountNumber: string,
  password: string,
): Promise<"approved" | "pending"> {
  await enterAccountNumber(session, accountNumber);
  await (await session.byTestId("account-bootstrap.password")).sendKeys(password);
  await (await session.byTestId("account-bootstrap.submit")).click();
  const landed = await waitForAnyTestId(
    session,
    ["account-bootstrap.pending-notice", "unlock.password-input", "editor.root"],
    UNLOCK_TIMEOUT_MS,
  );
  return landed === "account-bootstrap.pending-notice" ? "pending" : "approved";
}

/** Type the master password on the unlock screen and wait for the editor. */
export async function unlockToEditor(session: Session, password: string): Promise<void> {
  await (
    await session.byTestId("unlock.password-input", { timeoutMs: BOOT_TIMEOUT_MS })
  ).sendKeys(password);
  await (await session.byTestId("unlock.submit")).click();
  await session.byTestId("editor.root", { timeoutMs: UNLOCK_TIMEOUT_MS });
}

/**
 * Wait until every note the sidebar shows has reached the server.
 *
 * Read from the DOM, through the task-23 marker, and with **one extra
 * condition that is the whole point**: the sidebar must be mounted and showing
 * at least one row. "No unsynced markers" is trivially true of an unmounted
 * sidebar, and a first-sync assertion that passes before the list renders would
 * pass on every run including the broken ones.
 *
 * Deliberately NOT a page-side call into the client: `e2e/CLAUDE.md`'s
 * zero-test-hooks rule applies to this lane verbatim, and an
 * `window.__MYNE_WEB_E2E__` bridge would be exactly the production hook it
 * forbids.
 */
export async function waitForFirstSync(session: Session, timeoutMs = 120_000): Promise<void> {
  await session.waitUntil(
    async () => {
      const rows = await session.byTestIdAll("notes.row");
      if (rows.length === 0) return null; // the list has not rendered yet
      const unsynced = await session.byTestIdAll("notes.row-unsynced");
      return unsynced.length === 0 ? true : null;
    },
    { label: "every visible note has reached the server", timeoutMs },
  );
}

/**
 * Wait for whichever of `testIds` appears first, and return it.
 *
 * The value is in the FAILURE: a scenario that waits for one testid and gets a
 * different screen fails with "timed out waiting for X", which says nothing
 * about what actually rendered. This one names the set it was watching, so the
 * message points at the fork rather than at one arm of it.
 */
export async function waitForAnyTestId(
  session: Session,
  testIds: readonly string[],
  timeoutMs: number,
): Promise<string> {
  return session.waitUntil(
    async () => {
      for (const id of testIds) {
        if ((await session.byTestIdAll(id)).length > 0) return id;
      }
      return null;
    },
    { label: `one of [${testIds.join(", ")}]`, timeoutMs },
  );
}
