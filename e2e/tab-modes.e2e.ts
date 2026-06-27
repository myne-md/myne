// Tab-modes suite (MYND-319 stacked + MYND-320 pinned). Drives the two
// tab-mode behaviors through the REAL editor UI:
//
//   tm1 — PIN (MYND-320): right-click a tab → Pin; the tab gains its pin
//         affordance (data-pinned) and loses its × close. Navigating (a
//         sidebar click that would normally REUSE the focused pane's active
//         slot) opens a NEW tab in the same pane instead — the pinned tab
//         survives. The layout persists across a Lock → re-unlock round-trip
//         (the MYW1 graceful-exit flush), proving the additive omit-when-
//         default descriptor field rides the engine-opaque blob (SYNC-4).
//   tm2 — STACKED (MYND-319): the "Toggle stacked tabs" palette action flips
//         the focused pane to the stacked deck (data-stacked / the
//         editor.tab-deck container) and back; the state persists across a
//         Lock → re-unlock.
//
// Reload mechanism — why Lock → unlock, not refresh(): vault.workspace is
// persisted to disk ONLY on graceful exit (the Lock CTA / window-close /
// quit). Per layout change the frontend merely STAGES the descriptor in the
// host's RAM (workspace_stage) so the blob's mtime never becomes an editor-
// activity log (grill 2026-06-01). Same shape as workspace-state.e2e.ts.
//
// Pin/stacked are NOT load-bearing crypto (SYNC-4): they ride the existing
// MYW1 AEAD envelope as additive descriptor fields — no new magic / KEK /
// AAD / format-version bump. The at-rest header asserts the version byte is
// UNCHANGED (workspace_format_version still 0x01).
//
// KDF: weak generator fixtures (SYNC-9 — params are vault.meta-resident).
// SYNC-13: note titles/ids are in-source scenario constants; no residue
// assertion needed here (workspace-state.e2e.ts owns the at-rest leak proof).

import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  runPaletteAction,
  unlockToEditor,
} from "./support/flows";
import { type Element, type Session, testIdSelector } from "./support/webdriver";

// Distinct note titles — single lowercase-alnum tokens (residue needle rule).
const TM_TITLES = [
  "tmnotealpha7k2m9qx4w8e5rj0aa",
  "tmnotebravo3f6h1zn8c2vb5kk0",
  "tmnotecharlie9d4t7yp2mq6xs1",
];

// ── helpers ────────────────────────────────────────────────────────────────

/** The sidebar rows' note-ids, in DOM order, once exactly `expected` exist. */
async function noteRowIds(session: Session, expected: number): Promise<string[]> {
  const rows = await session.waitUntil(
    async () => {
      const found = await session.byTestIdAll("notes.row");
      return found.length === expected ? found : null;
    },
    { label: `${expected} note rows`, timeoutMs: 15_000 },
  );
  return Promise.all(rows.map(async (r) => (await r.attribute("data-note-id")) ?? ""));
}

async function row(session: Session, noteId: string): Promise<Element> {
  return session.waitForElement(testIdSelector("notes.row", { "data-note-id": noteId }));
}

/** Tab elements in the (single) focused pane, in DOM order. */
async function tabs(session: Session): Promise<Element[]> {
  return session.byTestIdAll("editor.tab");
}

/** The set of tab note-ids currently open (note: prefix stripped). */
async function openTabIds(session: Session): Promise<string[]> {
  const els = await tabs(session);
  return Promise.all(
    els.map(async (t) => {
      const raw = (await t.attribute("data-tab-id")) ?? "";
      return raw.startsWith("note:") ? raw.slice("note:".length) : raw;
    }),
  );
}

/** Whether the tab carrying `noteId` reports `data-pinned="true"`. */
async function tabPinned(session: Session, noteId: string): Promise<boolean> {
  const el = await session.waitForElement(
    testIdSelector("editor.tab", { "data-tab-id": `note:${noteId}` }),
  );
  return (await el.attribute("data-pinned")) === "true";
}

/** Right-click the tab for `noteId` and click its Pin/Unpin menu item. */
async function pinViaTabMenu(
  session: Session,
  noteId: string,
  itemId: "tab.pin" | "tab.unpin",
): Promise<void> {
  const tab = await session.waitForElement(
    testIdSelector("editor.tab", { "data-tab-id": `note:${noteId}` }),
  );
  await tab.rightClick();
  const item = await session.waitForElement(
    testIdSelector("notes.context-menu-item", { "data-item-id": itemId }),
  );
  await item.click();
}

function workspaceBlob(appDataDir: string, vaultId: string): Buffer {
  return readFileSync(join(appDataDir, "vaults", vaultId, "vault.workspace"));
}

/** MYW1 header contract — magic + version bytes (§9.7.1). protocol_version
 *  stays 0x01; workspace_format_version is 0x02 (the named-workspaces
 *  descriptor, bumped 0x01→0x02 in MYW1 — protocol/src/workspace_blob.rs
 *  WORKSPACE_BLOB_FORMAT_VERSION). The pin/stacked tab modes ride that same
 *  descriptor and do NOT bump it further. */
function assertWorkspaceHeader(blob: Buffer): void {
  expect(blob.subarray(0, 4).toString("latin1")).toBe("MYW1");
  expect(blob.length).toBeGreaterThan(34);
  expect(blob[4]).toBe(0x01); // protocol_version
  expect(blob[5]).toBe(0x02); // workspace_format_version (named-workspaces descriptor)
}

// ── tm1: pin → new-tab-on-nav + close-guard + persistence ────────────────────

describeE2E("tm1 pin (MYND-320): new-tab-on-nav + persistence", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("a pinned tab gains its affordance, survives a navigate (new tab opens), and persists", async () => {
    let password = "";
    let vaultId = "";
    await scenario(
      "tm1-pin",
      {
        seed: (dir) => {
          const v = seedVault(dir);
          password = v.password;
          vaultId = v.vaultId;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        for (const t of TM_TITLES) await createNote(s, t);
        const [n0, n1, n2] = await noteRowIds(s, 3);

        // Open n0 into the focused pane's active slot (single tab).
        await (await row(s, n0)).click();
        await s.waitUntil(
          async () => ((await openTabIds(s)).join(",") === n0 ? true : null),
          { label: "tm1 single tab [n0]", timeoutMs: 15_000 },
        );

        // Pin n0 via its right-click menu → the tab reports data-pinned=true.
        await pinViaTabMenu(s, n0, "tab.pin");
        await s.waitUntil(async () => ((await tabPinned(s, n0)) ? true : null), {
          label: "tm1 n0 pinned",
          timeoutMs: 15_000,
        });

        // Navigate (sidebar click on n1) — normally REUSES the active slot,
        // but n0 is pinned, so a NEW tab opens and n0 survives.
        await (await row(s, n1)).click();
        await s.waitUntil(
          async () =>
            (await openTabIds(s)).join(",") === [n0, n1].join(",") ? true : null,
          { label: "tm1 new tab [n0, n1] (pinned n0 preserved)", timeoutMs: 15_000 },
        );

        // Persist via the Lock CTA (graceful-exit flush), land on unlock.
        await (await s.byTestId("editor.lock-cta")).click();
        await s.byTestId("unlock.password-input", { timeoutMs: 20_000 });

        // At-rest: MYW1 header intact, version byte NOT bumped (SYNC-4).
        assertWorkspaceHeader(workspaceBlob(app.appDataDir, vaultId));

        // Re-unlock → the layout (incl. the pin) is restored from disk.
        await unlockToEditor(s, password);
        await s.waitUntil(
          async () =>
            (await openTabIds(s)).join(",") === [n0, n1].join(",") ? true : null,
          { label: "tm1 layout restored after re-unlock", timeoutMs: 15_000 },
        );
        await s.waitUntil(async () => ((await tabPinned(s, n0)) ? true : null), {
          label: "tm1 n0 still pinned after restore",
          timeoutMs: 15_000,
        });
        // n1 is NOT pinned (omit-when-default).
        expect(await tabPinned(s, n1)).toBe(false);

        // Unpin restores normal behavior: navigating from n1 (active, unpinned)
        // reuses its slot → n2 replaces n1.
        await (await row(s, n2)).click();
        await s.waitUntil(
          async () =>
            (await openTabIds(s)).join(",") === [n0, n2].join(",") ? true : null,
          { label: "tm1 unpinned nav reuses slot [n0, n2]", timeoutMs: 15_000 },
        );
      },
    );
  });
});

// ── tm2: stacked toggle (palette) + persistence ──────────────────────────────

describeE2E("tm2 stacked (MYND-319): palette toggle + persistence", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("the stacked-tabs palette action flips the focused pane's layout and persists", async () => {
    let password = "";
    let vaultId = "";
    await scenario(
      "tm2-stacked",
      {
        seed: (dir) => {
          const v = seedVault(dir);
          password = v.password;
          vaultId = v.vaultId;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        for (const t of TM_TITLES) await createNote(s, t);
        const [n0, n1] = await noteRowIds(s, 3);
        await (await row(s, n0)).click();
        await (await row(s, n1)).middleClick(); // a 2nd tab (MYND-367 new-tab)

        // The strip starts NOT stacked.
        const strip = await s.byTestId("editor.tab-strip");
        expect(await strip.attribute("data-stacked")).toBe("false");

        // Run the palette action → the focused pane goes stacked (the deck
        // container appears + data-stacked flips true).
        await runPaletteAction(s, "view.toggle-stacked-tabs", "stacked");
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("editor.tab-strip")).attribute("data-stacked")) ===
            "true"
              ? true
              : null,
          { label: "tm2 stacked on", timeoutMs: 15_000 },
        );
        await s.byTestId("editor.tab-deck", { timeoutMs: 15_000 });

        // Persist + restore: the stacked flag survives a Lock → re-unlock.
        await (await s.byTestId("editor.lock-cta")).click();
        await s.byTestId("unlock.password-input", { timeoutMs: 20_000 });
        assertWorkspaceHeader(workspaceBlob(app.appDataDir, vaultId));

        await unlockToEditor(s, password);
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("editor.tab-strip")).attribute("data-stacked")) ===
            "true"
              ? true
              : null,
          { label: "tm2 stacked restored after re-unlock", timeoutMs: 15_000 },
        );

        // Toggle back off → data-stacked returns to false.
        await runPaletteAction(s, "view.toggle-stacked-tabs", "stacked");
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("editor.tab-strip")).attribute("data-stacked")) ===
            "false"
              ? true
              : null,
          { label: "tm2 stacked off", timeoutMs: 15_000 },
        );
      },
    );
  });
});
