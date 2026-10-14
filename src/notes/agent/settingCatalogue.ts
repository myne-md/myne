// The settings the in-app agent may change, as offered to one run
// (myne-md/myne#850).
//
// **Derived from the settings search index, not listed a second time.** Task 1
// put the verdict on every index entry, and the index is already the client's
// declarative answer about what a setting is; a hand-kept list of intent ids here
// would be the second copy that drifts from it, which is the shape this feature's
// plan spends the most words refusing.
//
// The ids cross IPC and the host answers with its own. **Nothing here decides
// whether the write happens**: `myne-core` re-derives what may be written from
// its intent table at the proposal AND at the write, so a catalogue claiming more
// than the table allows is an offer of less rather than a capability.

import {
  SETTINGS_SEARCH_INDEX,
  type AgentWritability,
} from "../../components/settings/search/settingsSearchIndex";
import { has } from "../../platform/capabilities";
import { detachedNoteId } from "../../lib/detachedWindow";
import type { PrefsView } from "../../lib/prefs";
import type { ProposedSetting } from "../../lib/agent-protocol";

/** Whether a verdict says the agent may change the setting. */
export function isAgentWritable(verdict: AgentWritability): boolean {
  return verdict.verdict === "writable";
}

/** The narrowest shape of `t` this module needs: a key and string options. */
type Interpolate = (key: string, options: Record<string, string>) => string;

/**
 * The review line for one setting change (myne-md/myne#850).
 *
 * **Four cases, and the clear one is why this is a function.** A set and a clear
 * are different acts and read differently: `Journals/Weekly becomes
 * Reviews/Weekly` against `Journals/Weekly is removed`. A cleared setting that
 * said "becomes an empty value" would describe storage the write never produces,
 * because the prefs setter REMOVES the entry rather than storing an empty one.
 *
 * Pure, and here rather than inside the component, so it is testable without
 * mounting the apply path the review screen owns.
 */
export function settingChangeLine(
  setting: ProposedSetting,
  current: string | null,
  t: Interpolate,
): string {
  if (setting.value === null) {
    return current === null
      ? t("agent.review.settingAlreadyUnset", {})
      : t("agent.review.settingCleared", { from: current });
  }
  return current === null
    ? t("agent.review.settingFromUnset", { value: setting.value })
    : t("agent.review.settingFromValue", {
        from: current,
        to: setting.value,
      });
}

/**
 * The value a setting holds now, for the review line (myne-md/myne#850).
 *
 * **Display data only, and it never reaches the model.** The review row is the
 * only caller: what it renders is the user's own state going back to the user,
 * and a setting's value in the request would be a fact about the vault leaving
 * the device for no reason. Task 6 of this feature exists to pin that with a
 * test over the built request.
 *
 * `null` when the setting is unset, which is what lets the row say "not set"
 * rather than show an empty string.
 *
 * **It must grow with the families. Every intent in the roster is resolved here,
 * and the obligation is held by a test rather than by this comment**
 * (`agentSettingsReview.test.ts` drives each id against a prefs view). This line
 * claimed the tracer bullet's two intents until the 2026-10-13 review counted the
 * switch, which resolves twelve, and it is the warning a later author is meant to
 * trust: every intent in the roster is resolved here, so another intent reaching
 * the review screen without a case would render as "not set" whatever it holds,
 * which reads like a fact.
 * `editor.daily-notes-folder` is deliberately absent: daily notes keep flat
 * top-level fields rather than a `periodic_notes` entry (`core/src/plugins/prefs/commands.rs`),
 * so its reader is written with the family that owns it rather than guessed here.
 */
export function currentSettingValue(
  intentId: string,
  prefs: PrefsView,
): string | null {
  // The periodic family is one shape across three settings: `folder`,
  // `template` and the date `format`, which is what `periodic_notes` stores the
  // third one under (the settings id says `date-format`, the pref key says
  // `format`).
  const periodic = /^editor\.(weekly|monthly)-notes-(folder|template|date-format)$/.exec(
    intentId,
  );
  if (periodic !== null) {
    const field =
      periodic[2] === "folder"
        ? "folder"
        : periodic[2] === "template"
          ? "template"
          : "format";
    return prefs.periodic_notes[`${periodic[1]}.${field}`] ?? null;
  }
  switch (intentId) {
    case "editor.daily-notes-folder":
      return prefs.daily_folder ?? null;
    case "editor.daily-notes-template":
      return prefs.daily_template ?? null;
    case "editor.daily-notes-date-format":
      return prefs.daily_date_format ?? null;
    case "files.new-note-location":
      return prefs.new_note_location ?? null;
    case "editor.date-format":
      return prefs.date_format ?? null;
    case "editor.time-format":
      return prefs.time_format ?? null;
    default:
      return null;
  }
}

/**
 * Whether a setting change can be performed from THIS window (myne-md/myne#850
 * task 5).
 *
 * **Two mechanisms, because the two cases are genuinely different**, and the
 * second is the one a capability cannot express:
 *
 *  1. **The build.** `has("prefsWrite")` answers for a client with no preference
 *     write at all. Every shipping client has it, so this arm is the mechanism's
 *     existence rather than a live branch; it is here so a future one is an edit
 *     rather than an omission.
 *  2. **The window.** A detached note window runs the SAME build as the main
 *     window and holds the same capabilities, so no capability can tell them
 *     apart. `detachedNoteId()` is where the app already tracks the window role,
 *     and it is therefore the answer here.
 *
 *     **This arm is a consistency bound, not an enforcement, and it said the
 *     opposite until the 2026-10-13 review read the path.** It claimed the
 *     window "lacks `prefs:allow-set-*`", which is true of the ACL but not of
 *     this write: the agent's setting write is an in-process call into the prefs
 *     plugin from the agent plugin's own command, not a `plugin:prefs|set-*`
 *     invocation, so no per-window grant is consulted, and
 *     `detached-note.json` does grant `agent:default` to `note-*` windows. A page
 *     in a detached window can therefore start a run and call the apply; what it
 *     cannot do is get a setting OFFERED, which is what this check supplies. The
 *     page already holds the plaintext that window was opened to show, so the
 *     practical difference is small, but the bound is written as what it is.
 *     Moving the check host-side, into the agent's apply and undo commands, is
 *     the change that would make it an enforcement; `docs/threat-model.md` §7
 *     records it as owed.
 *
 * **The failure this prevents is a change offered and then refused after
 * approval.** A setting the user approved and watched fail is worse than one
 * never offered: the promise was made by us, at the moment they were deciding.
 *
 * Its two inputs are parameters so both arms are exercisable without a detached
 * window or a build that lacks the capability; `offeredSettingIds` is the one
 * production caller and passes the real ones.
 */
export function settingsOffered(
  prefsWrite: boolean,
  inDetachedWindow: boolean,
): boolean {
  return prefsWrite && !inDetachedWindow;
}

/**
 * The settings-index ids offered to a run.
 *
 * **Empty where the write cannot happen**, which is what the agent's plan means
 * by "never offered and then refused after approval": `myne-core` refuses a
 * `set_setting` that is not in this list, so an empty catalogue is a run that
 * cannot propose a setting at all.
 *
 * Ordered by the index, which is ordered by rail, so the system block the host
 * renders reads in the same order the Settings rail does.
 */
export function offeredSettingIds(): string[] {
  if (!settingsOffered(has("prefsWrite"), detachedNoteId() !== null)) {
    return [];
  }
  return SETTINGS_SEARCH_INDEX.filter((entry) =>
    isAgentWritable(entry.agentWritability),
  ).map((entry) => entry.id);
}
