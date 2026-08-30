// The capability descriptor's own contract (phase3-web-client task 27).
//
// Not part of `seam-contract.ts`: that suite is parameterised over a *transport*
// and asserts forwarding, unwrapping and the typed refusal. The descriptor has
// no transport — it is a build-time constant — so it gets its own assertions
// rather than a contrived subject.
//
// What is worth testing here is not "does `has()` return a boolean" but the two
// properties that make one descriptor better than gating re-derived per call
// site: it is EXHAUSTIVE (no capability can be silently unanswered) and it is
// TOTAL (every implementation answers for every capability).

import { describe, expect, it } from "vitest";
import * as desktop from "../../src/platform/capabilities";
import * as web from "../../web/src/platform/capabilities";
import type { Capability } from "../../src/platform/capabilities";

const IMPLEMENTATIONS: Array<[string, { has: (c: Capability) => boolean }]> = [
  ["desktop", desktop],
  ["web", web],
];

describe("capability descriptor", () => {
  it("lists every capability exactly once", () => {
    // `ALL_CAPABILITIES` is what makes exhaustiveness checkable at all; a
    // duplicate would make a `Set`-based implementation silently smaller than
    // the list it claims to cover.
    const seen = new Set(desktop.ALL_CAPABILITIES);
    expect(seen.size).toBe(desktop.ALL_CAPABILITIES.length);
  });

  it("both implementations export the SAME capability list", () => {
    // The web module re-exports the desktop list rather than declaring its own,
    // which is the property that makes a new capability impossible to forget on
    // one side. Asserted rather than assumed, because a future edit could
    // replace the re-export with a copy and nothing else would notice.
    expect(web.ALL_CAPABILITIES).toEqual(desktop.ALL_CAPABILITIES);
  });

  for (const [name, impl] of IMPLEMENTATIONS) {
    it(`${name} answers for every capability, with a boolean`, () => {
      for (const cap of desktop.ALL_CAPABILITIES) {
        const answer = impl.has(cap);
        expect(
          typeof answer,
          `${name}.has(${cap}) must be a boolean; \`undefined\` would read as ` +
            `"absent" and silently hide a working feature`,
        ).toBe("boolean");
      }
    });
  }

  it("desktop has everything", () => {
    for (const cap of desktop.ALL_CAPABILITIES) {
      expect(desktop.has(cap), `desktop should provide ${cap}`).toBe(true);
    }
  });

  it("web is missing exactly the decided set, and nothing else", () => {
    // Spelled out rather than derived from the implementation — a test that
    // recomputed the answer from the same source would assert nothing. Each of
    // these is normative per `decisions.md` 2026-07-26 or a platform fact; the
    // reasons live at the implementation.
    const expectedAbsent: Capability[] = [
      "clipper",
      "localAi",
      "watchCapture",
      "shareImport",
      "biometricQuickUnlock",
      "osIdleAutoLock",
      "screenCaptureProtection",
      "vaultMigration",
      "backup",
      "nativeSaveAs",
      // `decisions/clients/0545`, myne-md/myne#464. Absent on two independent
      // grounds, and either alone would be enough. A browser origin holds ONE
      // container under a constant vault id, so there is no second vault to
      // import FROM and the source list would be permanently empty. And the
      // setup step accepts a 24-word recovery phrase, which is the ROUTINE
      // phrase prompt `phraseEnrolment` two entries down exists to keep out of
      // this client: `decisions.md` 2026-08-15 bounds web to asking for the
      // phrase in exactly one situation, a recovery the user started
      // themselves. The module is substituted as well as gated, for the reason
      // `check-web-no-phrase.mjs` was written.
      "vaultImport",
      // `decisions.md` 2026-08-15, and the reason it is a SECOND capability
      // rather than a branch of `phraseRecovery`: one flag used to gate two
      // unrelated things, the recovery screen and the enrolment form's
      // credential picker, so lifting the phrase ban would have shipped three
      // phrase screens while the decision named two. Enrolment is a ROUTINE
      // action with a password credential already available, and every routine
      // use is what teaches a user that typing 24 words into a browser is
      // normal. Keeping it absent is what leaves a rule a user can apply: the
      // web client asks for the phrase in exactly one situation, a recovery
      // they started themselves.
      "phraseEnrolment",
      // `decisions.md` 2026-08-15. The Copy affordance SHIPS on web; what is
      // absent is the 30 second auto-clear, because the read-back that makes it
      // safe is not available to page content. Named for the clear rather than
      // for the copy, the same way `imageCompression` is named for the transform
      // rather than the preference.
      "clipboardAutoClear",
      "vaultExport",
      // Task 47 — a bundle-size decision, not a portability limit: the `spell`
      // plugin would port; the bundled binary dictionaries are what does not fit
      // a bundle whose trust story is that it is small enough to audit.
      "spellCheck",
      // Task 48 — the one export whose obstacle is the OUTPUT rather than the
      // destination (a hidden Tauri WebView, printed and collected). Note-as-
      // markdown and attachment download are deliberately NOT here: their
      // obstacle was where the file goes, and the browser download flow answers
      // that, so they ship.
      "pdfExport",
      // Task 72, owner decision 2026-07-27 — repair scans a vault DIRECTORY for
      // orphan artefacts, which exists because a desktop directory is writable
      // by other software. An OPFS container has exactly one writer, and its one
      // damage mode (eviction) is answered by re-sync (task 22), so this would
      // offer to fix a class of problem the storage cannot have.
      "vaultRepair",
      // Task 72, and the odd one out: not an affordance web lacks, but the FACT
      // that its vault is never the only copy (`decisions.md` 2026-07-26 makes
      // sync required, so OPFS holds a cache of a server-held vault). It sits in
      // the absent set because it makes `vault_delete`'s promise different —
      // a sign-out rather than a destruction — and the desktop wording said here
      // would be false in the direction where a user believes their notes are
      // gone while every synced one is on the server.
      "localOnlyVault",
      // Task 71, and named for the MECHANISM rather than the feature: markdown
      // import SHIPS on web. What is absent is the host-confined directory read
      // (`canonicalize` + within-root) that exists because the desktop WebView is
      // denied `fs:allow-read-dir`; a browser gets the tree from the user's own
      // directory pick, which needs no confinement.
      "hostDirectoryRead",
      // Task 90. Named for the SEARCH, not the extraction, because that is what
      // a user loses: attachments still import, sync, open and match by
      // filename. `MYE1` is device-local and never synced, so a browser cannot
      // inherit a desktop's extractions either.
      "attachmentTextSearch",
      // Named for the TRANSFORM, not the preference behind it: images still
      // import on web, they are just stored as given, because `catch_unwind`
      // cannot contain a decoder panic on wasm32 and a hostile image would kill
      // the vault Worker. `attachment_compression_enabled` is shared vault
      // content this client reads, writes and syncs like any other field —
      // which is why the absence changes the settings copy rather than removing
      // the control.
      "imageCompression",
      // MYND-490. Absent by PLATFORM FACT rather than by decision or bundle
      // budget: the door is a local socket a shell command connects to, and the
      // command is a binary inside the desktop bundle. There is no
      // browser-shaped version of either, so there is nothing a later port
      // could deliver.
      "cliAccess",
      // myne-md/myne#411, and named for the NAMES rather than for the Privacy
      // switch that hides them. Both halves are missing on web: the locked
      // picker a cached name exists to label is unreachable (an origin holds
      // exactly one container, so `VaultPicker.tsx` is `excluded`), and the
      // `MYL1` store is sealed under an OS keychain a page does not have. The
      // FORMAT is not what is absent, the same way `spellCheck` leaves `MYD1`
      // alone: `MYL1` is unchanged and desktop's row is ungated.
      "lockedVaultNames",
      // MYND-650, and the second platform-fact entry alongside `cliAccess`.
      // Routing sync through Tor means spawning a Tor client as a subprocess
      // and tunnelling a raw loopback socket to it; a page has neither, and
      // `fetch` cannot be pointed at a proxy. Absent for the same reason as
      // `cliAccess` and with the same consequence: nothing to port. The
      // browser's answer is Tor Browser, which routes the whole page.
      "torRouting",
    ];
    const actualAbsent = desktop.ALL_CAPABILITIES.filter((c) => !web.has(c));
    expect([...actualAbsent].sort()).toEqual([...expectedAbsent].sort());
  });

  it("web KEEPS the capabilities that are not in the absent set", () => {
    // The half a "list the absences" test forgets. `change_password` staying
    // available on web is a decision with a stated reason — the master password
    // is already typed into the page at every unlock, so allowing it to be
    // changed there adds no exposure — and quietly losing it would be a silent
    // reversal of `decisions.md` 2026-07-26.
    const present = desktop.ALL_CAPABILITIES.filter((c) => web.has(c));
    expect([...present].sort()).toEqual([
      "changePassword",
      "phraseRecovery",
      "pinQuickUnlock",
      "vaultCreation",
    ]);
  });
});
