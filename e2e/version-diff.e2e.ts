// Shared version-diff surfaces, end to end (MYND-334). Vault-count
// precondition: 1 (weak KDF) for both scenarios.
//
// Two stories, one per scenario (the e2e/AGENTS.md one-story rule — they do not
// share a boot):
//
//   vd1 — conflict compare → split → resolve → undo.
//     Reaches the Conflicts surface WITHOUT the two-device sync harness: a
//     conflict copy is nothing but a note whose frontmatter carries the managed
//     `conflict:` / `conflict_of:` markers (`markdown-dialect.md` §3.6.1), so
//     the pair is materialized through the production `note_create` IPC from the
//     page seat — the same composition the sync engine's materializer runs, via
//     the shared `buildConflictCopyContent` rather than a hand-rolled twin. A
//     `refresh()` then rebuilds the sidebar cache off disk, which is what feeds
//     `conflictRecordsByOriginal`. That keeps this scenario on the plain
//     tauri-driver harness: the diff surface is client-side and render-only
//     (SYNC-6), so a server would add boot cost and flake without adding proof.
//     What it does NOT skip is the sync-endpoint CONFIG — see
//     `DEAD_LOOPBACK_ENDPOINT` below; the resolve path branches on it.
//     Asserts: Compare opens the split view; the two columns carry the two
//     sides; the task-4 normalizer's suppressed fields (`updated:`, the conflict
//     markers) are absent from the rendered diff even though both bodies carry
//     them on disk; "Use this version" resolves from inside the compare surface
//     (copy promoted, original tombstoned — read back over page-seat IPC, not
//     inferred from the DOM); and the toast's Undo puts the conflict back.
//
//   vd2 — snapshot "compare against" selector.
//     Two forced snapshots (`note_snapshot_flush`, the coalesce-bypassing
//     close/lock-flush path — the 5-min autosave gate would otherwise leave a
//     fast test with one useless empty capture) plus a third live edit, so the
//     three states are distinguishable by marker. Default basis diffs the
//     selected snapshot against the CURRENT note; switching to "previous
//     snapshot" must recompute against the entry below it in the list. The
//     assertion is content-shaped, not positional: the v3 marker exists ONLY in
//     the live note, so its presence in the diff is exactly "the basis is
//     current" and its absence is "the basis moved".
//
// KDF: weak generator fixtures (legal — unlock reads params from vault.meta; no
// production-KDF story here). Note bodies are in-source scenario content, not
// credentials; the password is the VR-1-style in-source constant (SYNC-13
// applies to credentials, and none reaches any assert below).
//
// Validated per the e2e/AGENTS.md definition of done: green 3× consecutive,
// run ISOLATED (`./scripts/e2e-one.sh version-diff`) against the production
// `--no-bundle` binary. They are the first thing to drive the MYND-334 testid
// pass for real (`conflicts.compare`, `conflicts.compare-view`, `diff.view`,
// `diff.split`, `diff.line`, `snapshots.compare-against`).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  dismissImporterOffer,
  dismissImporterOfferIfPresent,
  ipcOk,
  openSettings,
  runPaletteAction,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
  createNote,
} from "./support/flows";
import { syncConfigSeed } from "./support/multi-device";
import { testIdSelector, type Element, type Session } from "./support/webdriver";
import { buildConflictCopyContent } from "../src/dialect";

/** A configured endpoint is part of the vd1 PRECONDITION, not decoration: a
 *  conflict copy only ever exists on a synced vault, and `deleteNoteRouted`
 *  reads this config to decide tombstone-vs-unlink. Without it "Use this
 *  version" hard-unlinks the original and Undo has nothing to restore. No
 *  server is started — nothing here talks to one (SYNC-6: the diff is
 *  client-side and render-only), and a dead loopback port refuses instantly. */
const DEAD_LOOPBACK_ENDPOINT = "http://127.0.0.1:1";
const PASSWORD_VD1 = "Qp9#xT4!nG7&wM2k-vd1";
const PASSWORD_VD2 = "Qp9#xT4!nG7&wM2k-vd2";
const IPC_TIMEOUT = 15_000;

// Distinctive ≥24-char lowercase-alnum tokens (the PS-1 needle-design rule,
// reused here for unambiguous substring asserts): one per side / version, so a
// rendered diff can be attributed to exactly one source body.
const MINE_MARKER = "conflictmineside7k2m9qx4w8e5rj";
const THEIRS_MARKER = "conflicttheirside5m9w8x2k4q7zlt";
const SHARED_LINE = "conflictsharedline3f6h1zn8c2vb5";
const SNAP_V1 = " versiondiffv1marker7k2m9qx4w8e";
const SNAP_V2 = " versiondiffv2marker5m9w8x2k4q7";
const SNAP_V3 = " versiondiffv3marker3f6h1zn8c2v";

/** The local ("mine") side of the conflict — the note the copy forked from. It
 *  carries an `updated:` stamp and a title so the normalizer under test has
 *  something real to suppress. */
const MINE_BODY = [
  "---",
  "title: Version Diff Conflict",
  "updated: 2026-07-30T10:00:00Z",
  "---",
  "",
  SHARED_LINE,
  `the divergent line reads ${MINE_MARKER} here`,
  "",
].join("\n");

/** The remote ("theirs") side: same note, one word different, and a DIFFERENT
 *  `updated:` stamp — the volatile field every real conflict differs on. */
const THEIRS_BODY = [
  "---",
  "title: Version Diff Conflict",
  "updated: 2026-07-31T11:22:33Z",
  "---",
  "",
  SHARED_LINE,
  `the divergent line reads ${THEIRS_MARKER} here`,
  "",
].join("\n");

/** Concatenated text of every split-mode cell on one side. */
async function columnText(session: Session, side: "left" | "right"): Promise<string> {
  const cells = await session.findElements(
    testIdSelector("diff.line", { "data-side": side }),
  );
  const texts = await Promise.all(cells.map((c) => c.textContent()));
  return texts.join("\n");
}

/** Read the `data-note-id` of the currently-selected sidebar row (the note
 *  `createNote` just created and left selected). */
async function selectedNoteId(s: Session): Promise<string> {
  const row = await s.waitForElement(
    testIdSelector("notes.row", { "aria-current": "true" }),
  );
  const id = await row.attribute("data-note-id");
  if (id === null || id === "") {
    throw new Error("selected notes.row carried no data-note-id");
  }
  return id;
}

describeE2E("vd1 conflict compare → split → resolve (MYND-334)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("compares a conflict copy against its original in a split diff and resolves from that surface", async () => {
    await scenario(
      "vd1-conflict-compare",
      {
        seed: (dir) => void seedVault(dir, { password: PASSWORD_VD1 }),
        seedConfig: syncConfigSeed(DEAD_LOOPBACK_ENDPOINT),
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, PASSWORD_VD1);
        await dismissImporterOffer(s);

        // Materialize the pair through production IPC. `buildConflictCopyContent`
        // is the shared composer the real materializer uses — no second
        // definition of what a conflict copy looks like.
        const originalId = (await ipcOk(
          s,
          "plugin:notes|note_create",
          { plaintext: MINE_BODY },
          IPC_TIMEOUT,
        )) as string;
        const copyId = (await ipcOk(
          s,
          "plugin:notes|note_create",
          { plaintext: buildConflictCopyContent(THEIRS_BODY, originalId) },
          IPC_TIMEOUT,
        )) as string;

        // The sidebar cache is built at editor mount; a reload is the real
        // primitive that makes it re-read the two notes just written.
        await s.refresh();
        await s.byTestId("editor.root", { timeoutMs: 30_000 });
        await dismissImporterOfferIfPresent(s);

        await openSettings(s, "sync");
        await s.byTestId("settings.sync-panel", { timeoutMs: 20_000 });

        // The copy is listed under its original's group; Compare is per-copy, so
        // scope the lookup to that row rather than taking a document-wide hit.
        const copyRow = testIdSelector("conflicts.copy", { "data-note-id": copyId });
        await s.waitForElement(copyRow, { timeoutMs: 20_000 });
        await (
          await s.waitForElement(`${copyRow} ${testIdSelector("conflicts.compare")}`)
        ).click();

        // ---- the compare surface: split diff of mine | theirs ----
        await s.waitForElement(
          testIdSelector("conflicts.compare-view", { "data-note-id": copyId }),
          { timeoutMs: 20_000 },
        );
        await s.byTestId("diff.split", { timeoutMs: 20_000 });
        expect(
          await (await s.byTestId("diff.view")).attribute("data-mode"),
          "the conflict surface renders the SPLIT mode",
        ).toBe("split");

        const left = await columnText(s, "left");
        const right = await columnText(s, "right");
        // Each side's divergent word lands in its own column, and only there.
        expect(left.includes(MINE_MARKER), "left column carries the local text").toBe(true);
        expect(left.includes(THEIRS_MARKER), "left column is not the remote text").toBe(false);
        expect(right.includes(THEIRS_MARKER), "right column carries the remote text").toBe(true);
        expect(right.includes(MINE_MARKER), "right column is not the local text").toBe(false);
        // The unchanged line is present on both sides (same → both columns).
        expect(left.includes(SHARED_LINE) && right.includes(SHARED_LINE)).toBe(true);
        // Normalization (task 4) is observable here: both bodies carry a
        // DIFFERENT `updated:` stamp and the copy carries the injected markers,
        // yet none of it reaches the rendered diff.
        const rendered = `${left}\n${right}`;
        expect(rendered.includes("conflict:"), "conflict markers are suppressed").toBe(false);
        expect(rendered.includes("conflict_of:"), "conflict_of is suppressed").toBe(false);
        expect(rendered.includes("updated:"), "the volatile updated: stamp is suppressed").toBe(
          false,
        );

        // ---- resolve from the compare surface: "Use this version" ----
        await (await s.byTestId("conflicts.take-this")).click();

        // With no conflict copy left, the surface falls back to its empty state.
        // That is also the BARRIER that makes the reads below poll-free: the
        // list only empties after `applyConflictVersion` + the sidebar re-read
        // resolved, so the disk state is already settled — which matters,
        // because the Undo toast below is on an 8 s clock.
        await s.byTestId("conflicts.empty", { timeoutMs: 20_000 });

        // Disk truth over page-seat IPC (the DOM only shows that the list
        // emptied): the copy is promoted, the original tombstoned.
        const promoted = (await ipcOk(
          s,
          "plugin:notes|note_read",
          { noteId: copyId },
          IPC_TIMEOUT,
        )) as string;
        const tombstoned = (await ipcOk(
          s,
          "plugin:notes|note_read",
          { noteId: originalId },
          IPC_TIMEOUT,
        )) as string;
        expect(promoted.includes(THEIRS_MARKER), "the remote version survived").toBe(true);
        expect(promoted.includes("conflict:"), "the survivor is no longer a conflict copy").toBe(
          false,
        );
        expect(tombstoned.includes("deleted:"), "the local original was tombstoned").toBe(true);

        // ---- Undo (the take-theirs toast action) restores the conflict ----
        await (await s.byTestId("editor.toast-action", { timeoutMs: 10_000 })).click();
        await s.waitForElement(copyRow, { timeoutMs: 20_000 });
        await s.waitUntil(
          async () => {
            const restored = (await ipcOk(
              s,
              "plugin:notes|note_read",
              { noteId: copyId },
              IPC_TIMEOUT,
            )) as string;
            const original = (await ipcOk(
              s,
              "plugin:notes|note_read",
              { noteId: originalId },
              IPC_TIMEOUT,
            )) as string;
            return restored.includes("conflict:") && !original.includes("deleted:") ? true : null;
          },
          { label: "undo re-marked the copy and un-tombstoned the original" },
        );
      },
    );
  });
});

describeE2E("vd2 snapshot compare-against selector (MYND-334)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("recomputes the snapshot diff against the previous snapshot when the basis changes", async () => {
    await scenario(
      "vd2-snapshot-compare-against",
      { seed: (dir) => void seedVault(dir, { password: PASSWORD_VD2 }) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, PASSWORD_VD2);
        await dismissImporterOffer(s);

        // Three distinguishable states: v1 (snapshot A), v1+v2 (snapshot B),
        // v1+v2+v3 (live). `note_snapshot_flush` force-captures past the 5-min
        // coalesce gate, which is the only way a fast test gets two
        // content-bearing snapshots.
        await createNote(s, "Version Diff Snapshots");
        await typeIntoEditor(s, SNAP_V1);
        await waitForSaved(s);
        const noteUuid = await selectedNoteId(s);
        await ipcOk(s, "plugin:notes|note_snapshot_flush", { noteId: noteUuid }, IPC_TIMEOUT);

        await typeIntoEditor(s, SNAP_V2);
        await waitForSaved(s);
        await ipcOk(s, "plugin:notes|note_snapshot_flush", { noteId: noteUuid }, IPC_TIMEOUT);

        await typeIntoEditor(s, SNAP_V3);
        await waitForSaved(s);

        await runPaletteAction(s, "snapshots.open", "snap");
        await s.byTestId("snapshots.panel", { timeoutMs: 20_000 });

        // Select the snapshot whose body is v1+v2 (not the live v3): its own
        // predecessor is the v1 capture, so the two bases are distinguishable.
        // Identified by body content via page-seat `snapshot_preview` — the
        // panel's pane is a diff, so it cannot identify a single snapshot.
        const rows = await s.byTestIdAll("snapshots.row");
        expect(rows.length).toBeGreaterThanOrEqual(2);
        let v2Row: Element | null = null;
        for (const row of rows) {
          const snapId = await row.attribute("data-snapshot-id");
          if (snapId === null) continue;
          const body = (await ipcOk(
            s,
            "plugin:snapshots|snapshot_preview",
            { noteId: noteUuid, snapshotUuid: snapId },
            IPC_TIMEOUT,
          )) as string;
          if (body.includes(SNAP_V2.trim()) && !body.includes(SNAP_V3.trim())) {
            v2Row = row;
            break;
          }
        }
        expect(v2Row, "a snapshot whose body is v1+v2 (no v3) is present").not.toBeNull();
        await v2Row!.click();

        // ---- default basis: the selected snapshot vs the CURRENT note ----
        const preview = testIdSelector("snapshots.preview", {
          "data-compare-against": "current",
        });
        await s.waitForElement(preview, { timeoutMs: 20_000 });
        await s.waitUntil(
          async () => {
            const [view] = await s.findElements(
              `${preview} ${testIdSelector("diff.view")}`,
            );
            if (view === undefined) return null;
            return (await view.textContent()).includes(SNAP_V3.trim()) ? true : null;
          },
          { label: "default basis diffs against the live note (v3 visible)" },
        );

        // ---- switch the basis to the previous snapshot ----
        await (await s.byTestId("snapshots.compare-against")).click();
        // The Select menu is portalled to document.body — a lookup scoped to the
        // panel would miss it.
        await (
          await s.waitForElement(
            testIdSelector("snapshots.compare-against-option", { "data-value": "previous" }),
            { timeoutMs: 10_000 },
          )
        ).click();

        const prevPreview = testIdSelector("snapshots.preview", {
          "data-compare-against": "previous",
        });
        await s.waitForElement(prevPreview, { timeoutMs: 20_000 });
        await s.waitUntil(
          async () => {
            const [view] = await s.findElements(
              `${prevPreview} ${testIdSelector("diff.view")}`,
            );
            if (view === undefined) return null;
            const text = await view.textContent();
            // v2 is what this snapshot ADDED over its predecessor; v3 belongs to
            // the live note alone, so its absence IS the recomputation.
            return text.includes(SNAP_V2.trim()) && !text.includes(SNAP_V3.trim()) ? true : null;
          },
          { label: "previous basis recomputed against the prior snapshot (v3 gone)" },
        );

        // Restore stays available under the second basis — a basis choice must
        // never take recovery away.
        await s.byTestId("snapshots.restore");
      },
    );
  });
});
