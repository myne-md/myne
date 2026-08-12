// PS-1 — at-rest plaintext residue proof for note content (MYND-228,
// e2e-expansion wave 2). The only E2E-grade proof of the
// everything-encrypted promise: a distinctive marker typed into a note
// through the real UI must exist NOWHERE under the session's data dir
// in plaintext, at three lifecycle points:
//
//   (a) live/unlocked, after the autosave settles — the .myn blob is
//       on disk and must already be ciphertext;
//   (b) post-lock — lock is the deterministic trigger of the encrypted
//       search-index + workspace persists (vault_unlock/commands.rs),
//       so this point proves vault.search / vault.workspace too;
//   (c) post-exit — `keepDataDir` keeps the tree past teardown, an
//       fs-quiescence gate absorbs late writes from WebKit's auxiliary
//       processes (deleteSession does not contractually wait for their
//       flushes), then the surviving tree is scanned; the spec owns
//       the final rmSync.
//
// Two positive controls guard against an always-green scan: (A) the
// note blob demonstrably reached disk (exactly one MY01 .myn, larger
// than the marker), and (B) planted canary files in both encodings are
// actually found by the scanner before the real scans run.
//
// Needle design (see support/plaintext-scan.ts header): single
// all-lowercase ASCII-alphanumeric tokens ≥24 chars, so a hypothetical
// plaintext search-index leak would contain them verbatim despite the
// tokenizer's lowercase + split-on-non-alphanumeric normalization.
//
// SYNC-13: the body/title markers are in-source scenario constants
// (note content, not credentials — the notes-suite exception); the
// password is the VR-1-style in-source constant. Scan failures print
// file paths + needle indices only, never needle text.

import { expect, it } from "vitest";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { scanForPlaintext, waitForFsQuiescence } from "./support/plaintext-scan";

// secret-scan:allow — PS-1 residue needles are high-entropy BY DESIGN
const BODY_TOKEN = "ps1bodyresidue7k2m9qx4w8e5rj";
// secret-scan:allow — same
const TITLE_TOKEN = "ps1titleresidue3f6h1zn8c2vb5";
const PASSWORD = "Qp9#xT4!nG7&wM2k-ps1";
/** Needle indices in every scan below: 0=body, 1=title, 2=password. */
const NEEDLES = [BODY_TOKEN, TITLE_TOKEN, PASSWORD];

describeE2E("PS-1 note plaintext at-rest residue (MYND-228)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("note body, title, and password exist nowhere on disk — live, locked, and after exit", async () => {
    let vaultId = "";
    let dataHome = "";
    try {
      await scenario(
        "ps1-note-at-rest",
        {
          keepDataDir: true,
          // dataHome is captured in the SEED (not the body) so the
          // finally below can clean up even when launchApp itself
          // fails — the one path where keepDataDir would otherwise
          // leak the mkdtemp dir.
          seed: (dir) => {
            dataHome = dirname(dir);
            vaultId = seedVault(dir, { password: PASSWORD }).vaultId;
          },
        },
        async (app) => {
          const s = app.session;
          await unlockToEditor(s, PASSWORD);
          await dismissImporterOffer(s);
          await createNote(s, TITLE_TOKEN);
          await typeIntoEditor(s, BODY_TOKEN);
          await waitForSaved(s);

          // Positive control A: the content demonstrably reached disk
          // — exactly one .myn blob, MY01 magic, larger than the
          // marker. Without this, a scan over a never-written tree
          // would pass meaninglessly.
          const notesDir = join(app.appDataDir, "vaults", vaultId, "notes");
          const blobs = readdirSync(notesDir).filter((n) => n.endsWith(".myn"));
          expect(blobs).toHaveLength(1);
          const blob = readFileSync(join(notesDir, blobs[0]));
          expect(blob.subarray(0, 4).toString("latin1")).toBe("MY01");
          expect(blob.length).toBeGreaterThan(BODY_TOKEN.length);

          // Positive control B: the scanner provably detects planted
          // plaintext in BOTH encodings before the real scans run.
          const canaries = [
            { file: join(dataHome, ".tmp", "ps1-canary-utf8.bin"), enc: "utf8" as const },
            { file: join(dataHome, ".tmp", "ps1-canary-utf16.bin"), enc: "utf16le" as const },
          ];
          for (const c of canaries) writeFileSync(c.file, Buffer.from(BODY_TOKEN, c.enc));
          const byFile = (a: { file: string }, b: { file: string }) =>
            a.file.localeCompare(b.file);
          expect(scanForPlaintext(dataHome, [BODY_TOKEN]).sort(byFile)).toEqual(
            canaries
              .map((c) => ({ file: c.file, needleIndex: 0, via: "content" }))
              .sort(byFile),
          );
          for (const c of canaries) rmSync(c.file);

          // Scan (a) — live/unlocked: the blob (and anything else the
          // app has written so far) is ciphertext-only.
          expect(scanForPlaintext(dataHome, NEEDLES)).toEqual([]);

          // Scan (b) — post-lock: vault.search / vault.workspace have
          // now been persisted (encrypted) by the lock path.
          await (await s.byTestId("editor.lock-cta")).click();
          await s.byTestId("unlock.password-input");
          expect(scanForPlaintext(dataHome, NEEDLES)).toEqual([]);
        },
      );

      // Scan (c) — post-exit. Teardown (graceful deleteSession) has
      // completed; wait for the tree to stop changing so late flushes
      // from WebKit's auxiliary processes are scanned, not missed.
      await waitForFsQuiescence(dataHome);
      expect(scanForPlaintext(dataHome, NEEDLES)).toEqual([]);
    } finally {
      // keepDataDir means the harness left the tree for scan (c) —
      // removing it is this spec's job, success or failure.
      if (dataHome) rmSync(dataHome, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
