// Note-snapshots restore round-trip + at-rest MY01 suite (snapshots-restore /
// MYND-232, e2e-wave-2). Vault-count precondition: 1 (weak KDF).
//
// Drives the SnapshotsPanel restore/preview/diff modal through the production
// binary end-to-end:
//
//   sr1 — force-flush an older snapshot via the REAL flow, then restore it.
//     Edits a seeded note (v1 → v2), LOCKS the vault to force a real snapshot
//     capture of v1 (the autosave `note_update` of the v2 edit snapshots the
//     pre-overwrite v1 blob; `last=None` → the coalesce gate passes on the
//     first edit, and the lock-CTA's flush makes the capture deterministic),
//     unlocks/reopens, and edits again (v2 → v3 — gated, so no second
//     snapshot). This yields a genuine OLDER snapshot (the 5-min coalesce gate
//     otherwise yields only one). NO synthetic/pre-seeded blob — SYNC-W2-1-final.
//     Then opens SnapshotsPanel via the real command-palette action
//     `snapshots.open`, asserts the older snapshot row is present, selects it,
//     asserts the preview/diff shows the v1 content, confirms Restore, and
//     asserts the editor content reverts to v1.
//     Reversibility (SYNC-5): restore force-captures an undo snapshot of v3
//     first, so AFTER restore TWO snapshots exist (older v1 + undo v3) — the
//     "saved as a snapshot first, so you can undo this" copy guarantee.
//     At-rest (SYNC-W2-2): `snapshots/<note>__<snap>.myn` blobs all carry the
//     `MY01` envelope magic (snapshots reuse the note's item_key + §9.2 MY01;
//     no new magic) + a PS-1 residue scan over `snapshots/` proves no v1/v3
//     plaintext leaked.
//
// Prune coverage boundary (downgrade record, per the e2e/CLAUDE.md downgrade
// rule, recorded on MYND-232; SYNC-W2-4): the retention/prune clause is NOT an
// E2E assertion. `snapshotPrune` has no UI surface (a thin IPC wrapper; the
// eager write-path prune runs backend-side on every snapshot create), and
// retention is a timing/window concern — the wrong fit for E2E (the SYNC-15
// auto-lock-timing precedent). The retention policy is pure and already
// unit-covered in `src-tauri/src/snapshot_policy.rs` (`mod tests` —
// `snapshots_to_prune` window/count/byte-budget selection +
// `should_snapshot` coalesce gate). This suite covers list/preview/restore
// round-trip + reversibility + MY01 at-rest only.
//
// KDF: weak generator fixtures (legal — unlock reads params from vault.meta;
// no production-KDF story here). The note body markers are in-source scenario
// content, not credentials; the password is the VR-1-style in-source constant
// (SYNC-13 applies to credentials, which never reach any assert below).
//
// ⚠️ NEW SCENARIO — authored but NOT yet validated in the container. Per the
// e2e/CLAUDE.md definition of done it must go green 3× consecutive via
// `./scripts/e2e-local.sh` before merge; it introduces the SnapshotsPanel
// testid pass (new selectors `snapshots.panel` / `snapshots.row` /
// `snapshots.preview` / `snapshots.restore` / `snapshots.restore-confirm` /
// `snapshots.restore-confirm-cta`), so the panel-open chord + selectors want a
// real run.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import {
  assertSnapshotBlobsMagic,
  scanSnapshotsForResidue,
  seedVault,
} from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  editorText,
  runPaletteAction,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

// Distinctive ≥24-char lowercase-alnum tokens (PS-1 needle rule): one per
// version so the residue scan and the preview/diff asserts target a specific
// version verbatim. Leading space gives each inline append a clean word
// boundary after typeIntoEditor's sacrificial probe char.
const V1 = " snapshotv1marker7k2m9qx4w8e5rj";
const V2 = " snapshotv2marker3f6h1zn8c2vbap";
const V3 = " snapshotv3marker5m9w8x2k4q7zlt";
const PASSWORD = "Qp9#xT4!nG7&wM2k-sr1";
/** Needle indices for the residue scan: 0=v1, 1=v3 (v2 was overwritten by v3
 *  and never snapshotted, so it is not a leakage subject here). */
const RESIDUE_NEEDLES = [V1.trim(), V3.trim()];

/** Read the `data-note-id` of the currently-selected sidebar row — the note
 *  `createNote` just created and left selected (the byTestId-only path to a
 *  live-created note's id; the row carries `aria-selected="true"` +
 *  `data-note-id`). */
async function selectedNoteId(s: Session): Promise<string> {
  const row = await s.waitForElement(
    '[data-testid="notes.row"][aria-selected="true"]',
  );
  const id = await row.attribute("data-note-id");
  if (id === null || id === "") {
    throw new Error("selected notes.row carried no data-note-id");
  }
  return id;
}

describeE2E("sr1 snapshot restore round-trip + MY01 at-rest (MYND-232)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("force-flushes an older snapshot, previews + restores it, and snapshots are MY01 at rest", async () => {
    let vaultId = "";
    let noteUuid = "";
    await scenario(
      "sr1-snapshot-restore",
      {
        seed: (dir) => {
          vaultId = seedVault(dir, { password: PASSWORD }).vaultId;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, PASSWORD);
        await dismissImporterOffer(s);

        // ---- v1 → v2: the v2 save snapshots the pre-overwrite v1 blob ----
        await createNote(s, "Snapshot Note");
        await typeIntoEditor(s, V1);
        await waitForSaved(s);
        noteUuid = await selectedNoteId(s);

        await typeIntoEditor(s, V2);
        await waitForSaved(s);

        // Lock — the deterministic force-flush: the lock CTA flushes the
        // editor buffer (so v2 is on disk and v1's snapshot is persisted)
        // before `vault_lock`. This is the real-flow older-snapshot seed
        // (no synthetic blob; SYNC-W2-1-final).
        await (await s.byTestId("editor.lock-cta")).click();
        await s.byTestId("unlock.password-input");

        // ---- reopen, v2 → v3 (gated: within the coalesce window, so this
        // edit does NOT add a second snapshot — the v1 snapshot is the lone
        // OLDER snapshot for the round-trip) ----
        await unlockToEditor(s, PASSWORD);
        await (
          await s.waitForElement(testIdSelector("notes.row", { "data-note-id": noteUuid }))
        ).click();
        await s.waitUntil(async () => (await editorText(s)).includes(V1.trim()) || null, {
          label: "v1+v2 content reloaded after unlock",
        });
        await typeIntoEditor(s, V3);
        await waitForSaved(s);
        await s.waitUntil(async () => (await editorText(s)).includes(V3.trim()) || null, {
          label: "editor reached v3",
        });

        // ---- open SnapshotsPanel via the real command-palette action ----
        await runPaletteAction(s, "snapshots.open", "snap");
        await s.byTestId("snapshots.panel");

        // The older snapshot of v1 is present (real force-flushed capture).
        const rows = await s.byTestIdAll("snapshots.row");
        expect(rows.length).toBeGreaterThanOrEqual(1);

        // Select the oldest row (highest data-index — the list is newest-first)
        // and assert the preview/diff shows the v1 content.
        const lastRow = rows[rows.length - 1];
        await lastRow.click();
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("snapshots.preview")).textContent()).includes(
              V1.trim(),
            ) || null,
          { label: "preview/diff shows the v1 snapshot content" },
        );

        // ---- confirm Restore → editor content reverts to v1 ----
        await (await s.byTestId("snapshots.restore")).click();
        await s.byTestId("snapshots.restore-confirm");
        await (await s.byTestId("snapshots.restore-confirm-cta")).click();
        await s.waitUntil(
          async () => {
            const text = await editorText(s);
            // Reverted to v1: the v1 marker is present and the v3 marker is
            // gone (the restore overwrote the live note with the v1 snapshot).
            return text.includes(V1.trim()) && !text.includes(V3.trim()) ? true : null;
          },
          { label: "restore reverted the editor to the v1 snapshot" },
        );

        // ---- reversibility (SYNC-5): restore force-captured an undo
        // snapshot of v3, so there are now ≥2 snapshots (older v1 + undo v3).
        // assertSnapshotBlobsMagic returns the blob names it asserted. ----
        const blobs = assertSnapshotBlobsMagic(app.appDataDir, vaultId, noteUuid);
        expect(blobs.length).toBeGreaterThanOrEqual(2);

        // ---- at-rest residue scan: no v1/v3 plaintext under snapshots/ ----
        expect(scanSnapshotsForResidue(app.appDataDir, vaultId, RESIDUE_NEEDLES)).toEqual([]);
      },
    );
  });
});
