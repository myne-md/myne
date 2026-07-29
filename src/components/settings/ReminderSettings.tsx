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

import { useCallback, useMemo, useState, type CSSProperties, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Switch } from "../primitives/Switch";
import {
  REMINDER_LINUX_LIMITATION_SENTENCE,
  REMINDER_OS_DISCLOSURE_SENTENCE,
  REMINDER_SHOW_TEXT_SENTENCE,
} from "../../lib/load-bearing-copy";
import { setReminderHorizonDays, setRemindersEnabled } from "../../lib/prefs";
import { showsInAppOnlyLimitation } from "../../lib/reminderPlatform";
import { REMINDER_HORIZON_DAYS } from "../../lib/reminderSchedule";
import { shiftDay, todayLocal } from "../../notes/taskFilters";

const BLOCK_STYLE: CSSProperties = { marginBottom: 20 };
const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
};
const LABEL_STYLE: CSSProperties = { fontSize: 14, color: "var(--fg-1)" };
const HELPER_STYLE: CSSProperties = {
  margin: "6px 0 0",
  fontSize: 12,
  lineHeight: 1.5,
  color: "var(--fg-3)",
};
const ERROR_STYLE: CSSProperties = { margin: "6px 0 0", fontSize: 12, color: "var(--danger)" };

export type ReminderSettingsProps = {
  enabled: boolean;
  /** Opt-in for putting real task text in the notification body. Default off. */
  showText: boolean;
  horizonDays: number | null;
  onEnabledChange: (next: boolean) => void;
  onShowTextChange: (next: boolean) => void;
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
  showText,
  horizonDays,
  onEnabledChange,
  onShowTextChange,
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
    <div data-testid="settings.reminders">
      <div style={BLOCK_STYLE}>
        <div style={ROW_STYLE}>
          <span style={LABEL_STYLE}>{t("settings.reminders.label")}</span>
          <Switch
            checked={enabled}
            onChange={(next) => void toggleEnabled(next)}
            ariaLabel={t("settings.reminders.aria")}
            ariaDescribedBy="reminders-disclosure"
            testId="settings.reminders-toggle"
          />
        </div>
        {/* Load-bearing: rendered verbatim, never translated. */}
        <p id="reminders-disclosure" style={HELPER_STYLE} data-testid="settings.reminders.disclosure">
          {REMINDER_OS_DISCLOSURE_SENTENCE}
        </p>
        {inAppOnly && (
          <p style={HELPER_STYLE} data-testid="settings.reminders.platform-limitation">
            {REMINDER_LINUX_LIMITATION_SENTENCE}
          </p>
        )}
        {error !== null && (
          <p role="alert" style={ERROR_STYLE}>
            {error}
          </p>
        )}
      </div>

      {enabled && (
        <>
          <div style={BLOCK_STYLE}>
            <div style={ROW_STYLE}>
              <span style={LABEL_STYLE}>{t("settings.reminders.showTextLabel")}</span>
              <Switch
                checked={showText}
                onChange={onShowTextChange}
                ariaLabel={t("settings.reminders.showTextAria")}
                ariaDescribedBy="reminders-text-disclosure"
                testId="settings.reminders-text-toggle"
              />
            </div>
            {/* Also load-bearing: turning this on changes what leaves the vault,
                so the user reads it at the moment they decide. */}
            <p
              id="reminders-text-disclosure"
              style={HELPER_STYLE}
              data-testid="settings.reminders.text-disclosure"
            >
              {REMINDER_SHOW_TEXT_SENTENCE}
            </p>
          </div>

          {/* The horizon line (task 13). Factual: reminders stop if the app is
              not opened within the horizon, because registration can only
              happen inside an unlocked session. */}
          <p style={HELPER_STYLE} data-testid="settings.reminders.horizon">
            {t("settings.reminders.horizon", { date: through })}
          </p>
        </>
      )}
    </div>
  );
}

/** Exposed so a caller can persist a horizon change through the one setter. */
export async function persistHorizon(days: number | null): Promise<void> {
  await setReminderHorizonDays(days);
}
