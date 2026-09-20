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
// Linux-only. Authored to the conventions; it MUST be run green 3x in the
// container (`./scripts/e2e-buildrun.sh e2e/mermaid-viewer.e2e.ts` repeated)
// before merge, and it has NOT been executed on the authoring machine (macOS).
// See e2e/AGENTS.md "definition of done".

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import { createNote, dismissImporterOffer, unlockToEditor, waitForSaved } from "./support/flows";
import { type Session } from "./support/webdriver";

const EDITOR = '[data-testid="editor.content"]';
const CM_CONTENT = `${EDITOR} .cm-content`;
const BACKSPACE = "\uE003"; // W3C key codepoint (Backspace)

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

/** Establish the CM key pipeline (probe char then deleted), then send the raw
 *  source. Same shape as math.e2e.ts's `typeRaw`: the probe types on every poll
 *  of its `waitUntil`, so one Backspace per probe is required. */
async function typeRaw(session: Session, text: string): Promise<void> {
  const content = await session.waitForElement(CM_CONTENT);
  await content.click();
  let probes = 0;
  await session.waitUntil(
    async () => {
      await content.sendKeys("q");
      probes += 1;
      return (await content.textContent()).includes("q") || null;
    },
    { label: "keystroke pipeline established", timeoutMs: 10_000 },
  );
  for (let i = 0; i < probes; i += 1) await content.sendKeys(BACKSPACE);
  await content.sendKeys(text);
}

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
        await typeRaw(s, DIAGRAM);

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
        await typeRaw(s, DIAGRAM);
        await s.waitForElement(`${EDITOR} .cm-mermaid-viewport`, {
          timeoutMs: MERMAID_TIMEOUT,
        });
        await waitForSaved(s);

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
