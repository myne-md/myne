// Reminder settings (MYND-618, tasks 11 + 13; task 7's honesty line).
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
// surprise into a stated property. Factual, not alarming.

import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Switch } from "../primitives/Switch";
import { SettingRow } from "./SettingRow";
import { HELPER_STYLE } from "./panel-styles";
import {
  REMINDER_IN_APP_ONLY_SENTENCE,
  REMINDER_OS_DISCLOSURE_SENTENCE,
} from "../../lib/load-bearing-copy";
import { setReminderHorizonDays, setRemindersEnabled } from "../../lib/prefs";
import { showsInAppOnlyLimitation } from "../../lib/reminderPlatform";
import { REMINDER_HORIZON_DAYS } from "../../lib/reminderSchedule";
import { shiftDay, todayLocal } from "../../notes/taskFilters";

export type ReminderSettingsProps = {
  enabled: boolean;
  /**
   * The registration horizon, for the horizon line. Only rendered while the OS
   * tier is active — see the gate below.
   */
  horizonDays: number | null;
  onEnabledChange: (next: boolean) => void;
  /** Injected for tests; production reads the local calendar day. */
  today?: string;
};

/**
 * The horizon line's date: today plus the horizon, as the user's local day.
 *
 * Stating the DATE rather than the day count is the point — "registered through
 * 4 August" is checkable against a calendar; "7 days" makes the reader do the
 * arithmetic and get it wrong.
 */
export function horizonThrough(horizonDays: number | null, today: string): string {
  return shiftDay(today, (horizonDays ?? REMINDER_HORIZON_DAYS) - 1);
}

export function ReminderSettings({
  enabled,
  horizonDays,
  onEnabledChange,
  today = todayLocal(),
}: ReminderSettingsProps): ReactElement {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const inAppOnly = useMemo(() => showsInAppOnlyLimitation(), []);
  const through = horizonThrough(horizonDays, today);

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
    >
      {/* The horizon line (task 13) belongs to the OS tier and is gated with it.
          A registration horizon is only something the user can observe when the
          operating system holds the registration; while reminders fire from the
          running app, the app being open is the only condition that matters, and
          stating a "registered through <date>" bound would describe a mechanism
          that is not running. */}
      {enabled && !inAppOnly && (
        <p style={HELPER_STYLE} data-testid="settings.reminders.horizon">
          {t("settings.reminders.horizon", { date: through })}
        </p>
      )}
    </SettingRow>
  );
}

/** Exposed so a caller can persist a horizon change through the one setter. */
export async function persistHorizon(days: number | null): Promise<void> {
  await setReminderHorizonDays(days);
}
