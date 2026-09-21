// Detached (pop-out) note window suite (epic myne-md/myne#173; #678 creation +
// #681 cross-window). Drives the pop-out affordance on the real tauri-driver
// harness against the production desktop bundle.
//
//   dw1: with a note open, the "Open note in new window" command is in the
//         palette (the affordance is wired and capability-gated to desktop, which
//         the Linux container is), and invoking it does not error the editor out.
//
// WHY THIS SCENARIO STOPS THERE. The rich behaviour of the feature is a SECOND OS
// window, its focus, a tab drag across the window boundary, geometry restore onto
// a specific monitor, and a second WebView reacting to a cross-window delete.
// Those are multi-window and multi-monitor behaviours the single-session Linux
// WebKitGTK harness cannot reliably judge (this directory's AGENTS.md documents
// the pitfalls at length, and `POST /window/rect` is silently ignored under
// xvfb), so `check-manual-test-roster.mjs`'s own rule classes them as MANUAL and
// they are the `editor.detached-window-pop-out` roster verdict. What a machine
// CAN honestly judge, and what this asserts, is that the flow's entry point is
// real: the command exists, is gated correctly, and invoking it leaves the app
// running rather than crashing or falling closed.
//
// KDF: weak generator fixture (SYNC-9: params are vault.meta-resident).
// Vault-count precondition: 1.

import { it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  runPaletteAction,
  unlockToEditor,
} from "./support/flows";

describeE2E("dw1 pop a note into its own window", () => {
  it("exposes the pop-out command for an open note and invokes it without erroring the editor", async () => {
    let password = "";
    await scenario(
      "dw1-detached-window",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        // A focused note is what puts the note-scoped pop-out command in the
        // palette. The id is a plaintext-scan-safe token (lowercase alnum, >=24).
        await createNote(s, "dw1notealfa7k2m9qx4w8e5rj0aa");

        // The affordance: `runPaletteAction` filters the palette by the query and
        // finds the row by its data-action-id, so this ASSERTS the command is
        // present (wired + gated on `detachedWindows`, which desktop-linux has)
        // and then invokes it (firing the host pop-out command).
        await runPaletteAction(s, "note.open-in-new-window", "new window");

        // Robust post-condition, single-window and non-flaky: the editor survives
        // the pop-out invocation whether or not a second OS window materialises
        // under xvfb. A crash or a fail-closed takeover would remove this root.
        await s.byTestId("editor.root");
      },
    );
  });
});
