// Workspace-state suite (MYND-257, e2e-expansion). Pins the
// `vault.workspace` (MYW1, protocol.md § 9.7) tab/split-pane layout
// round-trip through the REAL editor UI:
//
//   ws1 — a multi-tab / split-pane layout built by driving note rows
//         (plain click = reuse the focused tab; middle-click = new tab;
//         Alt-click = open to the side / split) is persisted on the Lock
//         CTA and RESTORED on the re-unlocked editor, with at-rest asserts
//         on the MYW1 blob (magic + version bytes + no plaintext note-id /
//         title residue).
//   ws2 — per-vault isolation: two vaults each restore their OWN layout,
//         and neither blob carries the other's note-ids.
//
// Reload mechanism — why Lock → unlock, not `refresh()`: `vault.workspace`
// is persisted to disk ONLY on graceful exit (the Lock CTA / window-close /
// app QUIT). Per layout change the frontend merely STAGES the descriptor in
// the host's RAM (`workspace_stage`) so the blob's mtime never becomes an
// editor-activity log (grill 2026-06-01); `workspace_read` reads disk only.
// A `refresh()` triggers none of those graceful-exit hooks, so it would NOT
// persist the built layout — the faithful round-trip is the Lock CTA's
// flush + re-unlock (the same shape `notes.e2e.ts` nc1 uses for note body).
//
// Multi-vault note (ws2): a vault SWITCH does not persist `vault.workspace`
// either (the switch's param-less `vault_lock` clears the staged descriptor
// without flushing it — filed as a separate gap). So each vault's layout is
// committed via its own Lock CTA before the switcher navigates away.
//
// KDF: weak generator fixtures throughout (SYNC-9 — params are
// vault.meta-resident). SYNC-13: note titles/ids are in-source scenario
// constants (not credentials); the residue assertion's failure output is a
// COUNT, never the needle text.

import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, seedVaults } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  noteRow,
  noteRowIds,
  rowMenuPick,
  selectPickerRow,
  switchToVault,
  unlockToEditor,
} from "./support/flows";
import { type Session, testIdSelector } from "./support/webdriver";


// Distinct note titles — single lowercase-alnum tokens (the residue
// needle-design rule: tokenizer-survivable, ≥24 chars).
const WS1_TITLES = [
  "ws1notealfa7k2m9qx4w8e5rj0aa",
  "ws1notebravo3f6h1zn8c2vb5kk0",
  "ws1notecharlie9d4t7yp2mq6xs1",
];
const WS2_A_TITLES = ["ws2avaultnote1k8m3qx7w2e9rj5a", "ws2avaultnote2f4h6zn1c8vb3kk9"];
const WS2_B_TITLES = ["ws2bvaultnote1d7t4yp9mq2xs6bb", "ws2bvaultnote2g3j5wk8rh1nc4vv"];

type PaneSig = { tabs: string[]; active: string | null };
type LayoutSig = { panes: PaneSig[]; focusedIndex: number };

// ── DOM oracles ──────────────────────────────────────────────────────────

/** Capture the structural layout: panes in DOM (left-to-right) order, each
 *  with its ordered tab note-ids + the active one, plus which pane is
 *  focused. Pane UUIDs are deliberately NOT compared — DOM order + tab
 *  membership is the stable signature across a persist/restore round-trip. */
async function readLayout(session: Session): Promise<LayoutSig> {
  const paneEls = await session.byTestIdAll("editor.pane");
  const panes: PaneSig[] = [];
  let focusedIndex = -1;
  for (let i = 0; i < paneEls.length; i++) {
    const paneId = await paneEls[i].attribute("data-pane-id");
    if ((await paneEls[i].attribute("data-focused")) === "true") focusedIndex = i;
    const tabEls = await session.findElements(
      `${testIdSelector("editor.pane", { "data-pane-id": paneId ?? "" })} ` +
        testIdSelector("editor.tab"),
    );
    const tabs: string[] = [];
    let active: string | null = null;
    for (const t of tabEls) {
      // A tab carries its workspace-item key in `data-tab-id` (Saved Views #4
      // generalized tabs to `note | view` items: `data-note-id` → `data-tab-id`,
      // value `note:<id>` / `view:<id>`). These layout scenarios use note tabs
      // only — strip the `note:` prefix back to the bare note-id the sig wants.
      const raw = (await t.attribute("data-tab-id")) ?? "";
      const id = raw.startsWith("note:") ? raw.slice("note:".length) : raw;
      tabs.push(id);
      if ((await t.attribute("data-active")) === "true") active = id;
    }
    panes.push({ tabs, active });
  }
  return { panes, focusedIndex };
}

/** Poll until the live layout deep-equals `expected`. Doubles as both the
 *  build settle-wait and the restore assertion. */
async function waitForLayout(
  session: Session,
  expected: LayoutSig,
  label: string,
): Promise<void> {
  const want = JSON.stringify(expected);
  await session.waitUntil(
    async () => (JSON.stringify(await readLayout(session)) === want ? true : null),
    { label, timeoutMs: 15_000 },
  );
}

// Note-row driving lives in `support/flows.ts` (noteRowIds / noteRow /
// rowMenuPick), shared with the cover suite's split scenario.

// ── at-rest ──────────────────────────────────────────────────────────────

function workspaceBlob(appDataDir: string, vaultId: string): Buffer {
  return readFileSync(join(appDataDir, "vaults", vaultId, "vault.workspace"));
}

/** MYW1 header contract: magic + protocol/format version bytes + a
 *  non-trivial encrypted body (header is 34 bytes; § 9.7.1). */
function assertWorkspaceHeader(blob: Buffer): void {
  expect(blob.subarray(0, 4).toString("latin1")).toBe("MYW1");
  expect(blob.length).toBeGreaterThan(34);
  expect(blob[4]).toBe(0x01); // protocol_version
  expect(blob[5]).toBe(0x02); // workspace_format_version (named-workspaces descriptor)
}

/** Count of needles found verbatim in the blob (UTF-8 or UTF-16LE). Returns
 *  a COUNT, never the needle — SYNC-13-safe failure output. */
function residueCount(blob: Buffer, needles: string[]): number {
  let hits = 0;
  for (const n of needles) {
    if (blob.includes(Buffer.from(n, "utf8")) || blob.includes(Buffer.from(n, "utf16le"))) {
      hits += 1;
    }
  }
  return hits;
}

describeE2E("ws1 layout restore + at-rest (MYND-257)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("a multi-tab / split-pane layout survives Lock → unlock; the MYW1 blob leaks no note-id", async () => {
    let password = "";
    let vaultId = "";
    await scenario(
      "ws1-layout-restore",
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

        // Three notes, then build: pane-0 = [n0, n1] (active n1), split to
        // the side → pane-1 = [n2] (active, focused).
        for (const t of WS1_TITLES) await createNote(s, t);
        const [n0, n1, n2] = await noteRowIds(s, 3);

        await (await noteRow(s, n0)).click(); // openInFocused → pane-0 = [n0]
        await rowMenuPick(s, n1, "open-in-new-tab"); // new tab → [n0, n1]
        await rowMenuPick(s, n2, "open-to-side"); // open to side → split

        const built: LayoutSig = {
          panes: [
            { tabs: [n0, n1], active: n1 },
            { tabs: [n2], active: n2 },
          ],
          focusedIndex: 1,
        };
        await waitForLayout(s, built, "ws1 layout built (2 panes)");

        // Persist via the Lock CTA (the graceful-exit flush), land on unlock.
        await (await s.byTestId("editor.lock-cta")).click();
        await s.byTestId("unlock.password-input", { timeoutMs: 20_000 });

        // At-rest: the blob is on disk now (written by the lock flush).
        const blob = workspaceBlob(app.appDataDir, vaultId);
        assertWorkspaceHeader(blob);
        // No plaintext residue of the layout's note-ids (the blob's own
        // content) nor any note title. The restore below proves the blob
        // genuinely encodes all three ids, so a zero here is a real
        // encryption proof, not a vacuous scan of an empty/default blob.
        expect(residueCount(blob, [n0, n1, n2, ...WS1_TITLES])).toBe(0);

        // Re-unlock → the layout is restored from disk.
        await unlockToEditor(s, password);
        await waitForLayout(s, built, "ws1 layout restored after re-unlock");
      },
    );
  });
});

describeE2E("ws2 per-vault layout isolation (MYND-257)", () => {
  // Vault-count precondition: 2 (weak KDF). pf3-shaped: A's layout never
  // bleeds into B. Each vault is committed via its own Lock CTA (the switch
  // does not persist workspace), then navigated via the switcher.
  it("each vault restores its own layout; neither MYW1 blob carries the other's note-ids", async () => {
    let a!: { vaultId: string; password: string };
    let b!: { vaultId: string; password: string };
    await scenario(
      "ws2-vault-isolation",
      {
        seed: (dir) => {
          const [va, vb] = seedVaults(dir, { count: 2 });
          a = va;
          b = vb;
        },
      },
      async (app) => {
        const s = app.session;

        // Vault A: a 2-pane split layout. Commit it (Lock → re-unlock so the
        // editor — hence the switcher — is reachable again).
        await selectPickerRow(s, a.vaultId);
        await unlockToEditor(s, a.password);
        await dismissImporterOffer(s);
        for (const t of WS2_A_TITLES) await createNote(s, t);
        const [a0, a1] = await noteRowIds(s, 2);
        await (await noteRow(s, a0)).click();
        await rowMenuPick(s, a1, "open-to-side"); // open to side → split
        const layoutA: LayoutSig = {
          panes: [
            { tabs: [a0], active: a0 },
            { tabs: [a1], active: a1 },
          ],
          focusedIndex: 1,
        };
        await waitForLayout(s, layoutA, "ws2 vault-A layout built");
        await (await s.byTestId("editor.lock-cta")).click();
        await s.byTestId("unlock.password-input", { timeoutMs: 20_000 });
        await unlockToEditor(s, a.password);
        await waitForLayout(s, layoutA, "ws2 vault-A restored");

        // Switch to B, build a STRUCTURALLY DIFFERENT layout (1 pane, 2
        // tabs), commit it the same way.
        await switchToVault(s, b.vaultId);
        await unlockToEditor(s, b.password);
        for (const t of WS2_B_TITLES) await createNote(s, t);
        const [b0, b1] = await noteRowIds(s, 2);
        await (await noteRow(s, b0)).click();
        await rowMenuPick(s, b1, "open-in-new-tab"); // new tab
        const layoutB: LayoutSig = {
          panes: [{ tabs: [b0, b1], active: b1 }],
          focusedIndex: 0,
        };
        await waitForLayout(s, layoutB, "ws2 vault-B layout built");
        await (await s.byTestId("editor.lock-cta")).click();
        await s.byTestId("unlock.password-input", { timeoutMs: 20_000 });
        await unlockToEditor(s, b.password);
        await waitForLayout(s, layoutB, "ws2 vault-B restored");

        // The bleed test: switch back to A — it must restore A's OWN 2-pane
        // layout, not B's single pane.
        await switchToVault(s, a.vaultId);
        await unlockToEditor(s, a.password);
        await waitForLayout(s, layoutA, "ws2 vault-A still isolated after B");

        // At-rest cross-residue: neither blob carries the other's note-ids.
        const blobA = workspaceBlob(app.appDataDir, a.vaultId);
        const blobB = workspaceBlob(app.appDataDir, b.vaultId);
        assertWorkspaceHeader(blobA);
        assertWorkspaceHeader(blobB);
        expect(residueCount(blobA, [b0, b1, ...WS2_B_TITLES])).toBe(0);
        expect(residueCount(blobB, [a0, a1, ...WS2_A_TITLES])).toBe(0);
      },
    );
  });
});
