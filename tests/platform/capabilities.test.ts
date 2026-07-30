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
      "vaultCreation",
      "phraseRecovery",
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
    expect([...present].sort()).toEqual(["changePassword", "pinQuickUnlock"]);
  });
});
