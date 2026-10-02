// Reminder settings (MYND-618, tasks 11 + 13; task 7's honesty line).
//
// **Two rows, both exported from here.** `ReminderSettings` is the per-device
// switch and the honesty sentence; `ReminderHorizonSettings` is the
// registration horizon, its picker and the line stating where that horizon
// currently reaches (myne#508). They are separate rows because the canon says a
// setting is a row (`docs/design/README.md`), and they share a file because the
// second only ever renders under the first's conditions.
//
// **No new settings panel** — the rail is governance-locked, so this block slots
// into an existing one, like every other feature-scoped control.
//
// The disclosure sentences are **load-bearing copy**: fixed constants rendered
// verbatim in every locale and pinned by full-literal assertion, not translated
// strings. Their exact wording is a privacy statement, which is what separates
// them from a label. Three things they deliberately do not do: claim Myne
// controls what a lock screen previews (the platform's preview settings are the
// user's, not ours), soften "leaves the vault", or alarm.
//
// The **horizon line** (task 13) states something that has to be said anyway —
// reminders stop if the app is not opened within the horizon, because
// registration can only happen inside an unlocked session — and turns it from a
// surprise into a stated property. Factual, not alarming. It moved into the
// horizon row in myne#508, next to the control that moves it.

import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Select } from "../primitives/Select";
import { Switch } from "../primitives/Switch";
import { SettingRow } from "./SettingRow";
import { HELPER_STYLE } from "./panel-styles";
import {
  REMINDER_IN_APP_ONLY_SENTENCE,
  REMINDER_OS_DISCLOSURE_SENTENCE,
} from "../../lib/load-bearing-copy";
import { setRemindersEnabled } from "../../lib/prefs";
import { showsInAppOnlyLimitation } from "../../lib/reminderPlatform";
import { REMINDER_HORIZON_CHOICES, resolveHorizonDays } from "../../lib/reminderSchedule";
import { shiftDay, todayLocal } from "../../notes/taskFilters";

export type ReminderSettingsProps = {
  enabled: boolean;
  onEnabledChange: (next: boolean) => void;
};

/**
 * The horizon line's date: today plus the horizon, as the user's local day.
 *
 * Stating the DATE rather than the day count is the point — "registered through
 * 4 August" is checkable against a calendar; "7 days" makes the reader do the
 * arithmetic and get it wrong.
 *
 * The `- 1` (the horizon is inclusive of today) moved next to the cutoff it
 * describes in #52, because the two clients derived it apart and drifted. This
 * keeps the `YYYY-MM-DD`-string signature its callers use; the shared helper is
 * `Date`-based because the mobile caller has a `Date` in hand.
 */
export function horizonThrough(horizonDays: number | null, today: string): string {
  return shiftDay(today, resolveHorizonDays(horizonDays) - 1);
}

export function ReminderSettings({
  enabled,
  onEnabledChange,
}: ReminderSettingsProps): ReactElement {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const inAppOnly = useMemo(() => showsInAppOnlyLimitation(), []);

  const toggleEnabled = useCallback(
    async (next: boolean) => {
      setError(null);
      try {
        await setRemindersEnabled(next);
        onEnabledChange(next);
      } catch {
        setError(t("settings.reminders.saveError"));
      }
    },
    [onEnabledChange, t],
  );

  return (
    <SettingRow
      testId="settings.reminders"
      label={t("settings.reminders.label")}
      // Load-bearing: rendered verbatim, never translated.
      //
      // Which sentence the user sees follows what this build can actually do.
      // While reminders are in-app only, NOTHING leaves the encrypted vault —
      // there is no OS registration to store times in — so the disclosure of
      // that cost would be describing a leak that does not exist. The
      // limitation is stated instead, and the disclosure returns on the change
      // that makes it true.
      helper={
        inAppOnly ? REMINDER_IN_APP_ONLY_SENTENCE : REMINDER_OS_DISCLOSURE_SENTENCE
      }
      helperTestId={
        inAppOnly
          ? "settings.reminders.in-app-only"
          : "settings.reminders.disclosure"
      }
      error={error}
      control={(helperId) => (
        <Switch
          checked={enabled}
          onChange={(next) => void toggleEnabled(next)}
          ariaLabel={t("settings.reminders.aria")}
          ariaDescribedBy={helperId}
          testId="settings.reminders-toggle"
        />
      )}
    />
  );
}

export type ReminderHorizonSettingsProps = {
  /** The switch above; the horizon has nothing to say while reminders are off. */
  enabled: boolean;
  /** The persisted registration horizon; `null` is "never set" (the default). */
  horizonDays: number | null;
  /** `usePrefs`'s optimistic setter, which is where this row's state lives. */
  onChange: (days: number) => void;
  /** Injected for tests; production reads the local calendar day. */
  today?: string;
};

/**
 * The registration horizon, and the line stating where the current one reaches.
 *
 * **Holds no state.** The optimistic write, its converge-on-failure re-read and
 * its error toast all belong to `usePrefs` (`setReminderHorizon`), the same as
 * the ~40 settings around it. An earlier draft of myne#508 rolled its own and
 * made `EditorPanel` carry an echo for it, which is a shape that has to be
 * repeated once per settable pref, and whose toast was never wired.
 *
 * **Not gated on the reminder tier, and that is the deliberate half.** The
 * horizon LINE below is, because "registered through <date>" describes an OS
 * registration and no build has one; the CONTROL is not, because
 * `useReminderScheduler` threads this value into `runReminderPass` on every
 * build, so shortening it really does shrink the set of instants the running
 * app arms.
 *
 * The second half of that argument used to read that gating it would also have
 * made `check-ipc-binding-callers.mjs` go green on a branch nothing renders. The
 * invisibility it names is real and is what let myne#508 ship, with the setter
 * carrying a Rust core, an ACL row and its tests and no caller on either client.
 * But the guard could not have caught it either way, and the reason is unrelated
 * to gating: it strips whole import statements and then bare-word matches the
 * name, so an aliased import is invisible to it, and `usePrefs.ts` imported this
 * setter under an alias until myne-md/myne#508's review found it. The import is
 * unaliased now. Stated rather than quietly dropped, because a comment claiming
 * a guard holds a property it does not is the same defect one altitude up.
 *
 * Deliberately absent from `settingsSearchIndex.ts`, which is a departure from
 * `src/AGENTS.md` and is recorded as one in `docs/decisions/clients/0541`
 * rather than argued only here: its row exists only while reminders are on, so
 * a search hit would scroll to something not rendered for anyone with the
 * feature off. `settings.search.keywords.reminders` carries the horizon's words
 * instead and lands the user on the switch that reveals the row.
 */
export function ReminderHorizonSettings({
  enabled,
  horizonDays,
  onChange,
  today = todayLocal(),
}: ReminderHorizonSettingsProps): ReactElement | null {
  const { t, i18n } = useTranslation();
  if (!enabled) return null;

  // `Intl` rather than five catalog keys saying "7d": it is one line, it is
  // right in every locale including the ones with three plural forms, and the
  // mobile twin calling the same standard API cannot drift from it.
  const days = new Intl.NumberFormat(i18n.resolvedLanguage ?? i18n.language, {
    style: "unit",
    unit: "day",
    unitDisplay: "long",
  });

  const inAppOnly = showsInAppOnlyLimitation();

  return (
    <SettingRow
      testId="settings.reminders-horizon-row"
      label={t("settings.reminders.horizonLabel")}
      // Which sentence the user reads follows what this build can do, the same
      // way the switch's does. On the in-app tier the horizon bounds which
      // instants the running app arms, so that is what the helper says; the
      // "registered through <date>" line below belongs to a tier that holds an
      // OS registration, and appears with it.
      helper={inAppOnly ? t("settings.reminders.horizonLabelHelper") : undefined}
      helperTestId="settings.reminders-horizon-helper"
      control={(helperId) => (
        <Select
          value={String(resolveHorizonDays(horizonDays))}
          options={REMINDER_HORIZON_CHOICES.map((d) => ({
            value: String(d),
            label: days.format(d),
          }))}
          onChange={(v) => onChange(Number(v))}
          aria-label={t("settings.reminders.horizonLabel")}
          ariaDescribedBy={inAppOnly ? helperId : undefined}
          testId="settings.reminders-horizon-picker"
        />
      )}
    >
      {!inAppOnly && (
        <p style={HELPER_STYLE} data-testid="settings.reminders.horizon">
          {t("settings.reminders.horizon", { date: horizonThrough(horizonDays, today) })}
        </p>
      )}
    </SettingRow>
  );
}
