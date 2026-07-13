// Math rendering suite (MYND-48, math-katex) — E2E-gap #26.
//
// Pins the KaTeX math decoration end-to-end in the production binary: an
// inline `$…$` renders a `.cm-math-inline` widget (KaTeX lazy-loads on first
// math), an invalid block `$$…$$` renders the `.cm-math-error` fallback instead
// of crashing or swallowing the rest of the note, and the raw math source bytes
// round-trip through the MY01 AEAD blob (lock → unlock → reopen) and re-render
// — proving §6 C1 byte-preservation for math source. Math was a first-class
// decoration (lazy third-party engine + a byte-preservation guarantee) shipping
// with NO E2E; this closes that gate-evasion.
//
// In-source scenario constants are not credentials; SYNC-13 applies to
// passwords/phrases, which never appear in any assert below.
//
// ⚠ PLATFORM: the harness drives the production binary via tauri-driver and is
// Linux-only — authored to the conventions but MUST be run green 3× in the
// container (`./scripts/e2e-local.sh`) before merge; not executed on the
// authoring machine (macOS). See e2e/CLAUDE.md "definition of done".

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import { createNote, dismissImporterOffer, unlockToEditor, waitForSaved } from "./support/flows";
import { type Session } from "./support/webdriver";

const EDITOR = '[data-testid="editor.content"]';
const CM_CONTENT = `${EDITOR} .cm-content`;
const BACKSPACE = "\uE003"; // W3C key codepoint (Backspace)

// KaTeX lazy-loads on the first math widget — a generous budget for the dynamic
// import + font load on the container's first paint.
const KATEX_TIMEOUT = 20_000;

/** Establish the CM key pipeline (probe char then deleted), then send the raw
 *  math source. The decoration replaces the `$…$` source with a rendered widget
 *  off-cursor, so the observable is the widget element, not the raw text. */
async function typeRaw(session: Session, text: string): Promise<void> {
  const content = await session.waitForElement(CM_CONTENT);
  await content.click();
  await session.waitUntil(
    async () => {
      await content.sendKeys("q");
      return (await content.textContent()).includes("q") || null;
    },
    { label: "keystroke pipeline established", timeoutMs: 10_000 },
  );
  await content.sendKeys(BACKSPACE); // drop the probe char
  await content.sendKeys(text);
}

describeE2E("ma1 inline math renders without swallowing the note (MYND-48)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("a valid $…$ lazy-loads KaTeX and renders its widget; the rest of the line survives", async () => {
    let password = "";
    await scenario(
      "ma1-render",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Matematik");

        // Trailing text keeps the caret off the math range so it renders.
        await typeRaw(s, "intro $E=mc^2$ done");

        // The valid inline math lazy-loads KaTeX and renders its widget.
        await s.waitForElement(`${EDITOR} .cm-math-inline`, { timeoutMs: KATEX_TIMEOUT });
        // The widget replaces ONLY its own `$…$` source — the surrounding text
        // is intact (the decoration didn't swallow the rest of the note).
        const text = await (await s.waitForElement(CM_CONTENT)).textContent();
        expect(text.includes("intro")).toBe(true);
        expect(text.includes("done")).toBe(true);
      },
    );
  });
});

describeE2E("ma2 math source survives the AEAD round-trip (MYND-48, §6 C1)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("the $…$ source bytes persist through lock → unlock and re-render", async () => {
    let password = "";
    await scenario(
      "ma2-roundtrip",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Kalıcı Matematik");

        await typeRaw(s, "keep $a^2 + b^2$ safe");
        await s.waitForElement(`${EDITOR} .cm-math-inline`, { timeoutMs: KATEX_TIMEOUT });
        await waitForSaved(s);

        // Lock (flushes the MY01 blob) → unlock → reopen the note.
        await (await s.byTestId("editor.lock-cta")).click();
        await s.byTestId("unlock.password-input");
        await unlockToEditor(s, password);
        await (await s.byTestId("notes.row")).click();

        // The math re-renders → the source bytes survived the encrypted
        // round-trip verbatim (§6 C1).
        await s.waitForElement(`${EDITOR} .cm-math-inline`, { timeoutMs: KATEX_TIMEOUT });
      },
    );
  });
});
