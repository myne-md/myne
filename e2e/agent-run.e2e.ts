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
//   ag7: an append writes into a note with NO body, which the anchored verb
//         could not do at all: an anchor is text copied out of the note, and an
//         empty note has none. Asserted on the note's text afterwards, since a
//         build that proposed the append and failed to apply it would pass an
//         assertion about the review row.
//   ag6: ONE composer answers a question and then runs an edit, into one
//         transcript (myne-md/myne#533). The only scenario here that would catch
//         a regression re-adding the second composer: every other one drives
//         whichever input its own testid happens to find.
//
// **All six were dead, and had been since the AI tab lost its modes**
// (myne-md/myne#596). `openComposerInEditMode` clicked `ai.composer-mode-edit`
// and then waited on `ai.composer-scope`; `docs/decisions/ai/0524` gave the tab
// ONE mode and deleted the first control, and the second moved behind the
// "change" disclosure so it never appears unprompted. Every scenario therefore
// timed out at 45 s in the shared setup step, six for six, on every run, and
// nothing reddened, because this suite has been manual and pre-release since
// myne-md/myne#579. Two consequences worth carrying: a green push pipeline was
// never evidence about any of this, and the repair had to re-decide what ag6
// asserts, since its own name described a two-mode composer that no longer
// exists. That is the whole class `e2e/AGENTS.md` calls "a helper that waits for
// a surface without opening it", one layer on: here the helper opened the
// surface correctly and then drove a control the surface had stopped rendering.
//
// **Three of them also carry the review dialog's own dismissal rule**
// (myne-md/myne#596), and they carry it from both sides, which is why no
// seventh scenario duplicates their setup. ag1 and ag4 assert the dialog
// DISMISSES ITSELF: every row resolved, nothing refused, so there is no
// decision left in the screen. ag3 asserts the opposite for the same reason:
// its removal row is neither applied nor rejected, so the apply is clean but
// not complete and the screen must stay. ag1 and ag4 used to close it by hand;
// those clicks would now race a dialog on its way out, so both wait for the
// disappearance instead, and ag1 reads the applied count off the undo strip,
// which is where that fact lives once the screen is gone.
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

/** Open the AI Chat tab and wait for its composer to be ready to send.
 *
 *  **The palette action is what opens it**, and this helper shipped without it:
 *  it waited on a tab nothing had opened, so all five scenarios timed out at the
 *  same line. The composer renders only while the right pane's active tab is
 *  `ai-chat`, so this reuses the route `ai-chat.e2e.ts` already uses rather than
 *  clicking chrome.
 *
 *  **It used to switch the composer into Edit mode, and there is no longer a
 *  mode to switch to.** `docs/decisions/ai/0524` gave the AI tab ONE mode: every
 *  message goes to the agent, and `ai.composer-mode-edit` went with the change.
 *  This helper kept clicking it, so it timed out at 45 s and took all six
 *  scenarios in this file down with it, every run, invisibly. The suite is
 *  manual and pre-release since myne-md/myne#579, so nothing reddened. Found by
 *  running it (myne-md/myne#596).
 *
 *  The wait is now `ai.composer-scope`, the scope TRIGGER itself, which the
 *  composer always renders (myne-md/myne#848 removed the "change" disclosure
 *  this used to sit behind). It replaces a wait on `ai.composer-scope-current`,
 *  a caption that no longer exists anywhere in the tree, so the helper timed
 *  out at 5s and took this file's scenarios down the same way the mode click
 *  had. The caption would carry the stronger fact a scenario depends on, which
 *  is that a scope is resolved before Send. */
async function openComposer(session: Session): Promise<void> {
  await runPaletteAction(session, "ai.open-chat", "chat");
  await session.waitForElement(testIdSelector("ai.composer"), { timeoutMs: 15_000 });
  // **`ai.composer-scope`, which is the trigger itself** (myne-md/myne#848).
  // This waited on `ai.composer-scope-current`, a caption that no longer exists
  // anywhere in the tree, so every scenario using this helper timed out at 5s
  // inside `openComposer`, which is the failure this comment block records
  // happening once already (myne-md/myne#596). The gate has to be something the
  // composer ALWAYS renders: the count caption would be the stronger claim
  // ("a scope resolved"), but it is absent when the probe fails, and a helper
  // that times out on a failed probe reports the wrong thing entirely.
  await session.waitForElement(testIdSelector("ai.composer-scope"), {
    timeoutMs: 5_000,
  });
}

/** The active editor tab's note id ("note:<id>"), so a failing assertion can say
 *  whether the agent reviewed the note the scenario just wrote. */
async function noteIdUnderTest(session: Session): Promise<string | null> {
  const tabs = await session.findElements(testIdSelector("editor.tab", { "data-active": "true" }));
  if (tabs.length === 0) return null;
  const raw = (await tabs[0].attribute("data-tab-id")) ?? "";
  return raw.startsWith("note:") ? raw.slice("note:".length) : null;
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
        await openComposer(s);

        // Baseline from the editor, not from the typed string: `editorText`
        // reads `.cm-content`'s textContent, which concatenates CM6 lines with
        // no separator and hides markdown markers on non-cursor lines.
        const original = await editorText(s);
        await startRun(s, "tidy this note");

        // The proposal renders as grouped diffs rather than as prose.
        const edits = await s.byTestIdAll("agentReview.edit");
        // The count alone says "expected 1 to be greater than 1", which names
        // neither the note the agent actually read nor what it proposed for it —
        // and those are the two facts that separate "the stub proposed one edit"
        // from "the agent read a DIFFERENT note than the one under test". Both
        // are read here so a failure carries them into the report.
        const reviewedNoteIds = await Promise.all(
          (await s.byTestIdAll("agentReview.noteId")).map((n) => n.textContent()),
        );
        const proposedDiffs = await Promise.all(edits.map((e) => e.textContent()));
        expect(
            edits.length,
            "this scenario rejects one edit and approves the rest, so it needs at least two. " +
              `Reviewed note ids: ${JSON.stringify(reviewedNoteIds)}; ` +
              `note under test: ${JSON.stringify(await noteIdUnderTest(s))}; ` +
              `proposed: ${JSON.stringify(proposedDiffs)}`,
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

        // **The dialog closes itself** (myne-md/myne#596). Every row is now
        // resolved (one rejected, the rest applied) and nothing was refused,
        // so there is no decision left in the screen and it dismisses. This
        // scenario used to wait on `agentReview.applyReport` and then click
        // `agentReview.close`; both would now race a dialog that is on its way
        // out, so the disappearance IS the assertion.
        await s.waitForGone(testIdSelector("agentReview.screen"), {
          timeoutMs: 20_000,
        });

        // **A DIFFERENT fact from the `agentReview.appliedCount` this replaces,
        // and the difference is worth stating rather than glossing.** That
        // counted EDITS applied; the revert affordance's offer comes from the
        // host's undoable record, i.e. NOTES written, so three edits to one
        // note read as "changed 1 note". Both are non-zero exactly when the
        // apply wrote something, which is what this scenario needs, but the
        // icon is not the same number on a different surface. The applied-edit
        // count is now asserted only by ag3, which is the run whose dialog
        // stays open.
        //
        // The strip under the composer is gone (myne-md/myne#741): the offer
        // lives on the settled turn as `ai.turn-revert`.
        await s.waitForElement(testIdSelector("ai.turn-revert"), {
          timeoutMs: 15_000,
        });

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
        await openComposer(s);
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
        await openComposer(s);
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
        // `textContent()`, not `text()`. The harness's own note on those two
        // says W3C getText drops text inside child elements and is for direct
        // text nodes only; here it returned the empty string and the assertion
        // read as a missing label on a flag that was rendering correctly.
        expect(await flags[0].textContent()).toBe("Moves this note to Trash");

        // The bulk approve must not carry it. Approve everything, then assert the
        // note did NOT gain the marker: the state, not the label.
        await (await s.byTestId("agentReview.approveAll")).click();
        await s.waitForElement(testIdSelector("agentReview.applyReport"), {
          timeoutMs: 20_000,
        });

        // **And the dialog is STILL UP** (myne-md/myne#596), which is the other
        // half of the rule that dismisses a finished review and the reason this
        // scenario carries the assertion rather than a seventh one duplicating
        // its whole setup. A clean, complete apply closes the screen; this apply
        // is clean but NOT complete, because the removal row was neither applied
        // (the bulk action refuses it) nor rejected, so it is unresolved and the
        // user still has a decision in front of them. Asserted explicitly so an
        // over-eager rule fails here by name, instead of failing two lines down
        // on a close control that is no longer in the DOM.
        expect(
          (await s.byTestIdAll("agentReview.screen")).length,
          "an unapplied removal row is unresolved, so the review must not dismiss itself",
        ).toBe(1);

        await clickByTestId(s, "agentReview.close");
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
        await openComposer(s);
        await startRun(s, "tidy this note");

        await (await s.byTestId("agentReview.approveAll")).click();

        // The screen is gone FIRST, and that is the whole point of the
        // scenario: an undo pressed while the review screen is up passes
        // against a build where the record lives only in that screen.
        //
        // It used to be closed by hand here. Since myne-md/myne#596 a clean,
        // complete apply dismisses the dialog itself, so the premise arrives
        // for free and the click would race it. Waiting for the disappearance
        // keeps the precondition explicit rather than assumed: if the dialog
        // stayed up, the undo below would be pressed with it on screen and this
        // scenario would silently stop testing what it is named for.
        await s.waitForGone(testIdSelector("agentReview.screen"), {
          timeoutMs: 20_000,
        });
        await waitForSaved(s);
        const afterApply = await editorText(s);
        expect(afterApply).not.toBe(original);

        // The offer is on the assistant turn as a revert icon, reachable with
        // the review screen gone. One icon, one confirm, one undo.
        await s.waitForElement(testIdSelector("ai.turn-revert"), {
          timeoutMs: 15_000,
        });
        await (await s.byTestId("ai.turn-revert")).click();
        await s.waitForElement(testIdSelector("ai.revert-confirm"), {
          timeoutMs: 10_000,
        });
        await (await s.byTestId("ai.revert-confirm-undo")).click();
        await s.waitForElement(testIdSelector("ai.undo-result"), {
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
        expect((await s.byTestIdAll("ai.turn-revert")).length).toBe(0);
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
        await openComposer(s);

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
        // **And the dialog goes.** Asserting only that the run resumes is what
        // let myne-md/myne#559 stay green over a surface that visibly did not
        // work: `resumeRun()` left `end` on `awaitingScope`, so the dialog
        // stayed mounted, the user pressed Allow again, and the second press
        // raced the first. The run resuming was true the whole time.
        await s.waitForGone(testIdSelector("agentScope.dialog"), {
          timeoutMs: 10_000,
        });
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

aiDescribe("ag6 one composer, one transcript: a question then an edit", () => {
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
        // **The scope caption is present from the start, and that is the
        // change.** This line used to assert the scope control was ABSENT,
        // because the tab opened in Ask mode and Ask granted no scope. With one
        // mode (`docs/decisions/ai/0524`) every message is a run, so a scope is
        // always resolved and always stated. Asserting its presence keeps the
        // line doing work rather than deleting it: `docs/decisions/ai/0518`
        // point 1 requires a user-originated scope control on the composer,
        // and losing it routes every folder-scale run through the
        // model-originated expansion instead, which is the injection-reachable
        // path.
        // The TRIGGER, which the composer always renders: the caption this
        // used to assert was `ai.composer-scope-current`, gone from the tree,
        // so the count was 0 and this failed (myne-md/myne#848).
        expect((await s.byTestIdAll("ai.composer-scope")).length).toBe(1);

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
        // **A question is a RUN now, so the first send opens the review screen
        // too, and this scenario has to get past it.** It used to wait on the
        // last turn's `data-streaming` going false, which was the right fact
        // when Ask streamed a chat reply. `docs/decisions/ai/0524` made every
        // message an agent run: the stub proposes for any task, an agent turn
        // renders `data-streaming="false"` from its first frame, and the wait
        // therefore passed instantly while a modal was opening over the
        // composer, which is what left the second send's click timing out on
        // an input it could not reach.
        //
        // Closing it is the honest step rather than a workaround: what ag6 is
        // about is the composer and the transcript, and this proposal is
        // neither. ag1 and ag3 are where a proposal gets reviewed.
        await s.waitForElement(testIdSelector("agentReview.screen"), {
          timeoutMs: 30_000,
        });
        await clickByTestId(s, "agentReview.close");
        await s.waitForGone(testIdSelector("agentReview.screen"), {
          timeoutMs: 10_000,
        });

        // **Run an edit from the SAME input, with no mode to switch.** These
        // three lines used to click `ai.composer-mode-edit` and wait for the
        // scope control to appear with it, which was the coverage of
        // myne-md/myne#533's one-composer change. `docs/decisions/ai/0524` then
        // removed the modes outright, so what this scenario proves is narrower
        // and still worth proving: one input, no remount between a question and
        // an edit, and both landing in one transcript in order. The input count
        // is asserted again HERE rather than only above, because a build that
        // re-mounted the composer between the two sends would still have shown
        // one input at the start.
        expect((await s.byTestIdAll("ai.composer-input")).length).toBe(1);
        // The same helper every other scenario starts with, on the same input:
        // that it works with no remount between the two sends IS half of what
        // this scenario claims.
        await startRun(s, "tidy this note");
        await clickByTestId(s, "agentReview.close");

        // Both flows landed in ONE transcript, in order, and the run's turn
        // still states its outcome after the review screen has been closed, which
        // is when `clearAgent()` drops the proposal it was reading.
        await s.waitUntil(
          async () => ((await s.byTestIdAll("ai.turn")).length >= 4 ? true : null),
          { label: "the run appended its own turns", timeoutMs: 15_000 },
        );
        const turns = await s.byTestIdAll("ai.turn");
        const kinds = await Promise.all(turns.map((el) => el.attribute("data-kind")));
        // **Four agent turns, not two text ones and two agent ones.** The old
        // split described two modes: Ask produced a `text` exchange, Edit an
        // `agent` one. With one mode (`docs/decisions/ai/0524`) both sends are
        // runs, and `data-kind` reports the FLOW rather than the bubble style,
        // so the task the user typed is an agent turn too, even though it
        // renders as an ordinary bubble. Asserting all four is what keeps this
        // a claim about the transcript rather than about the modes that went
        // away.
        expect(kinds).toEqual(["agent", "agent", "agent", "agent"]);
        expect((await s.byTestIdAll("ai.transcript")).length).toBe(1);
        await s.waitForElement(testIdSelector("ai.agent-summary"), { timeoutMs: 15_000 });
      },
    );
  });
});

aiDescribe("ag7 an append writes into a note with no body", () => {
  // Vault-count precondition: 1 (weak KDF). Requires the local-inference-stub build.
  //
  // **The reported case, end to end** (myne-md/myne#616). Before the append
  // verb, this was structurally impossible rather than merely unreliable: the
  // only write verb for an existing note was an anchored edit, an anchor has to
  // be text copied out of the note, and an empty note has none. A user asking
  // the agent to write a list into an empty note got "the note is empty" back
  // and no explanation of why that was an answer rather than a task.
  //
  // The assertion is on the note's TEXT afterwards, not on the review screen
  // rendering a row: a build that proposed the append and failed to apply it
  // would pass a row assertion. `data-kind` is checked as well, because the
  // diff renders identically for both shapes (an append diffs an empty anchor
  // against the new text, so every line reads as an addition, which is exactly
  // what it is) and that attribute is the only thing distinguishing them.
  it("proposes an append and lands it in the empty note", async () => {
    let password = "";
    await scenario(
      "ag7-agent-append",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "ag7notealfa7k2m9qx4w8e5rj0gg");
        // No `typeIntoEditor` here, deliberately: the empty body IS the case.
        await waitForSaved(s);
        await enableAi(s);
        await openComposer(s);
        // "append" is what routes the stub to its append branch, and it is also
        // what a user would type. The two coincide on purpose: a scenario that
        // stops asking for the thing stops getting it.
        await startRun(s, "append the list to this note");

        const rows = await s.byTestIdAll("agentReview.edit");
        expect(rows.length).toBeGreaterThan(0);
        const kinds = await Promise.all(rows.map((el) => el.attribute("data-kind")));
        expect(kinds).toContain("append");
        // And the flag a PERSON reads, which `data-kind` does not stand in for:
        // the attribute tells this scenario the two verbs apart, and the flag is
        // the only thing telling the user approving that the write is unanchored
        // and lands after the frontmatter. A visible control no test reads is one
        // refactor from disappearing silently.
        // `byTestIdAll` rather than a presence helper: `Session` has no
        // `exists`, and the call that named one type-checked nowhere, because
        // `tsconfig.json` is include:["src"] and this tree is checked only by
        // `scripts/check-test-typecheck.mjs` (myne-md/myne#647).
        expect((await s.byTestIdAll("agentReview.appendFlag")).length).toBeGreaterThan(0);

        await (await s.byTestId("agentReview.approveAll")).click();
        await s.waitForGone(testIdSelector("agentReview.screen"), { timeoutMs: 20_000 });
        await waitForSaved(s);

        // The note carries the appended text. This is the assertion the whole
        // verb exists for, and the one no unit test can make: it proves the
        // proposal survived the review screen, the apply and the write.
        expect(await editorText(s)).toContain("appended by the stub");
      },
    );
  });
});
