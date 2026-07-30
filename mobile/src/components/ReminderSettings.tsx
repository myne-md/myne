// Reminder settings, mobile (MYND-619 tasks 6 and 8).
//
// A **block inside an existing panel**, not a new rail entry — the settings rail
// is governance-locked and every feature-scoped control slots into a panel that
// already exists. This one lives under Privacy, beside auto-lock and
// screen-capture, because what it has to say is a privacy statement before it is
// a preference.
//
// Built directly against design tokens (no Penpot — owner directive, the same
// route `SyncSettingsPanels` took).
//
// ── The precise-delivery block (task 6) ────────────────────────────────────
//
// The permission is asked for **on demand and only on demand**. Android reserves
// the install-time entitlement (`USE_EXACT_ALARM`) for alarm-clock and
// calendar-class apps, `vision.md` says Myne has no calendar, and the decision
// log records no store-distribution decisions to stand on — so claiming it would
// be both inconsistent and a review gamble. Declaring nothing at all is honest
// but weak: a reminder that arrives late once is not trusted again. Asking when
// the user wants precision gives both.
//
// There is no "we already asked" bookkeeping in here, and that is not an
// oversight: `request()` opens a **settings screen**, not a one-shot dialog.
// Nothing is consumed by opening it, so there is nothing to spend and nothing to
// re-prompt. The app never opens it on its own — only this button does.
//
// The fallback is **stated**, in a load-bearing constant rendered verbatim,
// rather than left for a late reminder to teach.

import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { REMINDER_HORIZON_DAYS } from "@myne/reminder-schedule";
import { REMINDER_APPROXIMATE_DELIVERY_SENTENCE } from "../lib/load-bearing-copy";
import { createExactAlarmApi, type ExactAlarmApi, type ReminderExactness } from "../lib/reminders";
import { Switch } from "./inputs";

const rowLabel: CSSProperties = { fontSize: 16, color: "var(--fg-1)" };
const rowValue: CSSProperties = { fontSize: 15, color: "var(--fg-3)" };
const helper: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.5,
  color: "var(--fg-3)",
  margin: "6px 4px 0",
};

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        marginTop: 18,
        padding: "0 4px 8px",
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--line-3)",
      }}
    >
      {children}
    </div>
  );
}

function Group({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        border: "1px solid var(--line-1)",
        borderRadius: 10,
        overflow: "hidden",
        background: "var(--bg-1)",
      }}
    >
      {children}
    </div>
  );
}

/**
 * The horizon line's date: today plus the horizon, as the user's **local** day.
 *
 * A date, not a day count. "through 3 August" is checkable against a calendar;
 * "7 days" makes the reader do the arithmetic and get it wrong.
 */
export function horizonDate(horizonDays: number | null, today: Date): string {
  const days = horizonDays ?? REMINDER_HORIZON_DAYS;
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);
  // Local calendar arithmetic on purpose: a UTC-based shift would name the wrong
  // day for anyone far enough east or west, which is a visible lie on a line
  // whose entire job is being checkable.
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${end.getFullYear()}-${p(end.getMonth() + 1)}-${p(end.getDate())}`;
}

export type ReminderSwitchBlockProps = {
  enabled: boolean;
  horizonDays: number | null;
  onEnabledChange: (next: boolean) => void;
  /** Injected in tests; production reads the local calendar day. */
  today?: Date;
};

/**
 * The per-device switch and the horizon line (task 8).
 *
 * **Device-local, and the copy says so** — whether a phone should be interrupted
 * is a property of that phone, not of the vault, so the setting does not sync.
 *
 * The **horizon line matters more here than on the desktop**: a phone app is
 * opened often but a vault may be unlocked rarely, and registration only happens
 * inside an unlocked session. "Reminders are registered through <date>" turns
 * "they run out if you do not open the app" from a surprise into a stated
 * property. It is hidden while reminders are off, because there is then no
 * horizon to state.
 */
export function ReminderSwitchBlock({
  enabled,
  horizonDays,
  onEnabledChange,
  today,
}: ReminderSwitchBlockProps): ReactNode {
  const { t } = useTranslation();
  const through = horizonDate(horizonDays, today ?? new Date());

  return (
    <>
      <SectionLabel>{t("settings.reminders.label")}</SectionLabel>
      <Group>
        <div
          data-testid="settings.reminders-row"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "11px 14px",
          }}
        >
          <span style={rowLabel}>{t("settings.reminders.label")}</span>
          <Switch on={enabled} onToggle={() => onEnabledChange(!enabled)} />
        </div>
      </Group>
      {enabled && (
        <p style={helper} data-testid="settings.reminders-horizon">
          {t("settings.reminders.horizon", { date: through })}
        </p>
      )}
    </>
  );
}

export type ExactAlarmBlockProps = {
  /** Injected in tests; production talks to the plugin. */
  api?: ExactAlarmApi;
  /** Injected in tests so the initial read can be awaited deterministically. */
  onResolved?: (status: ReminderExactness) => void;
};

/**
 * The Android precise-delivery affordance.
 *
 * **Renders nothing at all on a platform that has no such permission.** A row
 * saying "not applicable" would be a caveat about a limitation the user's phone
 * does not have.
 */
export function ExactAlarmBlock({ api, onResolved }: ExactAlarmBlockProps): ReactNode {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ReminderExactness | null>(null);

  const surface = api ?? createExactAlarmApi();

  const read = useCallback(async (): Promise<void> => {
    try {
      const next = await surface.status();
      setStatus(next);
      onResolved?.(next);
    } catch {
      // A surface that cannot answer is treated as approximate, never as exact:
      // showing the caveat when it was not needed is a smaller failure than a
      // reminder quietly arriving late after the app implied it would not.
      setStatus("approximate");
      onResolved?.("approximate");
    }
    // `surface`/`onResolved` are stable for a mounted block; re-reading on every
    // render would poll the platform on each keystroke elsewhere in the sheet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void read();
  }, [read]);

  const request = useCallback(async (): Promise<void> => {
    try {
      await surface.request();
    } catch {
      // The screen may not exist on a manufacturer build. Nothing to recover —
      // the state below is re-read when the user comes back either way.
    }
    // Re-read on return: the user may have granted it, and the row should not
    // still be offering something they already did.
    void read();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [read]);

  // Nothing is rendered until the platform has answered, so the block never
  // flashes a caveat it is about to retract.
  if (status === null || status === "not-applicable") return null;

  const exact = status === "exact";

  // No section label of its own: this sits directly under the switch block,
  // which owns the heading, so the two read as one "Task reminders" section
  // rather than two adjacent ones saying the same word.
  return (
    <>
      <Group>
        <div
          data-testid="settings.reminder-exact-row"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "11px 14px",
          }}
        >
          <span style={rowLabel}>{t("settings.reminders.exactLabel")}</span>
          {exact ? (
            <span style={rowValue} data-testid="settings.reminder-exact-value">
              {t("settings.reminders.exactOn")}
            </span>
          ) : (
            <button
              type="button"
              data-testid="settings.reminder-exact-allow"
              onClick={() => void request()}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                font: "inherit",
                fontSize: 15,
                color: "var(--accent-1)",
                cursor: "pointer",
              }}
            >
              {t("settings.reminders.exactAllow")}
            </button>
          )}
        </div>
      </Group>
      {!exact && (
        <p style={helper} data-testid="settings.reminder-exact-helper">
          {REMINDER_APPROXIMATE_DELIVERY_SENTENCE}
        </p>
      )}
    </>
  );
}
