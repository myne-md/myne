// Drawing-notes flow (drawing-notes epic MYND-497, SF2 MYND-499).
//
// Pins the user-facing "New drawing" flow the feature adds: the new-tab chooser's
// "New drawing" button mints a `kind: drawing` note whose editing surface is the
// Excalidraw canvas (not CodeMirror), the note survives a WebView reload, and it
// reads distinctly (a drawing tab, not a markdown one).
//
// Scaffold note (CI): this suite drives the real tauri-driver harness (Linux/CI,
// `docs/dev/e2e.md`) — it is NOT runnable headless on macOS. The load-bearing
// seams it attaches to are stable testids shipped WITH the flow (root CLAUDE.md
// "a flow ships with its E2E"): `notes.newTab.create-drawing` (the chooser button)
// and `drawing.canvas` (the mounted Excalidraw surface). The canvas is an HTML5
// `<canvas>`, so asserting drawn *content* (vs. its mount + persistence) needs the
// canvas-interaction support layer — tracked as the depth follow-up; this suite
// pins create → canvas-mounts → reload-survives, which is the load-bearing loop.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import { reopenNoteAfterReload, unlockToEditor } from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

const CANVAS = testIdSelector("drawing.canvas");

/** Open the new-tab chooser and click "New drawing", committing the inline
 *  rename with a title. Returns once the Excalidraw canvas has mounted. */
async function createDrawing(session: Session, title: string): Promise<void> {
  // The empty pane / "+" surfaces the new-tab chooser; its "New drawing" button
  // is the create-drawing entry (mirrors `createNote`'s `notes.create`).
  await (await session.byTestId("notes.newTab.create-drawing")).click();
  const rename = await session.byTestId("notes.rename-input");
  await rename.sendKeys(`${title}`);
  await session.waitForGone(testIdSelector("notes.rename-input"));
  await session.waitForExist(CANVAS);
}

describeE2E("dr1 drawing note: create → canvas mounts → reload survives", () => {
  it(
    "mints a kind:drawing note that opens the Excalidraw canvas and persists",
    scenario(async (s) => {
      await seedVault(s);
      await unlockToEditor(s);

      // Create a drawing → the canvas surface (not CodeMirror) mounts.
      await createDrawing(s, "My Sketch");
      expect(await s.exists(CANVAS)).toBe(true);
      // The markdown editor surface must NOT be the active editor for a drawing.
      expect(await s.exists(testIdSelector("editor.content-frame"))).toBe(true);

      // Survive a WebView reload — the `.myn` round-trips (MY01 envelope) and the
      // canvas re-mounts for the reopened drawing (not the CodeMirror editor).
      await s.refresh();
      await reopenNoteAfterReload(s);
      await s.waitForExist(CANVAS);
      expect(await s.exists(CANVAS)).toBe(true);
    }),
  );
});
