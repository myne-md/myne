// Named, switchable workspaces E2E (named-workspaces / MYND-308).
//
// Pins the named-workspace switcher flow end-to-end against the production
// binary:
//   nw1 — the bottom-bar workspace switcher opens to the single "Default" slot
//         (active); "Save current as…" + a name prompt creates a SECOND slot
//         (two items in the dropdown); switching to the new slot makes IT the
//         active workspace (the active label + the per-item data-active flip).
//
// Slot names + layouts ride the engine-opaque MYW1 0x02 {slots, active}
// descriptor; the active-slot pointer rides vault.prefs (MYP1 active_workspace).
// This drives the real save-as / switch IPC + the coalesced-write staging path,
// no test hook. (The save-as name prompt is the in-WebView promptForText modal —
// `window.prompt` is a no-op in the Tauri WebView — testid prefix
// "workspace-prompt".)
//
// VERIFICATION STATUS (editor-modes-trio, 2026-06-17): authored to the harness
// conventions but NOT yet run on this dev platform (macOS; the suite is
// Linux/tauri-driver only — `pnpm test:e2e` self-skips off-platform). Definition
// of done per e2e/AGENTS.md is "green 3× in the container"
// (./scripts/e2e-local.sh) and MUST be met before merge. Run ISOLATED per the
// full-suite-contamination note (e2e-full-suite-contamination memory).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import { dismissImporterOffer, unlockToEditor } from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

/** The visible label on the workspace-switcher toggle (the active slot name).
 *  The label nests in a child <span> the W3C getText drops — read textContent. */
async function activeWorkspaceLabel(s: Session): Promise<string> {
  return (await s.byTestId("editor.workspace-switcher.toggle")).textContent();
}

/** Open the workspace-switcher dropdown and wait for its menu. Clicking the
 *  toggle opens it from the closed state — where each step below starts. */
async function openSwitcher(s: Session): Promise<void> {
  await (await s.byTestId("editor.workspace-switcher.toggle")).click();
  await s.byTestId("editor.workspace-switcher.menu");
}

describeE2E("nw1 named-workspace save-as + switch (named-workspaces, MYND-308)", () => {
  // Vault-count precondition: 1 (weak KDF). A fresh vault has a single
  // "Default" workspace slot.
  it("saves the current layout as a new named slot, switches, and renames a slot", async () => {
    let password = "";
    await scenario(
      "nw1-workspace-save-switch",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // The switcher exists and shows the single default slot active.
        await s.byTestId("editor.workspace-switcher");
        expect(await activeWorkspaceLabel(s)).toContain("Default");

        // Open the dropdown → exactly one slot item (the active "Default").
        await openSwitcher(s);
        await s.waitUntil(
          async () =>
            (await s.byTestIdAll("editor.workspace-switcher.item")).length === 1 ? true : null,
          { label: "one slot item (Default) on a fresh vault" },
        );

        // "Save current as…" → the in-WebView name prompt.
        await (await s.byTestId("editor.workspace-switcher.save-as")).click();
        const promptInput = await s.byTestId("workspace-prompt.input");
        await promptInput.sendKeys("research");
        await (await s.byTestId("workspace-prompt.confirm")).click();

        // The new slot becomes active (label flips to "research") and the
        // dropdown now lists TWO slots.
        await s.waitUntil(async () => ((await activeWorkspaceLabel(s)).includes("research") ? true : null), {
          label: "save-as activates the new 'research' slot",
        });
        await openSwitcher(s);
        await s.waitUntil(
          async () =>
            (await s.byTestIdAll("editor.workspace-switcher.item")).length === 2 ? true : null,
          { label: "two slots after save-as (Default + research)" },
        );

        // Switch back to the "Default" slot → it becomes active (its item flips
        // data-active="true") and the toggle label returns to "Default".
        const rows = await s.byTestIdAll("editor.workspace-switcher.item");
        let defaultRow = rows[0];
        for (const r of rows) {
          if ((await r.textContent()).includes("Default")) {
            defaultRow = r;
            break;
          }
        }
        await defaultRow.click();
        await s.waitUntil(async () => ((await activeWorkspaceLabel(s)).includes("Default") ? true : null), {
          label: "switching back activates the Default slot",
        });

        // The active slot's item carries data-active="true" in the dropdown.
        await openSwitcher(s);
        await s.waitUntil(async () => {
          const items = await s.findElements(
            testIdSelector("editor.workspace-switcher.item", { "data-active": "true" }),
          );
          if (items.length !== 1) return null;
          return (await items[0].textContent()).includes("Default") ? true : null;
        }, { label: "Default is the single active slot" });

        // Rename the non-active "research" slot via its per-row pencil → the
        // in-WebView prompt (pre-filled + selected, so typing replaces). The
        // active slot ("Default") is unaffected by renaming another slot.
        const allItems = await s.byTestIdAll("editor.workspace-switcher.item");
        let researchId = "";
        for (const r of allItems) {
          if ((await r.textContent()).includes("research")) {
            researchId = (await r.attribute("data-workspace-id")) ?? "";
            break;
          }
        }
        const renameBtns = await s.findElements(
          testIdSelector("editor.workspace-switcher.rename", { "data-workspace-id": researchId }),
        );
        await renameBtns[0].click();
        const renameInput = await s.byTestId("workspace-prompt.input");
        await renameInput.sendKeys("writing");
        await (await s.byTestId("workspace-prompt.confirm")).click();

        // Reopen → the slot now reads "writing" (no "research"); "Default" stays active.
        await openSwitcher(s);
        await s.waitUntil(async () => {
          const items = await s.byTestIdAll("editor.workspace-switcher.item");
          const texts = await Promise.all(items.map((i) => i.textContent()));
          return texts.some((t) => t.includes("writing")) &&
            !texts.some((t) => t.includes("research"))
            ? true
            : null;
        }, { label: "rename: research → writing" });
        expect(await activeWorkspaceLabel(s)).toContain("Default");
      },
    );
  });
});
