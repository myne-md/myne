// Agentic note editing (myne-md/myne#529). Drives one run end to end through the
// `ai.composer-*` / `agentReview.*` testids on the real tauri-driver harness,
// against the **`local-inference-stub` build variant** (the deterministic
// `StubEngine`: no model file in the repo). The audited production bundle never
// enables that feature, so this suite runs ONLY when the AI-feature binary is
// under test, gated on `MYNE_E2E_AI=1` exactly like its AI siblings.
//
//   ag1: start a run on the open note → the review screen appears with the
//         proposal → reject one edit → approve the rest → the note carries the
//         approved change and not the rejected one.
//   ag2: the running scope total is on screen while the run works and while it
//         is reviewed, because with no cap on scope growth it is the only thing
//         bounding accumulation.
//   ag3: an edit that would trash a note is not carried by the bulk approve; it
//         renders its own act and the note is untouched until that act is taken.
//   ag4: the run is undone AFTER the review screen has been closed, from the
//         composer's own strip, and the note goes back to what it was.
//   ag5: a model-requested scope expansion renders the four facts the approval
//         needs, and approving it resumes the same run.
//   ag6: ONE composer answers a question and then runs an edit, into one
//         transcript (myne-md/myne#533). The only scenario here that would catch
//         a regression re-adding the second composer: every other one drives
//         whichever input its own testid happens to find.
//
// ag4 is the one that would have caught the shipped gap. Undo used to live only
// on the review screen, which owned the `[noteId, snapshotId]` record; closing
// that screen dropped it, so a published guarantee stopped being true the moment
// the user did the ordinary thing. The scenario therefore CLOSES the screen
// before undoing, deliberately: an undo pressed while the screen is open would
// pass against the old build too.
//
// The stub engine's script is fixed (`StubEngine::agent_script`): list, read,
// propose one anchored edit, finish — and, for task text naming other folders,
// a `request_scope` action, which is what ag5 drives. **No scenario here
// self-skips.** Two comments in this file used to say ag5 did, contradicting a
// third that said "NOT a self-skip", and the risk is concrete: the E2E floor was
// raised on the arithmetic that all six execute, so a reader who trusted the
// header would lower it to match (myne-md/myne#531 review round seven).
//
// ag3 is the one worth reading twice. Deletion in Myne is a `trashed:`
// frontmatter timestamp, so at the diff layer it is indistinguishable from any
// other edit: the assertion is on what the bulk action DOES to the note, not on
// the presence of a warning label, because a build that rendered the label and
// still sent the edit would pass a label assertion.
//
// KDF: weak generator fixture (SYNC-9: params are vault.meta-resident).

import { describe, expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  clickByTestId,
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
import type { Session } from "./support/webdriver";

/** Only run when the binary under test is the AI-feature build. */
const aiDescribe = process.env.MYNE_E2E_AI === "1" ? describeE2E : describe.skip;

/** Open the AI Chat tab and put its one composer into Edit mode.
 *
 *  **The palette action is what opens it**, and this helper shipped without it:
 *  it waited on a tab nothing had opened, so all five scenarios timed out at the
 *  same line. The composer renders only while the right pane's active tab is
 *  `ai-chat`, so this reuses the route `ai-chat.e2e.ts` already uses rather than
 *  clicking chrome.
 *
 *  There is now ONE composer serving both modes, so the tab opens in Ask mode
 *  and a run has to say it wants Edit. Driving the mode control here IS the
 *  coverage of that change, not a detour around it: the scope control appears
 *  with the mode, so waiting for it is the assertion that the switch took rather
 *  than that a segment repainted. */
async function openComposerInEditMode(session: Session): Promise<void> {
  await runPaletteAction(session, "ai.open-chat", "chat");
  await session.waitForElement(testIdSelector("ai.composer"), { timeoutMs: 15_000 });
  await clickByTestId(session, "ai.composer-mode-edit");
  await session.waitForElement(testIdSelector("ai.composer-scope"), {
    timeoutMs: 5_000,
  });
}

/** Start a run on whatever note is open and wait for the review takeover. */
async function startRun(session: Session, task: string): Promise<void> {
  const input = await session.byTestId("ai.composer-input");
  await input.click();
  await input.sendKeys(task);
  await (await session.byTestId("ai.composer-send")).click();
  await session.waitForElement(testIdSelector("agentReview.screen"), {
    timeoutMs: 30_000,
  });
}

aiDescribe("ag1 agent run → review → reject one → approve rest", () => {
  // Vault-count precondition: 1 (weak KDF). Requires the local-inference-stub build.
  it("applies the approved edits and leaves the rejected one alone", async () => {
    let password = "";
    await scenario(
      "ag1-agent-run",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "ag1notealfa7k2m9qx4w8e5rj0aa");
        // TWO lines, deliberately. The stub proposes one edit per eligible body
        // line, and this scenario rejects one and approves the rest, so a
        // one-line note leaves nothing to approve after the rejection and the
        // apply returns without ever reaching the host.
        await typeIntoEditor(s, "alpha beta gamma delta\nepsilon zeta eta theta");
        await waitForSaved(s);
        await enableAi(s);
        await openComposerInEditMode(s);

        // Baseline from the editor, not from the typed string: `editorText`
        // reads `.cm-content`'s textContent, which concatenates CM6 lines with
        // no separator and hides markdown markers on non-cursor lines.
        const original = await editorText(s);
        await startRun(s, "tidy this note");

        // The proposal renders as grouped diffs rather than as prose.
        const edits = await s.byTestIdAll("agentReview.edit");
        expect(
            edits.length,
            "this scenario rejects one edit and approves the rest, so it needs at least two",
        ).toBeGreaterThan(1);

        // Reject exactly one, and assert the row says so rather than trusting
        // that the click landed.
        await (await s.byTestId("agentReview.toggleEdit")).click();
        await s.waitUntil(
          async () => {
            const rows = await s.byTestIdAll("agentReview.edit");
            const rejected = await Promise.all(
              rows.map(async (r) => (await r.attribute("data-rejected")) === "true"),
            );
            return rejected.filter(Boolean).length === 1 ? true : null;
          },
          { label: "one edit is marked rejected", timeoutMs: 10_000 },
        );

        // Approve the rest.
        await (await s.byTestId("agentReview.approveAll")).click();
        await s.waitForElement(testIdSelector("agentReview.applyReport"), {
          timeoutMs: 20_000,
        });
        // The report states what landed. A run that applied nothing would show a
        // report too, so the count is the assertion rather than the report's
        // presence.
        const applied = await (await s.byTestId("agentReview.appliedCount")).textContent();
        expect(applied).not.toContain("0");

        await (await s.byTestId("agentReview.close")).click();
        await waitForSaved(s);
        // The note changed. The specific text depends on the stub engine, so the
        // assertion is that the body is no longer what was typed.
        expect(await editorText(s)).not.toBe(original);
      },
    );
  });
});

aiDescribe("ag2 the running scope total is continuously visible", () => {
  // Vault-count precondition: 1 (weak KDF). Requires the local-inference-stub build.
  it("shows the scope total during the run and on the review screen", async () => {
    let password = "";
    await scenario(
      "ag2-agent-scope-total",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "ag2notealfa7k2m9qx4w8e5rj0bb");
        await typeIntoEditor(s, "one two three");
        await waitForSaved(s);
        await enableAi(s);
        await openComposerInEditMode(s);
        await startRun(s, "tidy this note");

        // On the review screen. This is the number that bounds accumulation, and
        // the design carries no cap, so its absence is a real regression rather
        // than a cosmetic one.
        //
        // **This scenario covers the run once it has settled, not its first
        // leg**, and the difference used to be the whole gap: the surface got a
        // run id only from the step's reply, so during the run itself there was
        // no strip, no total and no Stop (myne-md/myne#544). The stub answers in
        // milliseconds, so racing the strip here would be a flake rather than a
        // check; the first-leg half is pinned where it can be driven directly,
        // in `tests/notes/agentRunOpen.test.ts` and in
        // `plugins::agent::commands::tests::the_run_view_is_sent_before_the_loop_is_driven`.
        const total = await (await s.byTestId("agentReview.scopeTotal")).textContent();
        expect(total.length).toBeGreaterThan(0);
        expect(total).toMatch(/\d/);
      },
    );
  });
});

aiDescribe("ag3 a removing edit is not carried by the bulk approve", () => {
  // Vault-count precondition: 1 (weak KDF). Requires the local-inference-stub build.
  //
  // **What this covers and what it does not.** The stub proposes a `trashed:`
  // edit, so this drives ONE member of the removal class end to end: the split,
  // the per-field label, the separate act, and the note on disk after a bulk
  // approve. The class itself — all five of `isLiveNote`'s fields — is pinned
  // where it can be driven directly and asserted on the written bytes, in
  // `core/src/plugins/agent/apply.rs::a_bulk_approval_cannot_remove_a_note_by_any_marker`.
  // Widening this scenario would mean scripting four more stub replies to
  // re-test wiring this one already proves.
  //
  // (This comment used to say the scenario self-skips when the stub proposes no
  // trashing edit. It does not, and has not since the stub was scripted — the
  // paragraph below is the live rule. A stale claim of a self-skip is worse
  // than none: it invites a reader to explain away an absent flag.)
  it("leaves the removed note untouched until its own act is taken", async () => {
    let password = "";
    await scenario(
      "ag3-agent-trash-carveout",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "ag3notealfa7k2m9qx4w8e5rj0cc");
        await typeIntoEditor(s, "delete this note please");
        await waitForSaved(s);
        await enableAi(s);
        await openComposerInEditMode(s);
        await startRun(s, "trash this note");

        // NOT a self-skip. This used to return early with a warning when the
        // stub proposed no trashing edit, and the stub never did, so the
        // scenario passed green while exercising nothing, permanently, on the
        // one control `0515` and `threat-model.md` §7 call structural. The stub
        // now emits a trashing edit for this task text, so an absent flag is a
        // failure and says which half broke.
        const flags = await s.byTestIdAll("agentReview.removalFlag");
        expect(
          flags.length,
          "the stub proposes a trashing edit for this task; if it stopped, the " +
            "carve-out is untested rather than passing",
        ).toBeGreaterThan(0);

        // A removing edit renders its own act rather than riding the bulk one.
        expect((await s.byTestIdAll("agentReview.applyRemoval")).length).toBe(flags.length);

        // And the flag says WHICH removal. The label is per field now, so a row
        // that rendered the generic string, or the wrong field's string, would
        // be telling the user something false at the moment they decide. The
        // stub's edit writes `trashed:`, so this is the Trash sentence.
        expect(await flags[0].text()).toBe("Moves this note to Trash");

        // The bulk approve must not carry it. Approve everything, then assert the
        // note did NOT gain the marker: the state, not the label.
        await (await s.byTestId("agentReview.approveAll")).click();
        await s.waitForElement(testIdSelector("agentReview.applyReport"), {
          timeoutMs: 20_000,
        });
        await (await s.byTestId("agentReview.close")).click();
        await waitForSaved(s);
        expect(await editorText(s)).not.toContain("trashed:");
      },
    );
  });
});

aiDescribe("ag4 undo after the review screen is closed", () => {
  // Vault-count precondition: 1 (weak KDF). Requires the local-inference-stub build.
  it("reverts the run from the composer strip once the screen is gone", async () => {
    let password = "";
    await scenario(
      "ag4-agent-undo-after-close",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "ag4notealfa7k2m9qx4w8e5rj0dd");
        await typeIntoEditor(s, "alpha beta gamma delta");
        await waitForSaved(s);
        // The baseline is what the EDITOR shows, not what was typed. `editorText`
        // reads `.cm-content`'s textContent, which concatenates CM6 lines with no
        // separator and, in Live preview, hides markdown markers on non-cursor
        // lines. Comparing against the typed string would therefore assert
        // something the readout never equals, and the failure would look like a
        // broken undo rather than a broken assumption.
        const original = await editorText(s);
        await enableAi(s);
        await openComposerInEditMode(s);
        await startRun(s, "tidy this note");

        await (await s.byTestId("agentReview.approveAll")).click();
        await s.waitForElement(testIdSelector("agentReview.applyReport"), {
          timeoutMs: 20_000,
        });

        // Close FIRST. This is the whole point of the scenario: an undo pressed
        // while the review screen is up passes against a build where the record
        // lives only in that screen.
        await (await s.byTestId("agentReview.close")).click();
        await waitForSaved(s);
        const afterApply = await editorText(s);
        expect(afterApply).not.toBe(original);

        // The offer is on the composer, reachable with the screen gone.
        await s.waitForElement(testIdSelector("agentUndoLast.root"), {
          timeoutMs: 15_000,
        });
        await (await s.byTestId("agentUndoLast.undo")).click();
        await s.waitForElement(testIdSelector("agentUndoLast.result"), {
          timeoutMs: 20_000,
        });

        // The note is back. Asserted on the text rather than on the report,
        // because a report can say "1 restored" while the bytes did not move.
        await s.waitUntil(
          async () => ((await editorText(s)) === original ? true : null),
          { label: "the note is back to its pre-run text", timeoutMs: 15_000 },
        );

        // And the offer is gone, so a second press cannot restore the same
        // snapshots over anything written since.
        expect((await s.byTestIdAll("agentUndoLast.undo")).length).toBe(0);
      },
    );
  });
});

aiDescribe("ag5 a model-requested scope expansion is approved by the user", () => {
  // Vault-count precondition: 1 (weak KDF). Requires the local-inference-stub build.
  //
  // NOT a self-skip, for the same reason as ag3. The stub returns a
  // `request_scope` action for task text containing "other folders"
  // (`local_inference/engine.rs`), and this scenario's task is "look in my other
  // folders too", so a run that settles without pausing for approval is a
  // product defect rather than a harness fact.
  it("shows the four facts and resumes the same run on approval", async () => {
    let password = "";
    await scenario(
      "ag5-agent-scope-expansion",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "ag5notealfa7k2m9qx4w8e5rj0ee");
        await typeIntoEditor(s, "one two three");
        await waitForSaved(s);
        await enableAi(s);
        await openComposerInEditMode(s);

        const input = await s.byTestId("ai.composer-input");
        await input.click();
        await input.sendKeys("look in my other folders too");
        await (await s.byTestId("ai.composer-send")).click();

        // Either the dialog appears or the run settles. Waiting for both keeps
        // the skip honest: a timeout here would be indistinguishable from the
        // stub simply never asking.
        const asked = await s.waitUntil(
          async () => {
            if ((await s.byTestIdAll("agentScope.dialog")).length > 0) {
              return "dialog";
            }
            if ((await s.byTestIdAll("agentReview.screen")).length > 0) {
              return "settled";
            }
            return null;
          },
          { label: "an expansion request or a settled run", timeoutMs: 30_000 },
        );
        // NOT a self-skip, for the same reason as ag3. The stub now requests an
        // expansion for this task text, so a settled run means the request path
        // broke rather than that the harness could not reach it.
        expect(
          asked,
          "the stub requests a scope expansion for this task; a settled run " +
            "means the request path is broken, not that it was unreachable",
        ).toBe("dialog");

        // The four facts the approval needs: which folder, how many notes, what
        // the total becomes, and that the reason is the MODEL's claim.
        // `grant` carries the folder and its note count, `total` what the run's
        // scope becomes, `reason` the model's stated claim.
        for (const id of [
          "agentScope.grant",
          "agentScope.total",
          "agentScope.reason",
        ]) {
          const text = await (await s.byTestId(id)).textContent();
          expect(text.length).toBeGreaterThan(0);
        }
        // The fourth fact: whether approving sends more text off the device.
        // Present on both arms (local and remote), so its absence is a defect
        // rather than a configuration.
        expect((await s.byTestIdAll("agentScope.egress")).length).toBe(1);

        // Approving resumes the SAME run rather than starting a second one.
        const before = await (await s.byTestId("agentScope.total")).textContent();
        await (await s.byTestId("agentScope.approve")).click();
        await s.waitForElement(testIdSelector("agentReview.screen"), {
          timeoutMs: 30_000,
        });
        const total = await (await s.byTestId("agentReview.scopeTotal")).textContent();
        expect(total).toMatch(/\d/);
        expect(before.length).toBeGreaterThan(0);
      },
    );
  });
});

aiDescribe("ag6 one composer serves both modes, into one transcript", () => {
  // Vault-count precondition: 1 (weak KDF). Requires the local-inference-stub build.
  it("answers a question and runs an edit from the same input", async () => {
    let password = "";
    await scenario(
      "ag6-one-composer",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "ag6notealfa7k2m9qx4w8e5rj0ff");
        await typeIntoEditor(s, "one two three");
        await waitForSaved(s);
        await enableAi(s);
        await runPaletteAction(s, "ai.open-chat", "chat");

        // **One input, and the count is the assertion.** The tab used to mount
        // two composers with two Send buttons, which is the whole of what
        // myne-md/myne#533 changed; a regression that re-added the second one
        // would be invisible to every other scenario here, since each drives
        // whichever input its own testid happens to find.
        await s.waitForElement(testIdSelector("ai.composer"), { timeoutMs: 15_000 });
        expect((await s.byTestIdAll("ai.composer-input")).length).toBe(1);
        expect((await s.byTestIdAll("ai.composer-send")).length).toBe(1);
        // Ask mode makes no grant, so it offers no scope control.
        expect((await s.byTestIdAll("ai.composer-scope")).length).toBe(0);

        // Ask, from that one input.
        const ask = await s.byTestId("ai.composer-input");
        await ask.click();
        await ask.sendKeys("what is this note about?");
        await (await s.byTestId("ai.composer-send")).click();
        // **Wait for the stream to END, not for the turns to appear.** The turn
        // count reaches two at the SEND dispatch, while the composer is still
        // `disabled={streaming}`, so a mode switch keyed on the count would
        // drive a textarea that is switched off and depend on the next lookup
        // happening to block long enough. `data-streaming` is the fact this
        // step actually needs.
        await s.waitUntil(
          async () => {
            const turns = await s.byTestIdAll("ai.turn");
            if (turns.length < 2) return null;
            const last = turns[turns.length - 1]!;
            return (await last.attribute("data-streaming")) === "false" ? true : null;
          },
          { label: "the question was answered and the stream closed", timeoutMs: 20_000 },
        );

        // Switch the SAME input to Edit and run against the open note.
        await clickByTestId(s, "ai.composer-mode-edit");
        await s.waitForElement(testIdSelector("ai.composer-scope"), {
          timeoutMs: 5_000,
        });
        expect((await s.byTestIdAll("ai.composer-input")).length).toBe(1);
        // The same helper every other scenario starts with, on the same input:
        // that it works unchanged after a mode switch IS half of what this
        // scenario claims.
        await startRun(s, "tidy this note");
        await (await s.byTestId("agentReview.close")).click();

        // Both flows landed in ONE transcript, in order, and the run's turn
        // still states its outcome after the review screen has been closed, which
        // is when `clearAgent()` drops the proposal it was reading.
        await s.waitUntil(
          async () => ((await s.byTestIdAll("ai.turn")).length >= 4 ? true : null),
          { label: "the run appended its own turns", timeoutMs: 15_000 },
        );
        const turns = await s.byTestIdAll("ai.turn");
        const kinds = await Promise.all(turns.map((el) => el.attribute("data-kind")));
        // The ask exchange, then BOTH halves of the run: the task the user sent
        // belongs to the agent flow even though it renders as an ordinary
        // bubble, and `data-kind` reports the flow.
        expect(kinds.slice(0, 2)).toEqual(["text", "text"]);
        expect(kinds.slice(2)).toEqual(["agent", "agent"]);
        expect((await s.byTestIdAll("ai.transcript")).length).toBe(1);
        await s.waitForElement(testIdSelector("ai.agent-summary"), { timeoutMs: 15_000 });
      },
    );
  });
});
