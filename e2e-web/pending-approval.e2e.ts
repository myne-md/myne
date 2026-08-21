// A device that reads as awaiting approval still gets the password form
// (myne-md/myne#535, correcting MYND-635).
//
// # What MYND-635 fixed, and what it broke
//
// Reported live on `app.example.com`: signing in enrols the browser on the password
// path, which lands **pending** until an already-approved device approves it.
// That is the only path a browser has, since the self-approving recovery path is
// deliberately absent from this bundle. The wait screen appeared correctly.
// Refreshing then asked for the password and opened an **empty vault**, with the
// wait unreachable and nothing saying why.
//
// Nothing about the store looked wrong, which is what made it hard to see:
// `sync_join_account` fetches the account's real `vault.meta` and writes it
// **before** running the enrolment that comes back pending. So the boot probe,
// which routes on `vault.meta` existence, saw an ordinary vault, and the
// password genuinely opened it. It was empty because a pending device holds no
// token and can pull nothing.
//
// MYND-635 therefore routed that disk state to the wait screen. **That state is
// not evidence of anything on this client.** `design-notes/clients/0363` makes
// the web sync token session-scoped: it lives in the Worker and is written
// nowhere, so it dies with the tab, while `device_id` persists. An APPROVED
// browser therefore presents identity-present + token-absent on every reload,
// byte-identical to a device nobody has approved. What shipped was a deadlock:
// the wait screen asks for no password, the only exit from pending is a token
// claim, the claim runs inside a sync cycle, and the cycle refuses on a locked
// vault before it reaches the claim. 0363 had already written down the behaviour
// that was owed: "Every new tab re-authenticates: the user's password is needed
// again … and it is NOT accompanied by a re-approval prompt."
//
// So boot's answer is the password form, and the awaiting-approval verdict is
// taken AFTER unlock, from two DEVICE-LOCAL reads: has this device ever adopted
// a head (`sync_head_fingerprint`, the discriminator `sync-protocol.md` §6.2
// names), and is it enrolled at all (`sync_status`). It asks the network
// nothing, because `try_claim_token` collapses a transport failure, an unreached
// server and a genuine refusal into one value
// (`src/lib/pending-approval.ts` → `editor.awaiting-approval`).
//
// # Why this belongs in the WEB lane
//
// `e2e-web/CLAUDE.md`'s rule is web-specific behaviour only: a flow in the
// shared `src/` tree owes one desktop scenario and nothing here. This qualifies
// on the entry path. **Sync-required entry is web-only**: a browser starting
// from an empty origin has no vault to create and must be told which account to
// pull, and the refresh that loses in-page state is a browser event the desktop
// client does not have. The stage routing itself is unit-tested
// (`tests/stage/web-boot-routing.test.ts`); what only a browser can prove is
// that a real reload of a real bundle lands where the routing says.
//
// # What this lane can and cannot prove
//
// Both halves, and the second one only because the verdict asks the network
// nothing. An earlier revision of this branch gated it on a completed cycle,
// which made the post-unlock half unprovable here: a cycle against an
// unreachable origin fails at transport, and this lane has no sync server. Two
// local reads have no such dependency, so the wait is reachable in a real
// browser against a real bundle with nothing listening.
//
//   1. **Boot.** A seeded pending container reaches a usable password form
//      rather than a screen with no way forward.
//   2. **After unlock.** The same container lands on the WAIT, while a container
//      with no enrolment lands in the vault. That pair is the discriminator: it
//      is the only thing here that a router ignoring the verdict entirely would
//      fail, since after #535 both containers boot identically by design.
//
// What it still cannot prove is the exit: a wait that ENDS when an approval
// lands needs a server to send one. That half is covered by
// `tests/lib/pendingApprovalVerdict.test.ts`,
// `tests/stage/pending-approval-idle-lock.test.tsx` and
// `tests/screens/account-bootstrap.test.tsx`, and by the manual sign-in walk in
// the issue.
//
// # Why the state is seeded rather than enrolled
//
// Same reason: no sync server in this lane, so a real join cannot run. The
// pending state is instead written to OPFS as the bytes the client will read:
// identity persisted, endpoint configured, no token. All of it comes from the
// real container writer via `emit-vault-fixture`, because `sync-state.json` and
// `sync-config.json` are both double-buffered and hand-written JSON would be
// unreadable in a way that looks exactly like a device which never enrolled.

import { expect, it } from "vitest";
import { describeE2E } from "./support/scenario";
import { startBundleServer } from "./support/server";
import { newBrowserSession } from "./support/session";
import { DRIVER_PORT } from "./support/worker-ports";
import type { SupportedBrowser } from "./support/harness";
import { loadVaultFixture, seedPendingVault, seedVault } from "./support/opfs-seed";
import { waitForAnyTestId } from "./support/flows";

const BUNDLE_DIR = process.env.MYNE_WEB_E2E_BUNDLE_DIR ?? "web/dist";
const BROWSER = (process.env.MYNE_WEB_E2E_BROWSER ?? "chrome") as SupportedBrowser;
const SYNC_ORIGIN = "https://sync.example.test";

/** Argon2id at the v0.1 baseline is ~0.5 s in a browser; generous rather than
 *  tight, so a slower machine is not a flake. */
const BOOT_TIMEOUT_MS = 30_000;

/** Argon2id runs again on the unlock itself, so the post-password wait gets its
 *  own budget rather than borrowing the boot one. */
const UNLOCK_TIMEOUT_MS = 30_000;

/** Which screens a real boot of a real bundle put on the page. */
interface BootLanding {
  passwordForm: boolean;
  pendingNotice: boolean;
  accountEntry: boolean;
}

/**
 * Seed a container, load `/`, and report what boot rendered.
 *
 * Shared because the two cases differ in exactly one thing (which seeder ran)
 * and that difference IS the claim. A copied body would let the two drift on
 * something else and still look like a pair.
 *
 * The load of `/` is the refresh, and it is indistinguishable to the client from
 * the reload that produced the report: the worker restarts, the runtime slot is
 * empty, and boot re-reads the store from scratch.
 */
async function bootAndLand(
  seed: (session: Parameters<typeof seedVault>[0], vault: ReturnType<typeof loadVaultFixture>) => Promise<void>,
): Promise<BootLanding> {
  const vault = loadVaultFixture();
  const server = await startBundleServer({ root: BUNDLE_DIR, syncOrigin: SYNC_ORIGIN });
  let browser: Awaited<ReturnType<typeof newBrowserSession>> | undefined;
  try {
    browser = await newBrowserSession({
      baseUrl: `http://127.0.0.1:${DRIVER_PORT}`,
      browser: BROWSER,
    });
    const { session } = browser;

    // Seed on the blank page: on `/` the app has already probed the store.
    await session.navigate(`${server.origin}/__seed`);
    await seed(session, vault);
    await session.navigate(`${server.origin}/`);

    await session.waitForElement('[data-testid="unlock.password-input"]', {
      timeoutMs: BOOT_TIMEOUT_MS,
    });
    const present = (testId: string) =>
      session.execute<boolean>(
        `return !!document.querySelector('[data-testid="${testId}"]');`,
      );
    return {
      passwordForm: await present("unlock.password-input"),
      pendingNotice: await present("account-bootstrap.pending-notice"),
      accountEntry: await present("account-entry.input"),
    };
  } finally {
    await browser?.teardown().catch(() => {});
    await server.close();
  }
}

/** Where a real unlock of a real bundle put the user. */
type UnlockLanding = "wait" | "vault";

/**
 * Seed, boot, type the fixture password, and report which screen answered.
 *
 * Waits POSITIVELY for one of the two, never for the password field to go away:
 * a crash looks exactly like that too, and this lane has already seen it, when
 * an unported command turned a perfectly good unlock into the fail-closed
 * screen, which has no password field either.
 *
 * `editor.bottom-bar` rather than `.cm-content` is the vault marker, for the
 * reason `unlock-from-fixture.e2e.ts` records: the fixture holds no notes, so
 * nothing mounts CodeMirror and waiting on the editor surface would fail against
 * a perfectly unlocked vault.
 */
async function unlockAndLand(
  seed: (session: Parameters<typeof seedVault>[0], vault: ReturnType<typeof loadVaultFixture>) => Promise<void>,
): Promise<UnlockLanding> {
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
    await seed(session, vault);
    await session.navigate(`${server.origin}/`);

    const field = await session.waitForElement('[data-testid="unlock.password-input"]', {
      timeoutMs: BOOT_TIMEOUT_MS,
    });
    await field.sendKeys(vault.password);
    await (await session.findElement('[data-testid="unlock.submit"]')).click();

    // Through the shared fork-waiter rather than a hand-rolled poll, because its
    // timeout message names the whole SET it was watching. A bare wait on one of
    // the two reports "the wait never appeared" when what happened is that the
    // vault opened, which points a reader at the wrong arm.
    const landed = await waitForAnyTestId(
      session,
      ["account-bootstrap.pending-notice", "editor.bottom-bar"],
      UNLOCK_TIMEOUT_MS,
    );
    return landed === "account-bootstrap.pending-notice" ? "wait" : "vault";
  } finally {
    await browser?.teardown().catch(() => {});
    await server.close();
  }
}

describeE2E("a device that reads as pending is still offered its password", () => {
  it("boots to the password form, not to a screen with no way forward", async () => {
    const landed = await bootAndLand(seedPendingVault);
    expect(landed.passwordForm).toBe(true);
    // The other half of the claim, and the one the deadlock violated: the wait
    // must NOT be what boot shows. Asserting only that the form is present would
    // pass on a screen rendering both.
    expect(
      landed.pendingNotice,
      "boot cannot know whether this device is approved, so it must not claim it is waiting",
    ).toBe(false);
    // Nor the account-number step. That would be the other wrong answer,
    // sending someone back to the start of a flow they finished, where enrolling
    // again mints a fresh device_id and strands a second pending record on the
    // account.
    expect(
      landed.accountEntry,
      "a device that already enrolled must not be sent back to account entry",
    ).toBe(false);
  });

  it("the same vault WITHOUT the pending state boots the same way", async () => {
    // The pair, and it means something different now than it did before #535.
    // It used to prove the wait was not shown for every vault; it now proves the
    // two disk states are treated IDENTICALLY at boot, which is the whole
    // claim, because on this client they are not distinguishable.
    //
    // On its own that pair no longer DISCRIMINATES: a router that ignored the
    // enrolment state entirely would pass both cases, which is exactly what it
    // is now supposed to do. The discriminator moved past the password, to the
    // two cases below.
    const landed = await bootAndLand(seedVault);
    expect(landed.passwordForm).toBe(true);
    expect(
      landed.pendingNotice,
      "a vault with no enrolment on disk is not awaiting approval either",
    ).toBe(false);
  });
});

describeE2E("the wait is where an unapproved device lands AFTER its password", () => {
  it("an enrolled container that has adopted no head reaches the wait", async () => {
    // The half the branch's first revision could not test here. The verdict
    // reads `sync_head_fingerprint` (this fixture's `sync-state.json` carries an
    // empty `vv_log`, so: no adopted head) and then `sync_status` (enrolled,
    // because the identity and the endpoint are both seeded). Neither read
    // leaves the machine, so an origin with nothing listening changes no answer.
    const landed = await unlockAndLand(seedPendingVault);
    expect(
      landed,
      "an enrolled device that has never synced owes the §6.3 compare, and this " +
        "screen is where it runs",
    ).toBe("wait");
  });

  it("a container with no enrolment goes straight into the vault", async () => {
    // The pair that gives the case above its meaning. Same bundle, same
    // password, same unlock, one file different on disk. Without it, a verdict
    // hard-wired to `true` would satisfy the case above and lock every web user
    // out of their notes behind a wait nobody can end.
    const landed = await unlockAndLand(seedVault);
    expect(
      landed,
      "un-enrolled is not waiting for anything, and routing it to the wait would " +
        "re-ask a question the user answered by never enrolling",
    ).toBe("vault");
  });
});
