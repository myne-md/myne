// A setting change, end to end (myne-md/myne#850). Drives one run that proposes
// THREE settings through the `agentReview.setting*` testids on the real
// tauri-driver harness, against the **`local-inference-stub` build variant**, so
// it runs only when the AI-feature binary is under test, gated on
// `MYNE_E2E_AI=1` exactly like its `agent-run.e2e.ts` siblings.
//
//   ag8: the agent proposes three setting changes; the review screen renders each
//         as its own kind of row with the value in place and the value asked
//         for on one line; approving TWO on their own writes those settings and
//         leaves the third untouched; the run summary counts the settings
//         alongside created and edited.
//
// **Three rows rather than one, and that is the scenario's design.** A run whose
// only row is applied resolves completely, and a clean, complete apply closes
// the review screen and takes the run summary with it. With three, two are
// approved on their own, the screen stays open on the third, and the summary is
// on screen while it says "2 settings changed".
//
// **The value is read back through production IPC, not through the UI that
// claims to have written it.** The page-seat `prefs_read` is the vault's own
// preference file, so a build that rendered an approved change and never made
// it fails here. That matters more than usual for this feature: the write goes
// through the Rust setter rather than the frontend's `writePref`, so a scenario
// that only read the screen would be asserting on the one half that is
// frontend-local.
//
// **And the second row is asserted NOT to have been written.** A screen that
// applied every row when one was clicked would pass the first assertion alone,
// so the pair is what pins "its own act".
//
// The stub's script is fixed (`StubEngine::agent_script`), and its setting
// branch emits the three real intent ids, so what this drives is the whole chain
// rather than a stub-only path: the settings index's verdict, the catalogue the
// client builds from it, the system block the host renders, the parser, and the
// proposal. **What it does and does not do about skipping, stated because this
// line used to claim it never skips:** it is bound to the same `MYNE_E2E_AI=1`
// gate its `agent-run.e2e.ts` siblings use, so it self-skips outside the AI lane,
// and `scripts/e2e-scenario-floor.json` records that the floor was deliberately not
// raised for it. Inside that lane it has no binary, fixture or platform guard, so
// it does execute wherever the lane runs.
//
// KDF: weak generator fixture (SYNC-9: params are vault.meta-resident).

import { describe, expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  clickByTestId,
  createNote,
  dismissImporterOffer,
  enableAi,
  pageSeatInvoke,
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
 *  The palette action is what OPENS it: the composer renders only while the
 *  right pane's active tab is `ai-chat`, and a helper that waits for a surface
 *  without opening it fails every scenario at the same line while reading as a
 *  flake (`e2e/AGENTS.md`, and `agent-run.e2e.ts` shipped exactly that bug
 *  twice). The wait is `ai.composer-scope`, the trigger the composer always
 *  renders. */
async function openComposer(session: Session): Promise<void> {
  await runPaletteAction(session, "ai.open-chat", "chat");
  await session.waitForElement(testIdSelector("ai.composer"), { timeoutMs: 15_000 });
  await session.waitForElement(testIdSelector("ai.composer-scope"), { timeoutMs: 5_000 });
}

/** The vault's preferences, through production IPC from the page seat. */
async function prefsView(session: Session): Promise<{
  periodic_notes?: Record<string, string>;
  new_note_location?: string | null;
  new_note_location_folder?: string | null;
}> {
  const result = await pageSeatInvoke(session, "plugin:prefs|prefs_read", {}, 10_000);
  return (
    (result.ok as {
      periodic_notes?: Record<string, string>;
      new_note_location?: string | null;
      new_note_location_folder?: string | null;
    }) ?? {}
  );
}

/** Just the periodic-notes map, which is what most of the assertions want. */
async function prefsPeriodicNotes(
  session: Session,
): Promise<Record<string, string>> {
  return (await prefsView(session)).periodic_notes ?? {};
}

aiDescribe("ag8 setting change → review → approve one → the value is written", () => {
  // Vault-count precondition: 1 (weak KDF). Requires the local-inference-stub build.
  it("writes the approved setting on its own and leaves the second row alone", async () => {
    let password = "";
    await scenario(
      "ag8-agent-setting",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        // **A note has to be open before the AI tab exists at all.** The composer
        // renders in the right pane's `ai-chat` tab, and with no note open there
        // is no right pane to put it in: the palette action succeeds and the
        // composer never appears, which is a 15 s timeout in `openComposer` that
        // names the ELEMENT rather than the missing pane. Every scenario in
        // `agent-run.e2e.ts` creates one first for this reason.
        // **The pre-run state the undo has to restore for the one setting with two
        // fields** (2026-10-13 review: nothing in the tree carried a non-`None`
        // `previous_folder`, so the fix that records it was verified by nothing).
        // `files.new-note-location` is written as a mode plus a folder, and the
        // defect this pins is that the undo used to rebuild the folder from live
        // prefs, which by then held the agent's own value.
        const seeded = await pageSeatInvoke(
          s,
          "plugin:prefs|set_new_note_location",
          { location: "specific", folder: "OldBox" },
          10_000,
        );
        expect(seeded.err, "the location seed must land").toBeUndefined();

        await createNote(s, "ag8notealfa7k2m9qx4w8e5rj0aa");
        await typeIntoEditor(s, "alpha beta gamma delta");
        await waitForSaved(s);
        await enableAi(s);
        await openComposer(s);

        const input = await s.byTestId("ai.composer-input");
        await input.click();
        await input.sendKeys("change my weekly notes folder");
        await (await s.byTestId("ai.composer-send")).click();
        // **The wait carries the page's own words into the failure.** A review
        // screen that never appears has several causes that look identical from
        // here: the run never started (a refused probe, a provider gate), it
        // ended with an empty proposal, or it errored. Each of those leaves a
        // sentence in the chat panel, and a bare `waitForElement timed out`
        // names the ELEMENT, which is the one fact already known. This is the
        // `e2e/AGENTS.md` rule for a diagnostic that would otherwise lie with
        // confidence.
        try {
          await s.waitForElement(testIdSelector("agentReview.screen"), {
            timeoutMs: 30_000,
          });
        } catch (e) {
          const page = await s.execute<string>("return document.body.innerText");
          throw new Error(
            `${(e as Error).message}\n  the page said: ${JSON.stringify(page?.slice(0, 1200))}`,
          );
        }

        // **The row is its own kind of item, not a note edit wearing different
        // words**, and it carries the value asked for.
        const rows = await s.byTestIdAll("agentReview.settingChange");
        // **The screen's own words go into the failure message**, which is what
        // found the defect this scenario was written against. The host accepted
        // the change and raised no refusal, and the proposal still reached the
        // screen EMPTY, so `expected 2 to be 2` style output named the one fact
        // already known. Only in-source constants can appear here (the seeded
        // note's body and the two folder names in the task above), which is the
        // `e2e/AGENTS.md` exception that makes it safe to print.
        if (rows.length !== 3) {
          const page = await s.execute<string>("return document.body.innerText");
          throw new Error(
            `expected 3 setting rows, got ${rows.length}\n  the page said: ${JSON.stringify(page?.slice(0, 1500))}`,
          );
        }
        const line = await (
          await s.byTestId("agentReview.settingChange.value")
        ).textContent();
        expect(line, "the row names the value the run asked for").toContain(
          "Archived/Weekly",
        );

        // Approve rows 0 and 2 on their own, one act each, and leave row 1
        // outstanding. That outstanding row is what keeps the screen open so its
        // summary and its Undo button can be read.
        //
        // **Two rather than one, because they exercise different arms of the
        // write.** Row 0 is the weekly folder, a single-field target. Row 2 is the
        // new-note location, the one target with a second field, and the setting
        // whose undo was losing the folder it replaced. **The order is the
        // stub's**, which is why this addresses rows by position: the first version
        // of this scenario applied 0 and 1 and asserted monthly was untouched, and
        // the runner reported `monthly.folder` written, which was the test being
        // wrong rather than the app.
        await (await s.byTestIdAll("agentReview.settingApply"))[0].click();
        // A landed setting counts in the headline with the note edits
        // (myne-md/myne#894): one figure for "what this run has written", and the
        // per-row flag still says which row it was.
        await s.waitForElement(testIdSelector("agentReview.appliedCount"), {
          timeoutMs: 15_000,
        });
        // Re-found rather than reused: the row above re-rendered, so a captured
        // handle is stale (`e2e/AGENTS.md`).
        await (await s.byTestIdAll("agentReview.settingApply"))[2].click();
        // **The poll's success condition IS the assertion.** The first version
        // returned the element's text as soon as it was non-null, which it already
        // was ("1 setting changed." from the first apply), so the wait resolved
        // instantly on the stale value and the assertion below failed on a race
        // rather than on behaviour.
        await s.waitUntil(
          async () => {
            const el = await s.byTestId("agentReview.appliedCount");
            const text = (await el.textContent()) ?? "";
            return text.includes("2") ? text : null;
          },
          { label: "the summary counted both settings", timeoutMs: 15_000 },
        );

        // **The vault's own preferences, not the screen that claims to have
        // written them.**
        const notes = await prefsPeriodicNotes(s);
        expect(notes["weekly.folder"], "the approved setting was written").toBe(
          "Archived/Weekly",
        );
        expect(
          notes["monthly.folder"],
          "a row the user did not approve must not be written",
        ).toBeUndefined();
        const prefsAfterApply = await prefsView(s);
        expect(
          prefsAfterApply.new_note_location,
          "the location mode the run asked for was written",
        ).toBe("specific");
        expect(
          prefsAfterApply.new_note_location_folder,
          "and its folder half with it",
        ).toBe("Archived/Box");

        // **The undo, which no test drove before this review.** `undo_from_host`'s
        // settings branch had no unit test (it needs an `AppHandle`) and no
        // scenario pressed this button, so the whole restore path was unverified
        // while two of its four defects were found by reading. This is the correct
        // seam for it: the value comes back out of the vault's own preferences.
        //
        // It also pins the two client-side fixes that made the button reachable at
        // all: a settings-only apply has no restore points, so the button used to
        // be hidden for exactly the run it belongs to, and the report used to omit
        // the settings count.
        await clickByTestId(s, "agentReview.undo");
        await s.waitForElement(testIdSelector("agentReview.undoReport"), {
          timeoutMs: 20_000,
        });
        const report = await (
          await s.byTestId("agentReview.undoReport")
        ).textContent();
        // **Thrown with the report in the message rather than through `expect`.**
        // Vitest truncates an expectation diff at roughly eighty characters, and
        // that cut off exactly the part that distinguishes "no settings clause",
        // "a failed clause" and "a stale count": the three have the same opening
        // sentence.
        if (!report?.includes("2 settings put back")) {
          const page = await s.execute<string>("return document.body.innerText");
          throw new Error(
            `the undo report did not count the setting.\n  report: ${JSON.stringify(report)}\n  page: ${JSON.stringify(page?.slice(0, 900))}`,
          );
        }
        const afterUndo = await prefsPeriodicNotes(s);
        expect(
          afterUndo["weekly.folder"],
          "the undo removes the entry the run created, because there was none before",
        ).toBeUndefined();
        // **The assertion this scenario exists for on the undo side.** The folder
        // must be the one the run REPLACED, not the one it wrote: rebuilding it
        // from live prefs is the defect, and it reported success while permanently
        // replacing the user's own value.
        const prefsAfterUndo = await prefsView(s);
        expect(
          prefsAfterUndo.new_note_location_folder,
          "the undo puts back the folder the run replaced, not the one it wrote",
        ).toBe("OldBox");

        // Resolve the remaining row so the screen can close. It is the ONLY row
        // with a reject button left: an applied row renders none.
        const rejects = await s.byTestIdAll("agentReview.settingReject");
        await rejects[0].click();
      },
    );
  });
});
