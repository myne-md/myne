// Hotkeys settings-panel + rebind suite (hotkeys epic, MYND-304).
//
// AUTHORED ON A NON-HARNESS HOST (macOS) — pending green-3× verification on the
// Linux tauri-driver container (the e2e DoD; `./scripts/e2e-local.sh`). Follows
// the prefs.e2e.ts settings-panel pattern + the search-palette.e2e.ts W3C
// Actions API for keyboard chords (deliberately NOT `sendKeys` for chords — the
// Actions API sidesteps the invisible-U+E007 hazard, MEMORY e2e note). Run
// ISOLATED (MEMORY: full-suite contamination).
//
// Pins: the Hotkeys panel lists commands + filters by search (hotkeys-panel-view,
// MYND-363); a captured rebind persists through a WebView reload — the engine
// re-reads the MYP1 keymap field on editor re-entry — and "Reset all" restores
// defaults (rebind-flow, MYND-364 + keymap-model-persist, MYND-366).
//
// KDF: weak generator fixtures (SYNC-9 — params are vault.meta-resident).

import { it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  dismissImporterOffer,
  openSettings,
  closeSettings,
  unlockToEditor,
  createNote,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

// The Linux harness accelerator is Control (the canonical `Mod`); the W3C
// Actions API key code point for Control.
const CONTROL = "";

/** Send a single `Control+<key>` chord via the W3C Actions API (no sendKeys). */
async function sendCtrlChord(session: Session, key: string): Promise<void> {
  await session.send("POST", "/actions", {
    actions: [
      {
        type: "key",
        id: "kbd",
        actions: [
          { type: "keyDown", value: CONTROL },
          { type: "keyDown", value: key },
          { type: "keyUp", value: key },
          { type: "keyUp", value: CONTROL },
        ],
      },
    ],
  });
}

const rowSel = (commandId: string) =>
  testIdSelector("hotkeys.row", { "data-command-id": commandId });

describeE2E("hk1 Hotkeys panel lists + filters shortcuts (MYND-363)", () => {
  // Precondition: exactly 1 vault (weak KDF).
  it("opens the panel, renders command rows, and fuzzy-filters by search", async () => {
    let password = "";
    await scenario(
      "hk1-panel-list-search",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        await openSettings(s, "hotkeys");
        await s.byTestId("hotkeys.panel");

        // A known command row renders with its default binding glyph.
        const graphRow = await s.waitForElement(rowSel("graph.show"));
        if (!(await graphRow.textContent()).includes("Show graph view")) {
          throw new Error("hotkeys panel did not render the graph.show row");
        }

        // Search narrows the list: "split" keeps the split commands, drops graph.show.
        await (await s.byTestId("hotkeys.search")).sendKeys("split");
        await s.waitForElement(rowSel("pane.split-row"));
        await s.waitForGone(rowSel("graph.show"));

        await closeSettings(s);
      },
    );
  });
});

describeE2E("hk2 rebind persists through reload + reset (MYND-364/366)", () => {
  // Precondition: exactly 1 vault (weak KDF).
  it("captures a new binding, survives a WebView reload, and Reset-all restores defaults", async () => {
    let password = "";
    await scenario(
      "hk2-rebind-persist-reset",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        await openSettings(s, "hotkeys");
        // Add a binding to graph.show: focus the capture input, press Ctrl+J.
        await (
          await s.waitForElement(`${rowSel("graph.show")} [data-testid="hotkeys.add-binding"]`)
        ).click();
        await s.byTestId("hotkeys.capture-input");
        await sendCtrlChord(s, "j");

        // The new chord chip appears on the row (formatChord → "Ctrl+J" on Linux).
        await s.waitUntil(
          async () =>
            (await (await s.waitForElement(rowSel("graph.show"))).textContent()).includes("Ctrl+J")
              ? true
              : null,
          { label: "graph.show shows the new Ctrl+J binding" },
        );
        await closeSettings(s);

        // Reload: slot stays Unlocked → boots back to the editor; the engine
        // re-reads the MYP1 keymap field. The override must persist. (The
        // importer offer is first-run-only — already dismissed above, it does
        // NOT reappear after a reload, so no second dismiss.)
        await s.refresh();
        await openSettings(s, "hotkeys");
        await s.waitUntil(
          async () =>
            (await (await s.waitForElement(rowSel("graph.show"))).textContent()).includes("Ctrl+J")
              ? true
              : null,
          { label: "rebind persisted across reload" },
        );

        // Reset all → confirm → the override is gone (default-only display).
        await (await s.byTestId("hotkeys.reset-all")).click();
        await (await s.byTestId("hotkeys.reset-all-yes")).click();
        await s.waitUntil(
          async () =>
            (await (await s.waitForElement(rowSel("graph.show"))).textContent()).includes("Ctrl+J")
              ? null
              : true,
          { label: "Reset all cleared the custom Ctrl+J binding" },
        );

        await closeSettings(s);
      },
    );
  });
});

describeE2E("hk3 conflict warns + assigns anyway + indicator (MYND-365)", () => {
  // Precondition: exactly 1 vault (weak KDF).
  it("binding a chord already in use warns (warn-only) and flags both rows", async () => {
    let password = "";
    await scenario(
      "hk3-conflict-warn",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        await openSettings(s, "hotkeys");
        // Bind note.new-tab onto Ctrl+, — app.open-settings' default → conflict.
        await (
          await s.waitForElement(`${rowSel("note.new-tab")} [data-testid="hotkeys.add-binding"]`)
        ).click();
        await s.byTestId("hotkeys.capture-input");
        await sendCtrlChord(s, ",");

        // Warn-only (SYNC-7): the warning names the colliding command, AND the
        // binding is assigned anyway (the chord chip appears).
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("hotkeys.warning")).textContent()).includes("Open settings")
              ? true
              : null,
          { label: "conflict warning names the other command" },
        );
        // Both the new binder and the original carry the persistent indicator.
        await s.waitForElement(`${rowSel("note.new-tab")} [data-testid="hotkeys.conflict-indicator"]`);
        await s.waitForElement(
          `${rowSel("app.open-settings")} [data-testid="hotkeys.conflict-indicator"]`,
        );

        await closeSettings(s);
      },
    );
  });
});

describeE2E("hk4 a migrated window chord still fires through the engine (MYND-362)", () => {
  // Precondition: exactly 1 vault (weak KDF). Zero-regression proof for the
  // Editor.tsx handler migration: the keyboard split chord (Cmd/Ctrl-\) is
  // dispatched by the engine — not otherwise E2E-covered (workspace-state.e2e.ts
  // splits via Alt-click, a mouse path).
  it("Ctrl-\\ splits the focused pane via the keybind engine (default binding)", async () => {
    let password = "";
    await scenario(
      "hk4-window-chord-split",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Split Me");

        // One pane to start.
        if ((await s.byTestIdAll("editor.pane")).length !== 1) {
          throw new Error("expected a single pane before the split chord");
        }
        // Ctrl-\ → pane.split-row default → engine dispatches ws.splitFocused("row").
        await sendCtrlChord(s, "\\");
        await s.waitUntil(
          async () => ((await s.byTestIdAll("editor.pane")).length === 2 ? true : null),
          { label: "Ctrl-\\ split the pane (1 → 2) via the engine" },
        );
      },
    );
  });
});

describeE2E("hk5 the command palette is a rebindable command + opens via the engine", () => {
  // Precondition: exactly 1 vault (weak KDF). Zero-regression proof for the
  // palette migration: `palette.toggle` moved off its hardcoded window listener
  // onto the keybind engine, so it now (a) renders as a rebindable Hotkeys row
  // and (b) opens the palette through the engine-dispatched Ctrl+K default —
  // the same chord every `runPaletteAction` caller relies on.
  it("lists the palette.toggle row with its default chord and opens via Ctrl+K", async () => {
    let password = "";
    await scenario(
      "hk5-palette-rebindable",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // (a) The migrated command surfaces as a rebindable panel row carrying
        // its default Ctrl+K glyph (formatChord → "Ctrl+K" on the Linux harness).
        await openSettings(s, "hotkeys");
        await (await s.byTestId("hotkeys.search")).sendKeys("palette");
        const row = await s.waitForElement(rowSel("palette.toggle"));
        const rowText = await row.textContent();
        if (!rowText.includes("Open command palette") || !rowText.includes("Ctrl+K")) {
          throw new Error("palette.toggle row missing its label or default Ctrl+K binding");
        }
        await closeSettings(s);

        // (b) Ctrl+K → palette.toggle default → engine opens the palette.
        await sendCtrlChord(s, "k");
        await s.byTestId("palette.input");
      },
    );
  });
});
