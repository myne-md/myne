// The version-history panel on a CRDT (`NC05`) note — the v0.2 half of the
// feature `snapshots-restore.e2e.ts` covers for v0.1.
//
// Why a second scenario rather than a parameter on the first: the two read from
// DIFFERENT STORES. A `MY01` note's history is the `snapshots/` directory; an
// `NC05` note captures no snapshots at all (by design — the synced Automerge
// change-graph is the version store, `decisions.md` 2026-08-09 ASM-12→B), so its
// history comes out of the note blob itself. A vault created today is born v0.2
// (`decisions.md` 2026-08-13), which makes THIS the path most users are on, and
// before the CRDT arm landed the panel was permanently empty for all of them.
//
// The scenario drives the real command-palette action and the real panel — no
// test hook — and asserts on the two things a screenshot could not fake: the
// list is non-empty on a note that has no `snapshots/` entry at all, and
// restoring an older revision puts that text back on the live note.
//
// SYNC-13: the password is an in-source constant; note bodies are scenario
// content, not credentials.
//
// ⚠️ NEW SCENARIO — authored, not yet validated in the container. Per
// e2e/AGENTS.md's definition of done it must go green 3× consecutive
// (`./scripts/e2e-buildrun.sh e2e/crdt-history.e2e.ts` ×3) before merge.

import { expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  pageSeatInvoke,
  runPaletteAction,
  selectedNoteId,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";

const PASSWORD = "Qp9#xT4!nG7&wM2k-ch1";
const V1 = "first revision marker qzcrdthistoryoneaaaaaaaa\n";
const V2 = "second revision marker qzcrdthistorytwobbbbbbbb\n";
const IPC_TIMEOUT = 20_000;

describeE2E("ch1 CRDT note version history (1 vault, v0.2 birth format)", () => {
  // Vault-count precondition: 1 (weak KDF, default generation = v0.2).
  it("lists an NC05 note's revisions with no snapshots/ store, and restores one", async () => {
    let vaultId = "";
    let noteUuid = "";
    await scenario(
      "ch1-crdt-history",
      {
        seed: (dir) => {
          // No `generation` argument on purpose: this scenario is about the
          // DEFAULT vault a new user gets.
          vaultId = seedVault(dir, { password: PASSWORD }).vaultId;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, PASSWORD);
        await dismissImporterOffer(s);

        await createNote(s, "CRDT History Note");
        await typeIntoEditor(s, V1);
        await waitForSaved(s);
        noteUuid = await selectedNoteId(s);

        // The note really is NC05 — otherwise everything below would be
        // exercising the v0.1 snapshot store under a v0.2 test name.
        const notePath = join(app.appDataDir, "vaults", vaultId, "notes", `${noteUuid}.myn`);
        expect(readFileSync(notePath).subarray(0, 4).toString("latin1")).toBe("NC05");

        await typeIntoEditor(s, V2);
        await waitForSaved(s);

        // There is NO snapshot store for this note. This is the assertion that
        // makes the list below meaningful: the history cannot be coming from
        // `snapshots/`, because it does not exist.
        expect(existsSync(join(app.appDataDir, "vaults", vaultId, "snapshots", noteUuid))).toBe(
          false,
        );

        // ---- the real panel, via the real palette action ----
        await runPaletteAction(s, "snapshots.open", "snap");
        await s.byTestId("snapshots.panel");
        const rows = await s.byTestIdAll("snapshots.row");
        expect(rows.length).toBeGreaterThanOrEqual(2);

        // Find the revision whose text is v1-only (before the v2 edit), the same
        // way sr1 does: read each row's content through the production preview
        // command rather than trusting list order.
        let v1Row: (typeof rows)[number] | null = null;
        for (const row of rows) {
          const revision = await row.attribute("data-snapshot-id");
          if (revision === null) continue;
          const r = await pageSeatInvoke(
            s,
            "plugin:snapshots|snapshot_preview",
            { noteId: noteUuid, snapshotUuid: revision },
            IPC_TIMEOUT,
          );
          const body = typeof r.ok === "string" ? r.ok : "";
          if (body.includes(V1.trim()) && !body.includes(V2.trim())) {
            v1Row = row;
            break;
          }
        }
        expect(v1Row, "a revision whose text is v1 without v2 is present").not.toBeNull();
        await v1Row!.click();
        await s.byTestId("snapshots.preview");

        // ---- restore it ----
        await (await s.byTestId("snapshots.restore")).click();
        await s.byTestId("snapshots.restore-confirm");
        await (await s.byTestId("snapshots.restore-confirm-cta")).click();

        // Disk truth through the production read path.
        await s.waitUntil(
          async () => {
            const r = await pageSeatInvoke(
              s,
              "plugin:notes|note_read",
              { noteId: noteUuid },
              IPC_TIMEOUT,
            );
            const body = typeof r.ok === "string" ? r.ok : "";
            return (body.includes(V1.trim()) && !body.includes(V2.trim())) || null;
          },
          { label: "live note reverted to the v1 revision" },
        );

        // The restore is itself a revision, so the history GREW — which is what
        // makes it undoable without a separate undo store.
        const after = await pageSeatInvoke(
          s,
          "plugin:snapshots|snapshot_list",
          { noteId: noteUuid },
          IPC_TIMEOUT,
        );
        expect(Array.isArray(after.ok)).toBe(true);
        expect((after.ok as unknown[]).length).toBeGreaterThan(rows.length);

        // Still no snapshot store — the restore did not write a v0.1 artefact
        // into a v0.2 vault.
        expect(existsSync(join(app.appDataDir, "vaults", vaultId, "snapshots", noteUuid))).toBe(
          false,
        );
      },
    );
  });
});
