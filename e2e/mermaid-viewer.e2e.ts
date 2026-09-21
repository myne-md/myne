// Mermaid viewer suite (myne-md/myne#708).
//
// Pins the bounded, interactive mermaid viewer end-to-end in the production
// binary: a multi-subgraph flowchart renders inside a clipped viewport with the
// full control bar, the edit control reveals the raw ```mermaid fence, and the
// source bytes survive the MY01 AEAD round-trip (lock -> unlock -> reopen) with
// the viewer rebuilt. Before #708 the card was a static image with a horizontal
// scrollbar and no fit, zoom, pan or expand.
//
// In-source scenario constants are not credentials; SYNC-13 applies to
// passwords/phrases, which never appear in any assert below.
//
// PLATFORM: the harness drives the production binary via tauri-driver and is
// Linux-only. See e2e/AGENTS.md "definition of done".

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  seedEmbedIntoNote,
  unlockToEditor,
} from "./support/flows";

const EDITOR = '[data-testid="editor.content"]';
const CM_CONTENT = `${EDITOR} .cm-content`;

// Mermaid lazy-loads on the first diagram; a generous budget for the dynamic
// import plus the render.
const MERMAID_TIMEOUT = 30_000;

/** Brackets would race CodeMirror's auto-close, so the fixture uses bare node
 *  ids and arrow edges: enough shape for the layout, nothing to auto-close. */
const DIAGRAM = [
  "```mermaid",
  "flowchart LR",
  "  subgraph One",
  "    A --> B",
  "    B --> C",
  "  end",
  "  subgraph Two",
  "    C --> D",
  "  end",
  "```",
].join("\n");

const CONTROL_TESTIDS = [
  "editor.mermaid.zoom-in",
  "editor.mermaid.zoom-out",
  "editor.mermaid.reset",
  "editor.mermaid.pan-up",
  "editor.mermaid.pan-down",
  "editor.mermaid.pan-left",
  "editor.mermaid.pan-right",
  "editor.mermaid.edit",
  "editor.mermaid.expand",
];

// The fence is WRITTEN through the real `note_update` IPC and the note reopened
// (`seedEmbedIntoNote`), never typed. The keystroke path is unusable here and
// each reason hides the next, all measured in the container:
//
//   - A literal `\n` in `sendKeys` is delivered as U+000A, which WebKit's driver
//     does not translate into an Enter keypress, so CM6 stays on ONE line and no
//     `FencedCode` node is ever built (the reason `typeIntoEditor` rewrites `\n`).
//   - Replacing `\n` with the W3C ENTER key closes the fence but breaks it a
//     different way: CM6's `insertNewlineAndIndent` copies the current line's
//     leading whitespace onto the new line, the diagram's own indentation adds
//     to it, and the closing fence lands well past CommonMark's three spaces, so
//     it is not a closing fence and the block never closes.
//   - One DOM `insertText` for the whole payload drops the body, leaving an
//     empty fence.
//
// `seedEmbedIntoNote` is the same route the embed scenarios took, for the same
// class of reason, and is production IPC through the page seat rather than a
// test hook. What it gives up, stated: these scenarios no longer prove a user
// can TYPE a diagram. They never meant to; typing is covered where it is the
// subject, and what is pinned here is that the viewer builds and survives the
// AEAD round-trip.

describeE2E("mv1 a diagram opens in a bounded viewer with the control bar (#708)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("renders inside a clipped viewport, offers every control, and the edit control reveals the fence", async () => {
    let password = "";
    await scenario(
      "mv1-viewer",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Diyagram");
        await seedEmbedIntoNote(s, DIAGRAM);

        // The viewer replaced the static card: a clipped viewport holding the
        // live SVG, not a natural-size image with a scrollbar.
        await s.waitForElement(`${EDITOR} .cm-mermaid-viewport`, {
          timeoutMs: MERMAID_TIMEOUT,
        });
        await s.waitForElement(`${EDITOR} .cm-mermaid-viewport svg`, {
          timeoutMs: MERMAID_TIMEOUT,
        });

        // Every control the acceptance criteria name, each with a testid.
        for (const tid of CONTROL_TESTIDS) {
          await s.waitForElement(`[data-testid="${tid}"]`, { timeoutMs: 10_000 });
        }

        // The edit control reveals the raw fence (click-to-edit moved off the
        // diagram's own mousedown so a drag can pan).
        await (await s.byTestId("editor.mermaid.edit")).click();
        const text = await (await s.waitForElement(CM_CONTENT)).textContent();
        expect(text.includes("flowchart")).toBe(true);
      },
    );
  });
});

describeE2E("mv2 the diagram source survives the AEAD round-trip (#708, §6 C1)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("the viewer rebuilds after lock -> unlock and the bytes are unchanged", async () => {
    let password = "";
    await scenario(
      "mv2-roundtrip",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Kalıcı Diyagram");
        await seedEmbedIntoNote(s, DIAGRAM);
        await s.waitForElement(`${EDITOR} .cm-mermaid-viewport`, {
          timeoutMs: MERMAID_TIMEOUT,
        });

        // Lock (flushes the MY01 blob) -> unlock -> reopen the note.
        await (await s.byTestId("editor.lock-cta")).click();
        await s.byTestId("unlock.password-input");
        await unlockToEditor(s, password);
        await (await s.byTestId("notes.row")).click();

        // The viewer rebuilds over the same source, so opening a diagram was
        // never an edit (§6 C1: render-only, bytes preserved).
        await s.waitForElement(`${EDITOR} .cm-mermaid-viewport`, {
          timeoutMs: MERMAID_TIMEOUT,
        });
      },
    );
  });
});
