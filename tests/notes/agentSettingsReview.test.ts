// A run that changed a setting, through the review surface's own rules
// (myne-md/myne#850).
//
// **The failure this file exists to catch is a silent one.** Before settings
// existed, "the run proposed something" and "the run proposed a note edit"
// were the same fact everywhere in this store and in `AgentReviewTakeover`. A
// settings-only run is the case where they come apart, and a gate left on the
// old fact does not error: the takeover simply does not open, the change the
// model made is never shown, and the user has no way to tell. Every assertion
// here is on the store's observable state rather than on a predicate's return
// value, the convention `agentReviewAutoClose.test.ts` states at its own head.

import { afterEach, describe, expect, it } from "vitest";

import type { Proposal, ProposedSetting } from "../../src/lib/agent-run";
import { applyOutcome } from "./_agentApplyOutcome";
import { bumpPrefsNonce, getPrefsNonce } from "../../src/notes/prefsNonce";
import { settingChangeLine } from "../../src/notes/agent/settingCatalogue";
import { currentSettingValue } from "../../src/notes/agent/settingCatalogue";
import { DEFAULT_PREFS } from "../../src/hooks/usePrefs";
import type { PrefsView } from "../../src/lib/prefs";
import {
  beginRun,
  clearAgentForLock,
  currentRunEpoch,
  getAgent,
  keptSettings,
  setAgentPrefsNonceBump,
  settleApply,
  settleStep,
  toggleSetting,
} from "../../src/notes/agent/agentStore";

// The store takes the prefs-nonce bump as a per-client BINDING (myne-md/myne#850):
// the nonce module differs between the desktop and mobile trees, so the store
// imports neither. Production installs it at each client's agent-run seam; this
// file drives the desktop one and installs it once for every settings case here.
// The UNWIRED case has its own file (`agentPrefsNonceWiring.test.ts`), because
// the binding is module state and can only be observed where nothing installed.
setAgentPrefsNonceBump(bumpPrefsNonce);

const VIEW = {
  runId: "run-1",
  scopeTotal: 1,
  userGrants: 1,
  modelGrants: 0,
  cancelled: false,
};

function setting(intentId = "editor.weekly-notes-folder", value = "J/Weekly"): ProposedSetting {
  return { intentId, value };
}

function settle(proposal: Proposal) {
  beginRun(null);
  settleStep(
    {
      view: VIEW,
      proposal,
      end: { kind: "finished" },
      iterations: 1,
      notesRead: 1,
      charsOffDevice: null,
      excludedCount: 0,
      memoryUpdated: 0,
    },
    currentRunEpoch(),
  );
}

function runIsOpen(): boolean {
  return getAgent().view !== null;
}

afterEach(() => {
  clearAgentForLock();
});

describe("a settings-only run", () => {
  it("is a proposal the review surface can open", () => {
    settle({ edits: [], newNotes: [], settings: [setting()], summary: "" });
    expect(runIsOpen()).toBe(true);
    expect(getAgent().proposal.settings).toHaveLength(1);
  });

  it("does NOT close itself before anything was applied", () => {
    // The `applied === null` arm, reached through a proposal with no edits. A
    // rule that dropped the run here would close the dialog the user has not
    // read yet.
    settle({ edits: [], newNotes: [], settings: [setting()], summary: "" });
    expect(runIsOpen()).toBe(true);
  });

  it("closes once the change landed, because then there is nothing left", () => {
    settle({ edits: [], newNotes: [], settings: [setting()], summary: "" });
    const ok = settleApply(
      applyOutcome({
        applied: 0,
        notesWritten: [],
        restorePoints: [],
        settingsChanged: [{ intentId: "editor.weekly-notes-folder", previous: "Old/" }],
      }),
      [],
      currentRunEpoch(),
      [0],
    );
    expect(ok).toBe(true);
    expect(runIsOpen()).toBe(false);
  });

  it("stays open while a change is still outstanding", () => {
    settle({
      edits: [],
      newNotes: [],
      settings: [setting(), setting("files.new-note-location", "specific")],
      summary: "",
    });
    // Only the first is applied, so the second is unresolved. The subtraction
    // has to notice, or a run with work left closes over it.
    settleApply(
      applyOutcome({
        applied: 0,
        notesWritten: [],
        restorePoints: [],
        settingsChanged: [{ intentId: "editor.weekly-notes-folder", previous: null }],
      }),
      [],
      currentRunEpoch(),
      [0],
    );
    expect(runIsOpen()).toBe(true);
    expect(keptSettings(getAgent())).toHaveLength(1);
  });

  it("counts a rejected change as resolved", () => {
    settle({ edits: [], newNotes: [], settings: [setting()], summary: "" });
    toggleSetting(0);
    expect(keptSettings(getAgent())).toHaveLength(0);
    settleApply(
      applyOutcome({
        applied: 0,
        notesWritten: [],
        restorePoints: [],
      }),
      [],
      currentRunEpoch(),
    );
    expect(runIsOpen()).toBe(false);
  });

  it("stays open when a change was refused", () => {
    // A refusal is exactly what the screen exists to show, so it holds the
    // dialog for the same reason a refused edit does.
    settle({ edits: [], newNotes: [], settings: [setting()], summary: "" });
    toggleSetting(0);
    settleApply(
      applyOutcome({
        applied: 0,
        notesWritten: [],
        restorePoints: [],
        refusedSettings: [
          {
            intentId: "editor.weekly-notes-folder",
            index: 0,
            reason: "needsOwnAct",
          },
        ],
      }),
      [],
      currentRunEpoch(),
    );
    expect(runIsOpen()).toBe(true);
  });
});

describe("the prefs nonce", () => {
  // **The mechanism the Settings panel and the open editor actually watch.**
  // Every other `vault.prefs` writer goes through the TS `writePref`, which
  // bumps the nonce; the agent's setting write goes through the Rust setter, so
  // without this bump nothing on this side learns a preference moved and
  // Settings keeps rendering the old value.
  it("bumps when a setting landed, and not for a note-only apply", () => {
    settle({ edits: [], newNotes: [], settings: [setting()], summary: "" });
    const before = getPrefsNonce();
    settleApply(applyOutcome(), [], currentRunEpoch());
    expect(
      getPrefsNonce(),
      "a note-only apply does not move a preference",
    ).toBe(before);

    settleApply(
      applyOutcome({
        applied: 0,
        notesWritten: [],
        restorePoints: [],
        settingsChanged: [{ intentId: "editor.weekly-notes-folder", previous: null }],
      }),
      [],
      currentRunEpoch(),
      [0],
    );
    expect(getPrefsNonce()).toBe(before + 1);
  });
});

describe("currentSettingValue", () => {
  /// **The reader table must cover the whole roster** (myne-md/myne#850 task 4).
  /// `currentSettingValue` is a second mapping, ids to pref fields, and the
  /// failure it can have is the quiet one this file's head describes: a setting
  /// with no reader renders as "not set" whatever it holds, which reads like a
  /// fact. So every roster id is given a populated view and must answer non-null.
  it("reads a value for every intent on the roster", async () => {
    const roster = (await import("../../scripts/agent-setting-intents.json"))
      .default as { intents: string[] };
    const populated: PrefsView = {
      ...DEFAULT_PREFS,
      daily_folder: "Daily/",
      daily_template: "tmpl-daily",
      daily_date_format: "YYYY-MM-DD",
      periodic_notes: {
        "weekly.folder": "W/",
        "weekly.template": "tmpl-w",
        "weekly.format": "fmt-w",
        "monthly.folder": "M/",
        "monthly.template": "tmpl-m",
        "monthly.format": "fmt-m",
      },
      new_note_location: "specific",
      date_format: "YYYY-MM-DD",
      time_format: "HH:mm",
    };
    for (const id of roster.intents) {
      expect(
        currentSettingValue(id, populated),
        `${id} has no reader, so its row would read as unset`,
      ).not.toBeNull();
    }
  });

  it("answers null for a setting it does not read rather than guessing", () => {
    expect(currentSettingValue("appearance.theme", DEFAULT_PREFS)).toBeNull();
  });
});

describe("settingChangeLine", () => {
  /** Records which i18n key was chosen and with what, so the assertion is about
   *  the DECISION rather than about a copy string that will be reworded. */
  function recorder(): {
    calls: Array<[string, Record<string, string>]>;
    t: (key: string, options: Record<string, string>) => string;
  } {
    const calls: Array<[string, Record<string, string>]> = [];
    return {
      calls,
      t: (key, options) => {
        calls.push([key, options]);
        return key;
      },
    };
  }

  it("reads a change as from-to", () => {
    const { calls, t } = recorder();
    settingChangeLine(setting(), "Journals/Weekly", t);
    expect(calls).toEqual([
      ["agent.review.settingFromValue", { from: "Journals/Weekly", to: "J/Weekly" }],
    ]);
  });

  it("reads a set from unset as such", () => {
    const { calls, t } = recorder();
    settingChangeLine(setting(), null, t);
    expect(calls).toEqual([
      ["agent.review.settingFromUnset", { value: "J/Weekly" }],
    ]);
  });

  it("reads a CLEAR as a removal, never as an empty value", () => {
    const { calls, t } = recorder();
    settingChangeLine({ intentId: "editor.weekly-notes-folder", value: null }, "Old/", t);
    expect(calls).toEqual([
      ["agent.review.settingCleared", { from: "Old/" }],
    ]);
    // And the key is not the set one with an empty string beside it, which is
    // what a nullable value folded into a string would produce.
    expect(calls[0][0]).not.toBe("agent.review.settingFromValue");
  });

  it("says so when a clear has nothing to clear", () => {
    const { calls, t } = recorder();
    settingChangeLine({ intentId: "editor.weekly-notes-folder", value: null }, null, t);
    expect(calls).toEqual([["agent.review.settingAlreadyUnset", {}]]);
  });
});

describe("toggleSetting", () => {
  it("toggles one row without touching the note rows", () => {
    settle({
      edits: [],
      newNotes: [],
      settings: [setting()],
      summary: "",
    });
    toggleSetting(0);
    expect(getAgent().rejectedSettings.has(0)).toBe(true);
    expect(getAgent().rejected.size).toBe(0);
    toggleSetting(0);
    expect(getAgent().rejectedSettings.has(0)).toBe(false);
  });
});
