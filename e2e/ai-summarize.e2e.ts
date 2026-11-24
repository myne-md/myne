// AI summarize flow suite (note-summarization MYND-409 task 6). Drives the
// end-to-end summarize → render → insert flow through the `ai.*` testids on the
// real tauri-driver harness, against the **`local-inference-stub` build variant**
// (the deterministic `StubEngine` — no model file in the repo; SYNC-5). The
// audited production bundle never enables that feature, so this suite runs ONLY
// when the AI-feature binary is under test — gated on `MYNE_E2E_AI=1`, which the
// feature-flagged build sets (see `dev-notes/e2e.md`).
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

        // Summarize is now FOLDED INTO the chat transcript (conversational-ai-chat
        // task 10): the stub engine's deterministic output streams as an assistant
        // turn — never the error state.
        await s.waitForElement(testIdSelector("ai.transcript"), { timeoutMs: 15_000 });
        await s.waitUntil(
          async () => ((await s.byTestIdAll("ai.turn")).length >= 2 ? true : null),
          { label: "summarize appended a transcript turn", timeoutMs: 15_000 },
        );
        const turns = await s.byTestIdAll("ai.turn");
        const last = turns[turns.length - 1]!;
        expect(await last.attribute("data-role")).toBe("assistant");
        expect((await last.textContent()).length).toBeGreaterThan(0);
        // No error turn on the happy path.
        expect((await s.byTestIdAll("ai.turn-error")).length).toBe(0);

        // The per-turn "Insert into note" appends a `## Summary` block via the
        // normal save (SYNC-17 — the insertable-turn action).
        await (await s.byTestId("ai.insert-turn")).click();
        // **Asserted on the rendered HEADING, not on the source marker.** The
        // previous check was `editorText(s).includes("## Summary")`, and it can
        // never be true: `editorText` reads `.cm-content`'s textContent, and in
        // Live preview a heading's `## ` marker is decoration-hidden on every
        // line the cursor is not on, so the block reads back as "Summary". The
        // insert had been working the whole time. `flows.ts` documents this
        // exact trap for `typeIntoEditor` and normalises around it; the
        // knowledge just never reached here, so this scenario timed out on
        // develop and on every branch and read like a broken insert.
        //
        // `.cm-h2` is what `## ` MEANS after rendering, so this is the stronger
        // assertion rather than the looser one: a plain paragraph containing the
        // word Summary does not satisfy it.
        await s.waitUntil(
          async () => {
            for (const h of await s.findElements(".cm-h2")) {
              if ((await h.textContent()).trim() === "Summary") return true;
            }
            return null;
          },
          { label: "summary block inserted", timeoutMs: 10_000 },
        );
        await waitForSaved(s);
        // The same trap once more, in the post-save re-read: `editorText` is the
        // RENDERED readout, so the `## ` marker is decoration-hidden here too.
        // Re-asserted after the save rather than dropped, because the point of
        // this line is that the block SURVIVED the autosave round-trip, not that
        // it appeared: a decoration can render before the write lands.
        const headings: string[] = [];
        for (const h of await s.findElements(".cm-h2")) {
          headings.push((await h.textContent()).trim());
        }
        expect(headings).toContain("Summary");
      },
    );
  });
});
