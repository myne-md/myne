// "Clean unused attachments" suite (MYND-171; backend tasks 1–3, UI tasks
// 4–5). Vault-count precondition: 1.
//
// Pins the cleanup flow through the production binary end-to-end: the
// attachments library's "Clean unused" CTA runs the authoritative
// zero-reference scan, the review dialog lists exactly the unused set
// (excluding a still-referenced attachment), Confirm performs the real
// cryptographic erase, and re-running on a now-clean vault surfaces the
// "nothing to clean" notice instead of a dialog.
//
// What is driven vs. asserted:
//   - SETUP is page-seat IPC (`pageSeatInvoke` — production IPC, zero test
//     hooks; the note-export precedent), because attachment import goes
//     through a native file picker WebDriver can't drive. Two attachments
//     are imported as inline bytes (one referenced by a created note, one
//     never inserted), so the on-disk state is real.
//   - The CTA → dialog → confirm → summary path is REAL UI driving.
//   - The post-erase catalog is re-read via page-seat `catalog_list` to
//     assert the referenced attachment survived and the unused one is gone.
//
// SYNC-13: attachment-ids + note bodies are scenario content, not
// credentials; no password/phrase appears in any assert.
//
// KDF: weak generator fixtures (unlock reads params from vault.meta).
//
// ⚠️ NEW SCENARIO — authored but NOT yet validated in the container. Per
// `e2e/CLAUDE.md` definition of done it must go green 3× consecutive via
// `./scripts/e2e-local.sh` before merge; it also introduces the first
// command-palette + attachments-library driving (new testids
// `palette.input` / `palette.option` / `attachments.clean-unused-cta` /
// `clean-unused.*`), so the palette-open chord + selectors want a real run.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import {
  dismissImporterOffer,
  pageSeatInvoke,
  runPaletteAction,
  unlockToEditor,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

const IPC_TIMEOUT = 15_000;

/** A minimal PNG (8-byte signature → sniffs image/png) tagged with a
 *  distinguishing byte so distinct tags yield distinct content-addressed
 *  ids (identical bytes would dedup to one blob). */
function pngBytes(tag: number): number[] {
  return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, tag];
}

async function importBytes(
  s: Session,
  tag: number,
  filename: string,
): Promise<string> {
  const r = await pageSeatInvoke(
    s,
    "plugin:attachments|attachment_import",
    { source: { kind: "bytes", bytes: pngBytes(tag), filename } },
    IPC_TIMEOUT,
  );
  expect(r.err, "attachment_import should succeed").toBeUndefined();
  return (r.ok as { id: string }).id;
}

async function catalogIds(s: Session): Promise<string[]> {
  const r = await pageSeatInvoke(s, "plugin:attachments|catalog_list", {}, IPC_TIMEOUT);
  expect(r.err, "catalog_list should succeed").toBeUndefined();
  return (r.ok as Array<{ id: string }>).map((e) => e.id);
}

describeE2E("attachment cleanup (MYND-171)", () => {
  it("ac1 — clean unused removes the orphan, keeps the referenced, then reports nothing to clean", async () => {
    let seeded: SeededVault;
    await scenario(
      "ac1-clean-unused",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);

        // ---- setup (page-seat IPC): A referenced by a note, B unused ----
        const idA = await importBytes(s, 1, "referenced.png");
        const idB = await importBytes(s, 2, "orphan.png");
        const noteRes = await pageSeatInvoke(
          s,
          "plugin:notes|note_create",
          { plaintext: `![[att:${idA}]]` },
          IPC_TIMEOUT,
        );
        expect(noteRes.err, "note_create should succeed").toBeUndefined();

        // ---- open the library via the command palette ----
        await runPaletteAction(s, "attachments.open", "attach");
        await (await s.byTestId("attachments.clean-unused-cta")).click();

        // ---- review dialog: exactly one unused row (B), not A ----
        await s.byTestId("clean-unused.confirm");
        const rows = await s.byTestIdAll("clean-unused.row");
        expect(rows.length).toBe(1);

        // ---- confirm the erase, wait for the summary ----
        await (await s.byTestId("clean-unused.confirm")).click();
        const summary = await s.byTestId("clean-unused.summary");
        // `textContent()` (not the nonexistent `getText`, and not `text()` which
        // drops nested-child copy in this driver) — the summary nests its count.
        expect(await summary.textContent()).toContain("Removed 1");
        await (await s.byTestId("clean-unused.close")).click();
        await s.waitForGone(testIdSelector("clean-unused.summary"));

        // ---- the referenced attachment survived; the unused one is gone ----
        const ids = await catalogIds(s);
        expect(ids).toContain(idA);
        expect(ids).not.toContain(idB);

        // ---- re-running now finds nothing → notice, not a dialog ----
        await (await s.byTestId("attachments.clean-unused-cta")).click();
        await s.byTestId("attachments.clean-notice");
        await expect(
          s.byTestId("clean-unused.confirm", { timeoutMs: 1_000 }),
        ).rejects.toThrow();
      },
    );
  });
});
