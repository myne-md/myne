// Whole-vault markdown export suite (MYND-211; engine `plugins/export`,
// UI VaultExportModal + Settings → Storage Export block).
//
// Pins the walk-away path through the production binary: the Settings →
// Storage Export block opens the three-phase modal whose setup phase
// carries the load-bearing egress sentence (FULL-literal equality), and
// the engine publishes a plaintext Obsidian-shape tree — folder shape
// from FM `folder:`, filenames from FM `title:` + `.md`, note bodies
// byte-verbatim — only at a user-chosen destination, refusing Myne's own
// storage with the distinct `DestinationNotAllowed` kind.
//
// Asserted-vs-deferred split (pragmatic, per the harness rules): the
// modal's SETUP phase is driven for real (block button → modal → literal
// sentence → scope radios → disabled confirm → free-exit Cancel). The
// running/summary phases are reachable only through the native folder
// dialog, which WebDriver cannot drive — those phases are Vitest-pinned
// (`tests/notes/vaultExportFlow.test.ts`), and the engine itself is
// exercised here from the page seat (`__TAURI_INTERNALS__.invoke` —
// production IPC, zero test hooks; the backup suite's pattern). The
// fixture carries no attachments, so the `attachments/` dir assertion is
// engine-Rust-tested territory, not repeated here.
//
// Note plaintext below is an in-source scenario constant (not a
// credential); SYNC-13 applies to passwords/phrases, which never appear
// in any assert.

import { expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  dismissImporterOffer,
  openSettings,
  pageSeatInvoke,
  unlockToEditor,
} from "./support/flows";
import { testIdSelector } from "./support/webdriver";
import { VAULT_EXPORT_PLAIN_TREE_SENTENCE } from "../src/lib/load-bearing-copy";

const NOTE_A_TITLE = "Vault Export Note A";
const NOTE_A_PLAINTEXT = `---
title: ${NOTE_A_TITLE}
folder: Projects/Sub/
---

Vault-export e2e body A — these bytes must survive verbatim.
`;

const NOTE_B_TITLE = "Vault Export Note B";
const NOTE_B_PLAINTEXT = `---
title: ${NOTE_B_TITLE}
---

Root note body B.
`;

describeE2E("vault-export (MYND-211)", () => {
  it("ve1: Export block → modal setup (literal egress sentence) → page-seat export publishes the verbatim tree; appdata destination refused", async () => {
    // Vault-count precondition: 1 (weak KDF). Seed in LaunchOptions, not in
    // the body: a body seed runs AFTER the window is up, so `vault_list` can
    // already have answered zero and routed to Welcome — the unlock screen
    // never appears and the scenario burns its budget waiting for it.
    let password = "";
    await scenario(
      "ve1-vault-export",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const { session } = app;

        await unlockToEditor(session, password);
      await dismissImporterOffer(session);

      // Seed two notes through the production create IPC (the editor UI
      // path is pinned by the notes suite; here the notes are fixture
      // material for the tree assertion).
      for (const plaintext of [NOTE_A_PLAINTEXT, NOTE_B_PLAINTEXT]) {
        const created = await pageSeatInvoke(
          session,
          "plugin:notes|note_create",
          { plaintext },
          30_000,
        );
        if (created.err !== undefined) {
          throw new Error("note_create failed: " + JSON.stringify(created.err));
        }
      }

      // Settings → Storage carries the Export block (MYND-211 task 3).
      await openSettings(session, "storage");
      const blockButton = await session.byTestId("vault-export.block-button");
      expect(await blockButton.enabled()).toBe(true);

      // Block button closes Settings and opens the export modal's setup
      // phase at the Editor level.
      await blockButton.click();
      await session.waitForGone(testIdSelector("settings.modal"));
      await session.byTestId("vault-export.modal");

      // Load-bearing egress copy — FULL-literal equality (SYNC-8).
      const sentence = await session.byTestId("vault-export.plain-tree-sentence");
      expect(await sentence.text()).toBe(VAULT_EXPORT_PLAIN_TREE_SENTENCE);

      // Scope radios: whole-vault is the default; the folder dropdown is
      // gated on the folder scope.
      const wholeRadio = await session.byTestId("vault-export.scope-whole");
      expect(await wholeRadio.attribute("data-checked")).toBe("true");
      const folderRadio = await session.byTestId("vault-export.scope-folder");
      expect(await folderRadio.attribute("data-checked")).toBe("false");

      // No destination picked yet → the primary "Export…" is disabled
      // (the native folder dialog is the only way to arm it).
      const confirm = await session.byTestId("vault-export.confirm");
      expect(await confirm.enabled()).toBe(false);

      // Cancel is a free exit — nothing invoked, nothing written.
      await (await session.byTestId("vault-export.cancel")).click();
      await session.waitForGone(testIdSelector("vault-export.modal"));

      // ---- engine, from the page seat (native dialog blocks the UI path) ----

      // Whole-vault export to a fresh destination (the NEW tree dir).
      const destination = path.join(app.dataHome, "Myne export e2e");
      const exported = await pageSeatInvoke(
        session,
        "plugin:export|vault_export_markdown",
        { vaultId: null, destination, scope: null },
        60_000,
      );
      if (exported.err !== undefined) {
        throw new Error("export failed: " + JSON.stringify(exported.err));
      }
      const summary = exported.ok as {
        notes: number;
        attachments: number;
        folders: number;
        excluded_trashed: number;
        excluded_snapshots: number;
      };
      expect(summary.notes).toBe(2);
      expect(summary.attachments).toBe(0);
      // Projects/ + Projects/Sub/ (ancestors materialized + counted).
      expect(summary.folders).toBe(2);
      expect(summary.excluded_trashed).toBe(0);

      // Tree shape: FM `folder:` → directories, FM `title:` + `.md` →
      // filenames; bodies byte-verbatim (no embeds → no rewrite).
      const noteAPath = path.join(
        destination,
        "Projects",
        "Sub",
        `${NOTE_A_TITLE}.md`,
      );
      const noteBPath = path.join(destination, `${NOTE_B_TITLE}.md`);
      expect(fs.existsSync(noteAPath)).toBe(true);
      expect(fs.existsSync(noteBPath)).toBe(true);
      expect(fs.readFileSync(noteAPath, "utf8")).toBe(NOTE_A_PLAINTEXT);
      expect(fs.readFileSync(noteBPath, "utf8")).toBe(NOTE_B_PLAINTEXT);
      // No attachments in this fixture → no attachments/ dir is created.
      expect(fs.existsSync(path.join(destination, "attachments"))).toBe(false);

      // Folder-subtree scope: only the subtree's notes, relativized.
      const subtreeDestination = path.join(app.dataHome, "Myne export subtree");
      const subtree = await pageSeatInvoke(
        session,
        "plugin:export|vault_export_markdown",
        { vaultId: null, destination: subtreeDestination, scope: "Projects/" },
        60_000,
      );
      if (subtree.err !== undefined) {
        throw new Error("subtree export failed: " + JSON.stringify(subtree.err));
      }
      expect((subtree.ok as { notes: number }).notes).toBe(1);
      expect(
        fs.existsSync(path.join(subtreeDestination, "Sub", `${NOTE_A_TITLE}.md`)),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(subtreeDestination, `${NOTE_B_TITLE}.md`)),
      ).toBe(false);

      // Destination inside Myne's own storage → the distinct
      // `DestinationNotAllowed` rejection (PRD story 11), nothing written.
      const forbidden = path.join(app.appDataDir, "vaults", "plain-tree");
      const rejected = await pageSeatInvoke(
        session,
        "plugin:export|vault_export_markdown",
        { vaultId: null, destination: forbidden, scope: null },
        60_000,
      );
      const rejectedErr = rejected.err as { kind?: string } | undefined;
      expect(rejectedErr?.kind).toBe("DestinationNotAllowed");
      expect(fs.existsSync(forbidden)).toBe(false);
    });
  });
});
