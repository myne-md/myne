// At-rest residue across the browser's storage buckets (MYND-574 task 107).
//
// The desktop scenario (`e2e/plaintext-residue.e2e.ts`, MYND-228) proves nothing
// readable survives under the session's data directory. The web client moves
// that surface into the BROWSER PROFILE and adds buckets desktop does not have:
// OPFS, IndexedDB, localStorage, sessionStorage, Cache Storage and the HTTP
// cache. Nothing else in the 74 asserts the property there.
//
// # Why the two claims it backs were unverified
//
// Task 37's "the device token is never persisted to durable browser storage" is
// checked today by "close and reopen the tab; the client re-authenticates" —
// which a persisted-but-ignored token passes just as happily. Task 43's "lock
// means what it means on desktop" is checked in memory only. Both are
// statements about bytes at rest, and only a scan of the bytes tests them.
//
// # What runs without a sync server, and why that half is worth having
//
// The web client is sync-required, so a note needs a server before it can
// exist. The credentials do not: a user types an account number and a master
// password into a first-run browser before any of that, and the question "did
// the browser write them down" is fully answerable there. Autofill heuristics,
// form-restore state, crash-recovery blobs and the session-restore file are all
// written by the browser itself, on its own schedule, from fields the app never
// asked it to remember — which is exactly the class this scan exists to catch,
// and exactly the class no unit test can see.
//
// The note-content and attachment half needs a server and says so, rather than
// pretending to cover ground it does not.
//
// # Needle discipline
//
// `e2e/support/plaintext-scan.ts` is reused UNMODIFIED — it already matches
// UTF-8 and UTF-16LE against contents and path components, and already reports
// hits by needle INDEX so a failure never reproduces the credential. Its header
// states the needle-design rule this file follows: a needle is either a whole
// credential string or a single all-lowercase alphanumeric token of ≥24 chars,
// because the search tokenizer lowercases and splits on every non-alphanumeric
// character.

import { expect, it } from "vitest";
import { describeE2E } from "./support/scenario";
import { startBundleServer } from "./support/server";
import { newBrowserSession } from "./support/session";
import { openApp, enterAccountNumber } from "./support/flows";
import { DRIVER_PORT } from "./support/worker-ports";
import type { SupportedBrowser } from "./support/harness";
import { scanForPlaintext, waitForFsQuiescence } from "../e2e/support/plaintext-scan";

const BUNDLE_DIR = process.env.MYNE_WEB_E2E_BUNDLE_DIR ?? "web/dist";
const BROWSER = (process.env.MYNE_WEB_E2E_BROWSER ?? "chrome") as SupportedBrowser;
const SYNC_ORIGIN = "https://sync.example.test";

/** A valid-checksum account number from the protocol test corpus — not an
 *  account that exists anywhere. Valid so the entry screen accepts it and the
 *  browser sees a completed field; non-existent so nothing is reached. */
const ACCOUNT_NUMBER = "MY-934G-2V6A-P76G-CNKM-A4X3";

/** ≥24 chars, all-lowercase alphanumeric: survives the tokenizer verbatim, so a
 *  hypothetical plaintext index would contain it intact rather than in pieces. */
const PASSWORD = "residuescanmasterpassword7x3k9q";

/** Needle order is the failure vocabulary: a hit reports this index, never the
 *  string. Keep the array and this comment in step. */
const NEEDLES = [PASSWORD, ACCOUNT_NUMBER];
const NEEDLE_NAMES = ["master password", "account-number display form"];

/** Report hits without reproducing a credential: counts, indices and the file
 *  they were found in. The needle text never reaches the output. */
function describeHits(hits: ReturnType<typeof scanForPlaintext>): string {
  const byNeedle = new Map<number, number>();
  for (const h of hits) byNeedle.set(h.needleIndex, (byNeedle.get(h.needleIndex) ?? 0) + 1);
  const summary = [...byNeedle.entries()]
    .map(([i, n]) => `needle[${i}] (${NEEDLE_NAMES[i] ?? "?"}) ×${n}`)
    .join(", ");
  const files = [...new Set(hits.map((h) => h.file))].slice(0, 10).join("\n  ");
  return `${hits.length} hit(s): ${summary}\nfiles:\n  ${files}`;
}

/**
 * Run `body` with a bundle server and a browser, and close BOTH whatever
 * happens — including when the browser fails to start.
 *
 * Written as a helper after the obvious shape leaked a server: with
 * `const server = …; const browser = await newBrowserSession(…); try { … }
 * finally { server.close() }`, a driver that refuses the session throws
 * *before* the `try`, so the finally never runs and the port stays bound. The
 * next test then fails with `EADDRINUSE` — a second failure that hides the
 * first.
 *
 * The profile deliberately outlives the session here; removing it is this
 * helper's last act, after `body` has had its chance to scan.
 */
async function withBrowser(
  body: (browser: Awaited<ReturnType<typeof newBrowserSession>>, origin: string) => Promise<void>,
): Promise<void> {
  const server = await startBundleServer({ root: BUNDLE_DIR, syncOrigin: SYNC_ORIGIN });
  try {
    const browser = await newBrowserSession({
      baseUrl: `http://127.0.0.1:${DRIVER_PORT}`,
      browser: BROWSER,
    });
    try {
      await body(browser, server.origin);
    } finally {
      await browser.teardown({ keepProfile: true }).catch(() => {});
      browser.removeProfile();
    }
  } finally {
    await server.close();
  }
}

describeE2E("credentials typed into a first-run browser leave nothing at rest", () => {
  it("writes neither the password nor the account number into any profile bucket", async () => {
    await withBrowser(async (browser, origin) => {
      const { session } = browser;
      await openApp(session, origin);

      // Type BOTH credentials, the way a user reaching this screen does. The
      // account number is entered and submitted; the password is typed into the
      // field that follows it. The sign-in itself cannot succeed without a
      // server, and that is fine — the browser has already seen both values,
      // which is the only precondition this scan needs.
      await enterAccountNumber(session, ACCOUNT_NUMBER);
      const pw = await session.findElement('input[type="password"]');
      await pw.sendKeys(PASSWORD);

      // In-page buckets, asserted BEFORE teardown because after it there is no
      // page to ask. `localStorage`/`sessionStorage` are enumerable directly;
      // IndexedDB is enumerated through `databases()` where the browser has it.
      // `executeAsync`: `indexedDB.databases()` is a promise, and the synchronous
      // `execute` endpoint would return before it settled — reporting an empty
      // database list as though it had looked.
      const inPage = (await session.executeAsync(
        `
        const done = arguments[arguments.length - 1];
        (async () => {
          const out = { local: [], session: [], idb: null };
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            out.local.push([k, localStorage.getItem(k) ?? ""]);
          }
          for (let i = 0; i < sessionStorage.length; i++) {
            const k = sessionStorage.key(i);
            out.session.push([k, sessionStorage.getItem(k) ?? ""]);
          }
          if (indexedDB.databases) {
            const dbs = await indexedDB.databases();
            out.idb = dbs.map((d) => d.name ?? "");
          }
          done(out);
        })();
        `,
        [],
      )) as { local: [string, string][]; session: [string, string][]; idb: string[] | null };

      const inPageBlob = JSON.stringify(inPage);
      for (const [i, needle] of NEEDLES.entries()) {
        expect(
          inPageBlob.includes(needle),
          `needle[${i}] (${NEEDLE_NAMES[i]}) is present in localStorage/sessionStorage/IndexedDB names`,
        ).toBe(false);
      }

      // End the session but KEEP the profile: the question is what the browser
      // flushed on its way out, and the desktop suite learned the same lesson —
      // auxiliary processes write late, so scanning before they settle is a
      // silent false-green.
      await browser.teardown({ keepProfile: true });
      await waitForFsQuiescence(browser.profileDir);

      const hits = scanForPlaintext(browser.profileDir, NEEDLES);
      expect(hits.length, hits.length === 0 ? "" : describeHits(hits)).toBe(0);
    });
  });

  it("the scan would CATCH a plaintext credential — negative probe", async () => {
    // A scan that has never failed is a scan nobody has tested. This plants the
    // password in `localStorage` deliberately and asserts the profile scan finds
    // it, so a green run of the scenario above means "no residue" rather than
    // "the scanner looked at nothing".
    await withBrowser(async (browser, origin) => {
      await openApp(browser.session, origin);
      await browser.session.execute(`localStorage.setItem("residue-probe", arguments[0]);`, [
        PASSWORD,
      ]);
      await browser.teardown({ keepProfile: true });
      await waitForFsQuiescence(browser.profileDir);

      const hits = scanForPlaintext(browser.profileDir, NEEDLES);
      expect(
        hits.some((h) => h.needleIndex === 0),
        "a password planted in localStorage was NOT found — the scan is not looking where it claims to",
      ).toBe(true);
    });
  });
});
