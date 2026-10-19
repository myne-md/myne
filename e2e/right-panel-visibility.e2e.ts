// Right-panel-tabs suite (right-click hide/restore). The editor's right panel is
// a multi-tab surface (Backlinks / Unlinked mentions / Outline) modeled on the
// bottom bar: a tab hides/restores via the strip-wide checklist (right-click the
// strip's empty area); the hidden set persists per-vault in vault.prefs
// (`right_panel_hidden_tabs`). This pins the user-facing contract through the
// REAL editor UI:
//
//   rp1 — right-clicking the strip's empty area opens a checkable menu; toggling
//         "Outline" off removes the tab from the strip, the choice SURVIVES a
//         lock → unlock round-trip (disk-persisted, not transient), and toggling
//         it back on restores it.
//
// The checklist reuses the shared ContextMenu primitive in its checkable-toggle
// mode (`closeOnSelect: false`), so a click flips the tab and leaves the menu
// open; the test dismisses it with a neutral outside-click before asserting.
//
// KDF: weak generator fixture (SYNC-9 — params are vault.meta-resident).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  dismissImporterOfferIfPresent,
  unlockToEditor,
  tabIds,
} from "./support/flows";
import { type Session, testIdSelector } from "./support/webdriver";

/** Right-click the strip's empty area, then return the checklist item for `tabId`. */
async function openTabChecklistItem(session: Session, tabId: string) {
  await (await session.byTestId("editor.right-panel-tabs-rest")).rightClick();
  return await session.waitForElement(
    testIdSelector("notes.context-menu-item", { "data-item-id": tabId }),
  );
}

/** Dismiss the open checklist via a neutral outside-click well clear of the menu
 *  (the menu renders over the strip spacer, so click the editor content area —
 *  any document mousedown outside the ContextMenu node closes it). */
async function dismissChecklist(session: Session): Promise<void> {
  await (await session.byTestId("editor.content")).click();
}

describeE2E("rp1 right-panel tab hide/restore persists (right-panel tabs)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("checklist hides the Outline tab, the choice survives lock→unlock, and re-toggling restores it", async () => {
    let password = "";
    await scenario(
      "rp1-right-panel-visibility",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "rp1notealfa7k2m9qx4w8e5rj0aa");

        // Baseline: the five tabs a FRESH VAULT renders, which is this
        // scenario's declared precondition.
        //
        // `ai-chat` is in the tab vocabulary (`rightPanelTabs.ts`) but the
        // Editor hides it while `ai_enabled` is off — AI ships in the default
        // build behind a runtime beta opt-in (decisions.md 2026-07-02), and a
        // fresh vault has it off.
        //
        // The fifth is `who-is-here`, the live-presence roster the live-collab
        // epic added to the same vocabulary, and it is NOT gated on anything: a
        // fresh vault shows it. The list here asserted four for as long as that
        // was true, and the assertion is what caught the change.
        //
        // The paragraph this replaces warned that with five tabs the right-click
        // target this scenario uses (`editor.right-panel-tabs-rest`, the strip's
        // trailing `flex: 1` spacer) had stopped yielding a menu in three
        // consecutive runs, and called that a separate question with its own
        // answer to measure rather than something to decide here. Five is now the
        // DEFAULT state, so the question is live for every user who never hides a
        // tab; this scenario going red at the checklist step is that measurement.
        await s.byTestId("editor.right-panel-tabs");
        expect(await tabIds(s)).toEqual([
          "backlinks",
          "unlinked",
          "outline",
          "tasks",
          "who-is-here",
        ]);

        // Right-click the strip → the "Outline" item shows as checked (visible).
        const outlineItem = await openTabChecklistItem(s, "outline");
        expect(await outlineItem.attribute("data-checked")).toBe("true");

        // Toggle it off. The menu stays open (checkable-toggle mode), so close it
        // with a neutral outside-click before asserting the strip.
        await outlineItem.click();
        await dismissChecklist(s);
        await s.waitUntil(
          async () => (!(await tabIds(s)).includes("outline") ? true : null),
          { label: "outline tab disappears after toggle-off" },
        );

        // Persistence: lock → unlock mounts a fresh editor that reads
        // right_panel_hidden_tabs from disk; the Outline tab stays hidden.
        await (await s.byTestId("editor.lock-cta")).click();
        await s.byTestId("unlock.password-input");
        await unlockToEditor(s, password);
        await dismissImporterOfferIfPresent(s);
        await s.byTestId("editor.right-panel-tabs");
        expect(await tabIds(s)).toEqual([
          "backlinks",
          "unlinked",
          "tasks",
          "who-is-here",
        ]);

        // The reopened checklist reflects the persisted state: "Outline" unchecked.
        const outlineItemAfter = await openTabChecklistItem(s, "outline");
        expect(await outlineItemAfter.attribute("data-checked")).toBe("false");

        // Toggle it back on → the tab returns to the strip.
        await outlineItemAfter.click();
        await dismissChecklist(s);
        await s.waitUntil(
          async () => ((await tabIds(s)).includes("outline") ? true : null),
          { label: "outline tab returns after toggle-on" },
        );
      },
    );
  });
});
