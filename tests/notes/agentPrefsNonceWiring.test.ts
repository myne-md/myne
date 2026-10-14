// The store's prefs-nonce bump is a per-client BINDING, and an uninstalled one
// has to fail loudly (myne-md/myne#850).
//
// **Why this is its own file rather than a case in `agentSettingsReview.test.ts`.**
// The binding is module state: the other file installs one to drive the happy
// path, so a throw assertion there would only be true while it happened to run
// first, which is the fragile-fixture shape ("the injection lands and the test
// passes anyway"). This file's module registry never installs a bump, so the
// unwired state is the only state there is.
//
// The failure it pins is silent in production: without the bump a setting the
// agent changed lands in `vault.prefs` while every mounted `usePrefs` keeps
// rendering the value it replaced, and nothing else on this side can see it.

import { describe, expect, it } from "vitest";

import { applyOutcome } from "./_agentApplyOutcome";
import { currentRunEpoch, settleApply } from "../../src/notes/agent/agentStore";

describe("the prefs-nonce binding", () => {
  it("refuses to apply a setting change when the client installed no bump", () => {
    expect(() =>
      settleApply(
        applyOutcome({
          applied: 0,
          notesWritten: [],
          restorePoints: [],
          settingsChanged: [
            { intentId: "editor.weekly-notes-folder", previous: null },
          ],
        }),
        [],
        currentRunEpoch(),
        [0],
      ),
    ).toThrow(/prefs-nonce bump is installed/);
  });

  it("applies a note-only outcome with no bump installed, because no preference moved", () => {
    expect(settleApply(applyOutcome(), [], currentRunEpoch())).toBe(true);
  });
});
