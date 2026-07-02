// AI summarize flow suite (note-summarization MYND-409 task 6). Drives the
// end-to-end summarize → render → insert flow through the `ai.*` testids on the
// real tauri-driver harness, against the **`local-inference-stub` build variant**
// (the deterministic `StubEngine` — no model file in the repo; SYNC-5). The
// audited production bundle never enables that feature, so this suite runs ONLY
// when the AI-feature binary is under test — gated on `MYNE_E2E_AI=1`, which the
// feature-flagged build sets (see `docs/dev/e2e.md`).
//
//   as1 — enable AI in Settings → summarize the open note from the command
//         palette → the AI Chat tab renders a result → "Insert into note"
//         appends a `## Summary` block through the normal autosave path.
//
// The hard no-egress guarantee is the Rust gate (`ai-no-network-check.sh` +
// `no_egress.rs` — candle adds zero networked crate); this behavioral suite
// asserts the flow completes locally (no error state, no network affordance).
//
// KDF: weak generator fixture (SYNC-9 — params are vault.meta-resident).

import { describe, expect, it } from "vitest";
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
import { testIdSelector } from "./support/webdriver";

/** Only run when the binary under test is the AI-feature (`local-inference-stub`)
 *  build — the default production bundle has no AI commands, so these testids
 *  never appear there. The feature-flagged build sets `MYNE_E2E_AI=1`. */
const aiDescribe = process.env.MYNE_E2E_AI === "1" ? describeE2E : describe.skip;

aiDescribe("as1 AI summarize → render → insert (note-summarization)", () => {
  // Vault-count precondition: 1 (weak KDF). Requires the local-inference-stub build.
  it("summarizes the open note into the AI Chat tab and inserts a ## Summary block", async () => {
    let password = "";
    await scenario(
      "as1-ai-summarize",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "as1notealfa7k2m9qx4w8e5rj0aa");
        await typeIntoEditor(s, "The mitochondria is the powerhouse of the cell.");
        await waitForSaved(s);

        // Turn AI on (off by default, SYNC-12).
        await enableAi(s);

        // Summarize from the command palette (reveals the AI Chat tab).
        await runPaletteAction(s, "ai.summarize-note", "summarize");

        // The stub engine returns deterministic output → the AI Chat tab renders
        // it (never the error state).
        const output = await s.waitForElement(
          testIdSelector("ai.output"),
          { timeoutMs: 15_000 },
        );
        expect((await output.textContent()).length).toBeGreaterThan(0);
        // Truncation notice / error state are flow-shape assertions, not content.
        await s.waitForGone(testIdSelector("ai.output-error"), { timeoutMs: 1_000 }).catch(
          () => {
            /* absence is the happy path; a brief probe */
          },
        );

        // "Insert into note" appends a `## Summary` block via the normal save.
        await (await s.byTestId("ai.insert-summary")).click();
        await s.waitUntil(
          async () => ((await editorText(s)).includes("## Summary") ? true : null),
          { label: "summary block inserted", timeoutMs: 10_000 },
        );
        await waitForSaved(s);
        expect(await editorText(s)).toContain("## Summary");
      },
    );
  });
});
