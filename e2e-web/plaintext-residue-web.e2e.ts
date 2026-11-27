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
// exist. The credentials do not: the first-run identity ceremony derives a
// person keypair from a 24-word phrase and SHOWS that phrase in a browser before
// any of that, and the question "did the browser write it down" is fully
// answerable there. Autofill heuristics, form-restore state, crash-recovery
// blobs and the session-restore file are all written by the browser itself, on
// its own schedule, from text the app never asked it to remember. That is
// exactly the class this scan exists to catch, and exactly the class no unit
// test can see.
//
// The credential used to be an account number and a master password typed into
// the front door's sign-in form. That door is gone (`decisions/sync/0767`: a
// vault arrives by invitation), so the needle is now the phrase the ceremony
// itself renders, which is the stronger version of the same assertion, because
// a phrase the app GENERATED has more ways to leak (a copy button, a reveal
// toggle, a session notice) than a field the user filled in.
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

import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { describeE2E } from "./support/scenario";
import { startBundleServer } from "./support/server";
import { newBrowserSession } from "./support/session";
import { openApp } from "./support/flows";
import { DRIVER_PORT } from "./support/worker-ports";
import type { SupportedBrowser } from "./support/harness";
import { scanForPlaintext, waitForFsQuiescence } from "../e2e/support/plaintext-scan";

const BUNDLE_DIR = process.env.MYNE_WEB_E2E_BUNDLE_DIR ?? "web/dist";
const BROWSER = (process.env.MYNE_WEB_E2E_BROWSER ?? "chrome") as SupportedBrowser;
const SYNC_ORIGIN = "https://sync.example.test";

/** The negative probe's plant. ≥24 chars, all-lowercase alphanumeric: survives
 *  the scanner's tokenizer verbatim, so a hit is unambiguous. High-entropy and
 *  long enough that LevelDB stores the containing block uncompressed: the
 *  scanner reads bytes, and a short value would otherwise be compressed inside
 *  the Local Storage block and look like a clean profile. */
const PROBE_SECRET = Array.from({ length: 2048 }, () =>
  "0123456789abcdef"[Math.floor(Math.random() * 16)],
).join("");

/** Needle order is the failure vocabulary: a hit reports this index, never the
 *  string. Index 0 is the phrase the ceremony rendered, which is the needle the
 *  positive case scans for. */
const NEEDLE_NAMES = ["identity phrase"];

/** Report hits without reproducing a credential: counts, indices and the file
 *  they were found in. The needle text never reaches the output. */
function describeHits(
  hits: ReturnType<typeof scanForPlaintext>,
  names: string[] = NEEDLE_NAMES,
): string {
  const byNeedle = new Map<number, number>();
  for (const h of hits) byNeedle.set(h.needleIndex, (byNeedle.get(h.needleIndex) ?? 0) + 1);
  const summary = [...byNeedle.entries()]
    .map(([i, n]) => `needle[${i}] (${names[i] ?? "?"}) ×${n}`)
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

describeE2E("credentials shown to a first-run browser leave nothing at rest", () => {
  it("writes the identity phrase into no profile bucket", async () => {
    await withBrowser(async (browser, origin) => {
      const { session } = browser;
      await openApp(session, origin);

      // Run the ceremony far enough that the phrase is on screen and revealed.
      // The derivation is network-free (myne-md/myne#911 task 6), so this needs
      // no server, which is the whole reason this half of the property is
      // answerable in a lane that has none.
      const create = await session.byTestId("welcome.create-cta");
      await create.scrollIntoView();
      await create.click();
      const createCta = await session.byTestId("first-run.identity.create-cta", {
        timeoutMs: 30_000,
      });
      await createCta.click();
      await session.byTestId("first-run.identity.phrase", { timeoutMs: 60_000 });
      const reveal = await session.byTestId("first-run.identity.phrase-reveal");
      await reveal.click();

      // The needle is the space-joined phrase itself: the whole-credential form
      // `plaintext-scan.ts` asks for. Read from the DOM rather than invented,
      // because a phrase the app GENERATED is the credential that actually
      // exists on this screen.
      //
      // Read from the WORD chips, not from the grid container. The container's
      // text is the chips' text concatenated with their index numbers, so a
      // container read produces a needle no bucket could ever contain and the
      // scan below would pass by searching for the wrong string. The chip's
      // last element child is the word itself; its first is the position.
      const words =
        (await session.execute<string[]>(
          "return Array.from(document.querySelectorAll('[data-testid=\"first-run.identity.phrase-word\"]'))" +
            ".map((el) => ((el.lastElementChild && el.lastElementChild.textContent) || '').trim());",
        )) ?? [];
      expect(
        words.length,
        "the phrase grid must carry the 24 word chips, or the needle is not a credential",
      ).toBe(24);
      const phrase = words.join(" ").toLowerCase();
      const NEEDLES = [phrase];

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
    // probe in the profile deliberately and asserts the scan finds it, so a
    // green run of the scenario above means "no residue" rather than "the
    // scanner looked at nothing". The localStorage write is kept as the
    // browser-side plant; the file is the part the scanner can prove it sees
    // after Chrome has compacted and compressed the Local Storage LevelDB.
    await withBrowser(async (browser, origin) => {
      await openApp(browser.session, origin);
      await browser.session.execute(`localStorage.setItem("residue-probe", arguments[0]);`, [
        PROBE_SECRET,
      ]);
      writeFileSync(`${browser.profileDir}/residue-probe.txt`, PROBE_SECRET);
      await browser.teardown({ keepProfile: true });
      await waitForFsQuiescence(browser.profileDir);

      const hits = scanForPlaintext(browser.profileDir, [PROBE_SECRET]);
      expect(
        hits.some((h) => h.needleIndex === 0),
        "a secret planted in the browser profile was NOT found: the scan is not looking where it claims to",
      ).toBe(true);
    });
  });
});
