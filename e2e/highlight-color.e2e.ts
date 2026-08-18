// Multi-color highlight suite (decisions.md 2026-06-15, MYND-209/MYND-156).
//
// Pins the colored-highlight path end-to-end in the production binary:
// a note authored with `<mark class="hl-green">…</mark>` renders through the
// colored-highlight decoration (MYND-637) as a clean `.cm-highlight.cm-hl-green`
// span — its `hl-green` class having survived the REAL DOMPurify sanitizer (the
// `uponSanitizeAttribute` hook registered in `loadPurifier`) — while an UNKNOWN
// class (`hl-chartreuse`) is stripped and falls back to a plain embedded-html
// `<mark>`, and the colored `<mark>` bytes round-trip through the MY01 AEAD blob
// (lock → unlock → reopen) and re-render — proving §6 C1 byte-preservation for
// user-authored HTML.
//
// SCOPE NOTE: the toolbar swatch EMIT path (select text → caret → color square →
// `<mark class="hl-…">` inserted) is unit-tested deterministically in
// `tests/editor/highlight-toolbar.test.ts` (the exact `toggleWrap` delimiters).
// It is NOT driven here because the floating selection-toolbar needs a non-empty
// text selection to appear, and this WebKitWebDriver drops Shift in send-keys
// (so Shift+Arrow selection is unreliable) and exposes no drag/double-click
// helper. This suite therefore covers the observable OUTCOME (the colored
// highlight renders + persists), which is the security-load-bearing half.
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

// A note carrying one allowlisted color (green) and one off-allowlist color.
//
// The probe is `hl-chartreuse`, a colour NOT in `HIGHLIGHT_CLASSES` — it must
// stay off the allowlist for this scenario to mean anything. It used to be
// `hl-orange`, which MYND-632 then ADDED when the palette grew 5 -> 13, so the
// assertion below started failing while the sanitizer was behaving correctly.
// The three unit-test analogues moved to the same probe; pick from the same
// place if it ever needs changing again.
//
// Each `<mark>` ends BEFORE trailing text so the cursor lands past the
// span (isInsideRange is boundary-inclusive) → the embedded-HTML decoration
// renders both off-cursor instead of revealing raw.
const DOC =
  'a <mark class="hl-green">leaf</mark> b ' +
  '<mark class="hl-chartreuse">dusk</mark> end';

/** Establish the CM key pipeline (probe char then deleted), then send the raw
 *  payload. Unlike `typeIntoEditor`, this does NOT assert the raw bytes survive
 *  in `textContent` — the embedded-HTML decoration replaces the `<mark>` source
 *  with a rendered widget off-cursor, so the observable is the rendered element,
 *  not the raw text. */
async function typeRaw(session: Session, text: string): Promise<void> {
  const content = await session.waitForElement(CM_CONTENT);
  await content.click();
  // ONE Backspace PER probe. The `waitUntil` types "q" on every poll, and under
  // load it polls more than once, so a single Backspace leaves the surplus in
  // the document ahead of the payload. `typeEmbedIntoEditor` in
  // `support/flows.ts` carries the full account; this copy stays private only
  // because its arrival check is not the embed one.
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

describeE2E("hc1 colored highlight renders; unknown class falls back (MYND-209)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("a hl-green mark keeps its class; an off-allowlist mark renders plain", async () => {
    let password = "";
    await scenario(
      "hc1-render",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Renkli Not");

        await typeRaw(s, DOC);

        // The allowlisted color survives the real DOMPurify sanitizer + decoration.
        await s.waitForElement(`${EDITOR} .cm-highlight.cm-hl-green`);
        // The off-allowlist class is stripped → no colored mark for it.
        const offList = await s.findElements(
          `${EDITOR} .cm-embedded-html mark.hl-chartreuse`,
        );
        expect(offList.length).toBe(0);
        // …but the bare <mark> still renders (only its class was dropped). Green
        // now paints through the colored-highlight decoration (MYND-637), off the
        // embedded-html path, so the only embedded-html <mark> left is the
        // class-stripped chartreuse fallback.
        const marks = await s.findElements(`${EDITOR} .cm-embedded-html mark`);
        expect(marks.length).toBe(1);
      },
    );
  });
});

describeE2E("hc2 colored highlight survives the AEAD round-trip (MYND-209, §6 C1)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("the <mark class=hl-green> bytes persist through lock → unlock and re-render", async () => {
    let password = "";
    await scenario(
      "hc2-roundtrip",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Kalıcı Renk");

        await typeRaw(s, DOC);
        await s.waitForElement(`${EDITOR} .cm-highlight.cm-hl-green`);
        await waitForSaved(s);

        // Lock (flushes the MY01 blob) → unlock → reopen the note.
        await (await s.byTestId("editor.lock-cta")).click();
        await s.byTestId("unlock.password-input");
        await unlockToEditor(s, password);
        await (await s.byTestId("notes.row")).click();

        // The colored highlight re-renders → the class bytes survived the
        // encrypted round-trip verbatim (§6 C1).
        await s.waitForElement(`${EDITOR} .cm-highlight.cm-hl-green`);
      },
    );
  });
});
