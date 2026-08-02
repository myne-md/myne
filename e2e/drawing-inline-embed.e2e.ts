// Inline drawing embed (#213 / MYND-634).
//
// Pins the user-facing loop the feature adds: `/drawing` mints a sibling
// `kind: drawing` note and embeds it inline as `![[Drawing 1]]`, which renders as
// a thumbnail; clicking the thumbnail opens an edit-in-place Excalidraw canvas;
// "Done" collapses it back; and the embed survives a WebView reload (the
// `![[…]]` is real markdown in the host note, and the drawing note round-trips).
//
// Scaffold note (CI): drives the real tauri-driver harness (Linux/CI,
// `docs/dev/e2e.md`) — NOT runnable headless on macOS (Excalidraw rasterises on a
// real canvas). The load-bearing seams are stable testids shipped WITH the flow:
// `editor.drawing-embed` (+ its `data-drawing-embed-state`),
// `editor.drawing-embed.thumbnail`, `editor.drawing-embed.collapse`, and the
// shared `drawing.canvas` the whole-note surface already exposes. Canvas *content*
// (vs. mount + collapse + persistence) needs the canvas-interaction layer — the
// same depth follow-up drawing-notes.e2e.ts tracks; this pins the load-bearing loop.

import { it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  editorText,
  reopenNoteAfterReload,
  unlockToEditor,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

const ENTER = ""; // W3C Actions API code point for Enter
const CM_CONTENT = '[data-testid="editor.content"] .cm-content';
const EMBED = testIdSelector("editor.drawing-embed");
const EMBED_EDITING = testIdSelector("editor.drawing-embed", {
  "data-drawing-embed-state": "editing",
});
const EMBED_THUMBNAIL = testIdSelector("editor.drawing-embed", {
  "data-drawing-embed-state": "thumbnail",
});

/** Type `/drawing` at a fresh line start and confirm the top match with Enter —
 *  the same no-menu-DOM driving slash-datetime.e2e.ts uses. */
async function insertInlineDrawing(s: Session): Promise<void> {
  const content = await s.waitForElement(CM_CONTENT);
  await content.click();
  // Land the caret on a fresh line start so `/` opens the menu (it suppresses a
  // mid-word `/`). A literal "\n" is not Enter under WebKit's driver — send the
  // W3C ENTER key.
  await s.waitUntil(
    async () => {
      await content.sendKeys(`x${ENTER}`);
      return (await editorText(s)).includes("x") || null;
    },
    { label: "keystroke pipeline established at a line start", timeoutMs: 10_000 },
  );
  await content.sendKeys(`/drawing${ENTER}`);
}

describeE2E("di1 inline drawing embed: create → edit-in-place → collapse → reload", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("mints a sibling drawing, embeds it inline, opens/collapses the canvas, and survives reload", async () => {
    let password = "";
    await scenario(
      "di1-inline-drawing-embed",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Notlar");

        // `/drawing` → sibling drawing note + inline `![[Drawing 1]]` embed, which
        // renders as a thumbnail (not raw text).
        await insertInlineDrawing(s);
        await s.waitForElement(EMBED_THUMBNAIL);

        // Click the thumbnail → the edit-in-place canvas mounts (the shared
        // Excalidraw surface), and the embed flips to the editing state.
        await (await s.byTestId("editor.drawing-embed.thumbnail")).click();
        await s.waitForElement(EMBED_EDITING);
        await s.waitForExist(testIdSelector("drawing.canvas"));

        // "Done" collapses back to the thumbnail (transient — no persisted lock).
        await (await s.byTestId("editor.drawing-embed.collapse")).click();
        await s.waitForElement(EMBED_THUMBNAIL);

        // Survive a WebView reload: the `![[Drawing 1]]` is real markdown in the
        // host note and the drawing note round-trips, so the embed re-renders.
        await s.refresh();
        await reopenNoteAfterReload(s);
        await s.waitForElement(EMBED);
      },
    );
  });
});
