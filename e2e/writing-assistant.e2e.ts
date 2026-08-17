// AI writing-assistant flow suite (writing-assistant MYND-410 task 7). Drives
// the three writing-assistant surfaces end to end via the `ai.*` data-testids on
// the real tauri-driver harness, against the **`local-inference-stub` build
// variant** (the deterministic `StubEngine` — no model file in the repo; SYNC-5).
// The audited production bundle never enables that feature, so this suite runs
// ONLY when the AI-feature binary is under test — gated on `MYNE_E2E_AI=1`, which
// the feature-flagged build sets (see `docs/dev/e2e.md`).
//
//   wa1 — enable AI → open a note → (a) pause on a bare cursor → the dimmed
//         `ai.ghost-text` widget appears → Tab accepts it as plain markdown into
//         the buffer → Ctrl+Z reverses it in one undo step; (b) a slash command
//         sets the frontmatter `title:`; (c) select-all → the
//         `ai.rewrite-selection` palette action replaces the selection.
//
// AI is enabled BEFORE the note is created: the ghost-text + slash extensions
// compose into the editor only when `ai_enabled` is on at compose time
// (`myneExtensions`), so a note opened after the toggle carries them.
//
// Two harness realities shape the ghost-text asserts (do not "simplify" them):
//   1. The ghost is an inline DECORATION widget inside `.cm-content`, so its text
//      IS part of `editorText()` (which reads `.cm-content` textContent) even
//      before accept. We therefore press Escape immediately before each settled
//      read to clear any showing suggestion, so `editorText()` reflects the
//      BUFFER only.
//   2. A paused bare cursor re-fires the 700ms debounce, so a fresh ghost can
//      reappear at any idle moment — the Escape-before-read neutralizes that too.
//   3. Clicking the editor to "focus" moves the caret, which DISMISSES the ghost
//      (a selection change clears the field). So the ghost flow never re-clicks —
//      focus is retained from typing, and Tab/Escape/Ctrl+Z land on it directly.
//
// The hard no-egress guarantee is the Rust gate (`ai-no-network-check.sh` +
// `no_egress.rs` — the whole AI feature delta adds zero networked crate); this
// behavioral suite asserts the flow completes locally (deterministic stub
// output, no error state, no network affordance).
//
// KDF: weak generator fixture (SYNC-9 — params are vault.meta-resident).

import { describe, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  editorText,
  enableAi,
  runPaletteAction,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { KEY, pressChord, pressKey } from "./support/keyboard";
import { type Session, testIdSelector } from "./support/webdriver";

const CM_CONTENT = '[data-testid="editor.content"] .cm-content';

/** Only run when the binary under test is the AI-feature (`local-inference-stub`)
 *  build — the default production bundle has no AI commands/extensions, so these
 *  testids never appear there. The feature-flagged build sets `MYNE_E2E_AI=1`. */
const aiDescribe = process.env.MYNE_E2E_AI === "1" ? describeE2E : describe.skip;

/** Read the settled BUFFER text, with any ghost suggestion SUBTRACTED.
 *
 * **Escape alone is not enough, and that is why the undo assertion never
 * passed.** `editorText()` reads `.cm-content`'s textContent, and the ghost
 * suggestion is a widget INSIDE it, so its dimmed text is part of the readout.
 * Escape dismisses whatever is showing, but the assistant re-suggests on a
 * 700 ms debounce, and an undo moves the caret, which is exactly the event that
 * arms it again. So the ghost could reappear between the Escape and the read,
 * and the equality against the pre-suggestion baseline would fail forever. The
 * failure artefact confirms it: `ai.ghost-text` is still in the DOM at the
 * moment the wait gives up.
 *
 * Nothing about the product is wrong here. Undo does reverse the accept in one
 * step; the reading was measuring the document plus a suggestion that had
 * legitimately come back. Escape stays (it settles the common case and costs
 * nothing), and the subtraction makes the reading correct even when it loses
 * the race. */
async function bufferText(session: Session): Promise<string> {
  await pressKey(session, KEY.ESCAPE);
  const rendered = await editorText(session);
  let buffer = rendered;
  for (const ghost of await session.byTestIdAll("ai.ghost-text")) {
    const text = await ghost.textContent();
    if (text.length > 0) buffer = buffer.split(text).join("");
  }
  return buffer;
}

aiDescribe("wa1 AI writing assistant (ghost accept+undo, slash title, rewrite)", () => {
  // Vault-count precondition: 1 (weak KDF). Requires the local-inference-stub build.
  it("accepts+undoes ghost-text, sets a title via slash, and rewrites a selection", async () => {
    let password = "";
    await scenario(
      "wa1-writing-assistant",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Enable AI BEFORE opening the note so the ghost/slash extensions compose.
        await enableAi(s);

        await createNote(s, "wa1notealfa7k2m9qx4w8e5rj0aa");

        // ── (a) ghost-text: pause → widget → Tab accept → Ctrl+Z reverse ──
        await typeIntoEditor(s, "The mitochondria is the powerhouse of the");
        await waitForSaved(s);
        // Buffer text with no ghost showing (the pre-suggestion baseline).
        const beforeGhost = await bufferText(s);

        // A paused bare cursor (700ms debounce) fires one blocking stub `infer`;
        // the dimmed suggestion renders as `ai.ghost-text` after the cursor. The
        // editor keeps focus from typing — do NOT re-click (a caret move would
        // dismiss the ghost).
        await s.waitForElement(testIdSelector("ai.ghost-text"), { timeoutMs: 15_000 });

        // Tab accepts the suggestion as plain markdown (one `ai.insert` undo step).
        await pressKey(s, KEY.TAB);
        await s.waitUntil(
          async () => ((await bufferText(s)).length > beforeGhost.length ? true : null),
          { label: "ghost suggestion accepted into the buffer", timeoutMs: 10_000 },
        );

        // Ctrl+Z reverses the accept in exactly one step — the buffer returns to
        // the pre-suggestion baseline (no new format, plain-markdown reversible).
        await pressChord(s, KEY.CONTROL, "z");
        await s.waitUntil(
          async () => ((await bufferText(s)) === beforeGhost ? true : null),
          { label: "accept reversed in one undo step", timeoutMs: 10_000 },
        );

        // ── (b) slash → sets the frontmatter `title:` ──
        // Type the slash query at the caret and confirm the top fuzzy match with
        // Enter (the slash keymap's `confirm()` applies it — no menu DOM query,
        // mirroring `slash-datetime.e2e.ts`). English label: "Suggest title (AI)".
        const content = await s.waitForElement(CM_CONTENT);
        await content.click();
        await content.sendKeys("/suggest title");
        await pressKey(s, KEY.ENTER);
        await s.waitUntil(
          async () => ((await editorText(s)).includes("title:") ? true : null),
          { label: "slash set a frontmatter title", timeoutMs: 15_000 },
        );

        // ── (c) select-all → `ai.rewrite-selection` replaces the selection ──
        await content.click();
        await pressChord(s, KEY.CONTROL, "a");
        const beforeRewrite = await editorText(s);
        await runPaletteAction(s, "ai.rewrite-selection", "rewrite");
        await s.waitUntil(
          async () => {
            const t = await editorText(s);
            return t.length > 0 && t !== beforeRewrite ? true : null;
          },
          { label: "selection rewritten by the stub engine", timeoutMs: 15_000 },
        );

        await waitForSaved(s);
      },
    );
  });
});
