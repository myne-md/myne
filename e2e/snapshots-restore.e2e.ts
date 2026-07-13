// Note-snapshots restore round-trip + at-rest MY01 suite (snapshots-restore /
// MYND-232, e2e-wave-2). Vault-count precondition: 1 (weak KDF).
//
// Drives the SnapshotsPanel restore/preview/diff modal through the production
// binary end-to-end:
//
//   sr1 — force-flush an older snapshot via the REAL flow, then restore it.
//     Types v1 into a fresh note, then force-captures a snapshot of v1 via the
//     production `note_snapshot_flush` command (the close/lock-flush path; it
//     bypasses the 5-min autosave coalesce gate, which would otherwise only ever
//     snapshot the empty PRE-v1 state in a fast test). Driven via page-seat IPC
//     — the sanctioned backend-only path; the frontend exposes no other trigger.
//     NO synthetic/pre-seeded blob — the snapshot is a real `MY01` capture.
//     Then appends v3 (so the live note differs), opens SnapshotsPanel via the
//     real command-palette action `snapshots.open`, identifies the v1 snapshot
//     by reading each row's body via page-seat `snapshot_preview` (the panel's
//     own pane is a preview-vs-current diff, not a per-snapshot read), confirms
//     Restore, and asserts the note reverts to v1 — on disk (page-seat
//     `note_read`, race-free) AND in the re-opened editor.
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
  pageSeatInvoke,
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
const V3 = " snapshotv3marker5m9w8x2k4q7zlt";
const PASSWORD = "Qp9#xT4!nG7&wM2k-sr1";
/** Needle indices for the residue scan: 0=v1, 1=v3 — neither may leak as
 *  plaintext under snapshots/ (the v1 capture is encrypted; v3 is never
 *  snapshotted before restore). */
const RESIDUE_NEEDLES = [V1.trim(), V3.trim()];
const IPC_TIMEOUT = 15_000;

/** Read the `data-note-id` of the currently-selected sidebar row — the note
 *  `createNote` just created and left selected (the byTestId-only path to a
 *  live-created note's id; the row carries `aria-selected="true"` +
 *  `data-note-id`). */
async function selectedNoteId(s: Session): Promise<string> {
  const row = await s.waitForElement(
    '[data-testid="notes.row"][aria-current="true"]',
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

        // ---- v1: type it, save, then FORCE a snapshot of exactly v1 ----
        await createNote(s, "Snapshot Note");
        await typeIntoEditor(s, V1);
        await waitForSaved(s);
        noteUuid = await selectedNoteId(s);

        // The autosave coalesce gate (5-min window) means the only AUTOMATIC
        // snapshot of a fast test is the empty PRE-v1 state — useless for a
        // content round-trip. `note_snapshot_flush` is the production
        // close/lock-flush command and force-captures (coalesce-bypassed) the
        // note's CURRENT on-disk state — here, v1. Driven via page-seat IPC (the
        // sanctioned backend-only path; the frontend has no other trigger), it
        // yields a genuine content-bearing OLDER snapshot, no synthetic blob.
        {
          const r = await pageSeatInvoke(
            s,
            "plugin:notes|note_snapshot_flush",
            { noteId: noteUuid },
            IPC_TIMEOUT,
          );
          expect(r.err, "note_snapshot_flush should succeed").toBeUndefined();
        }

        // ---- v1 -> v3: append v3 so the live note differs from the v1 snapshot ----
        await typeIntoEditor(s, V3);
        await waitForSaved(s);
        await s.waitUntil(async () => (await editorText(s)).includes(V3.trim()) || null, {
          label: "editor reached v3",
        });

        // ---- open SnapshotsPanel via the real command-palette action ----
        await runPaletteAction(s, "snapshots.open", "snap");
        await s.byTestId("snapshots.panel");

        // At least the forced v1 snapshot is present (plus possibly the empty
        // pre-v1 coalesce capture). Pick the row whose snapshot BODY is v1 (has
        // V1's marker, not V3's) by reading each row's content via page-seat
        // `snapshot_preview` — robust to list ordering and to the extra empty
        // capture. The panel's own preview pane is a diff (spans both versions),
        // so it can't identify a single snapshot's content; page-seat reads the
        // raw blob.
        const rows = await s.byTestIdAll("snapshots.row");
        expect(rows.length).toBeGreaterThanOrEqual(1);
        let v1Row: (typeof rows)[number] | null = null;
        for (const row of rows) {
          const snapId = await row.attribute("data-snapshot-id");
          if (snapId === null) continue;
          const r = await pageSeatInvoke(
            s,
            "plugin:snapshots|snapshot_preview",
            { noteId: noteUuid, snapshotUuid: snapId },
            IPC_TIMEOUT,
          );
          const body = typeof r.ok === "string" ? r.ok : "";
          if (body.includes(V1.trim()) && !body.includes(V3.trim())) {
            v1Row = row;
            break;
          }
        }
        expect(v1Row, "a snapshot whose body is v1 (no v3) is present").not.toBeNull();
        await v1Row!.click();
        await s.byTestId("snapshots.preview");

        // ---- confirm Restore -> the note reverts to v1 ----
        await (await s.byTestId("snapshots.restore")).click();
        await s.byTestId("snapshots.restore-confirm");
        await (await s.byTestId("snapshots.restore-confirm-cta")).click();

        // Disk truth: the restore overwrote the live note with the v1 snapshot.
        // Read it back via page-seat `note_read` — authoritative, free of any
        // editor live-reload race.
        await s.waitUntil(
          async () => {
            const r = await pageSeatInvoke(
              s,
              "plugin:notes|note_read",
              { noteId: noteUuid },
              IPC_TIMEOUT,
            );
            const body = typeof r.ok === "string" ? r.ok : "";
            return body.includes(V1.trim()) && !body.includes(V3.trim()) ? true : null;
          },
          { label: "restore reverted the note on disk to v1", timeoutMs: IPC_TIMEOUT },
        );

        // Close the panel (Esc, document-level handler; via the Actions API since
        // the editor behind the focus trap isn't directly focusable) and confirm
        // the editor surface reflects the restored v1 too.
        const pressEscape = () =>
          s.send("POST", "/actions", {
            actions: [
              {
                type: "key",
                id: "kbd",
                actions: [
                  { type: "keyDown", value: "" },
                  { type: "keyUp", value: "" },
                ],
              },
            ],
          });
        await s.waitUntil(
          async () => {
            if ((await s.findElements(testIdSelector("snapshots.panel"))).length === 0) {
              return true;
            }
            await pressEscape();
            return null;
          },
          { label: "snapshots panel closed after restore", timeoutMs: 10_000 },
        );
        // Re-open the note from the sidebar to force a fresh editor mount that
        // reads the restored body straight off disk.
        await (
          await s.waitForElement(testIdSelector("notes.row", { "data-note-id": noteUuid }))
        ).click();
        await s.waitUntil(
          async () => {
            const text = await editorText(s);
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
