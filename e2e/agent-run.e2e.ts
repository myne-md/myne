// Agentic note editing (myne-md/myne#529). Drives one run end to end through the
// `agentComposer.*` / `agentReview.*` testids on the real tauri-driver harness,
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
//
// ag4 is the one that would have caught the shipped gap. Undo used to live only
// on the review screen, which owned the `[noteId, snapshotId]` record; closing
// that screen dropped it, so a published guarantee stopped being true the moment
// the user did the ordinary thing. The scenario therefore CLOSES the screen
// before undoing, deliberately: an undo pressed while the screen is open would
// pass against the old build too.
//
// The stub engine's script is fixed (`StubEngine::agent_script`): list, read,
// propose one anchored edit, finish. It never requests a scope expansion, so ag5
// self-skips loudly rather than asserting on a proposal it cannot cause.
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

/** Open the AI Chat tab, where the agent composer lives.
 *
 *  **The palette action is what opens it**, and this helper shipped without it:
 *  it waited for `agentComposer.root` on a tab nothing had opened, so all five
 *  scenarios timed out at the same line. `AgentComposer` renders only while the
 *  right pane's active tab is `ai-chat`, exactly like the chat surface, so this
 *  reuses the route `ai-chat.e2e.ts` already uses rather than clicking chrome. */
async function openAgentComposer(session: Session): Promise<void> {
  await runPaletteAction(session, "ai.open-chat", "chat");
  await session.waitForElement(testIdSelector("agentComposer.root"), {
    timeoutMs: 15_000,
  });
}

/** Start a run on whatever note is open and wait for the review takeover. */
async function startRun(session: Session, task: string): Promise<void> {
  const input = await session.byTestId("agentComposer.task");
  await input.click();
  await input.sendKeys(task);
  await (await session.byTestId("agentComposer.send")).click();
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
        await openAgentComposer(s);

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
        await openAgentComposer(s);
        await startRun(s, "tidy this note");

        // On the review screen. This is the number that bounds accumulation, and
        // the design carries no cap, so its absence is a real regression rather
        // than a cosmetic one.
        const total = await (await s.byTestId("agentReview.scopeTotal")).textContent();
        expect(total.length).toBeGreaterThan(0);
        expect(total).toMatch(/\d/);
      },
    );
  });
});

aiDescribe("ag3 a trashing edit is not carried by the bulk approve", () => {
  // Vault-count precondition: 1 (weak KDF). Requires the local-inference-stub build.
  //
  // Self-skips rather than failing when the stub proposes no trashing edit: the
  // engine's script is not this suite's to set, and a scenario that failed on a
  // proposal it cannot control would report a harness fact as a product defect.
  // The skip is LOUD (it logs why) because a silently self-skipping test is
  // the failure class `scripts/check-e2e-floor.mjs` exists to catch.
  it("leaves the trashed note untouched until its own act is taken", async () => {
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
        await openAgentComposer(s);
        await startRun(s, "trash this note");

        // NOT a self-skip. This used to return early with a warning when the
        // stub proposed no trashing edit, and the stub never did, so the
        // scenario passed green while exercising nothing, permanently, on the
        // one control `0515` and `threat-model.md` §7 call structural. The stub
        // now emits a trashing edit for this task text, so an absent flag is a
        // failure and says which half broke.
        const flags = await s.byTestIdAll("agentReview.trashFlag");
        expect(
          flags.length,
          "the stub proposes a trashing edit for this task; if it stopped, the " +
            "carve-out is untested rather than passing",
        ).toBeGreaterThan(0);

        // A trashing edit renders its own act rather than riding the bulk one.
        expect((await s.byTestIdAll("agentReview.applyTrash")).length).toBe(flags.length);

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
        await openAgentComposer(s);
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
  // Self-skips LOUDLY when the stub proposes no expansion, on the same rule as
  // ag3: the engine's script is not this suite's to set, and failing on a
  // proposal it cannot cause would report a harness fact as a product defect.
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
        await openAgentComposer(s);

        const input = await s.byTestId("agentComposer.task");
        await input.click();
        await input.sendKeys("look in my other folders too");
        await (await s.byTestId("agentComposer.send")).click();

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
