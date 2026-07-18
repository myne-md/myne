// Settings → Privacy panel: interactive "Screen-capture protection"
// toggle (MYND-160 ships persistence) + interactive "Auto-lock" timeout
// selector (MYND-121 + MYND-122). The auto-lock control is a native
// <select> — keyboard-navigable + screen-reader-friendly by construction —
// offering ENABLED durations only (NO "Off"): auto-lock is an always-on A6
// guarantee. Supersedes MYND-55's disabled "Auto-lock on idle" placeholder.
//
// Penpot canon: `screen------settings--privacy` (frame id
// `9fb59646-2811-8082-8007-fd1cbf80a20b`). MYND-121 turned the disabled
// auto-lock toggle placeholder into the interactive select drawn there.
//
// i18n: copy is inline EN, consistent with the rest of the app (no i18n
// framework exists yet). TR strings ("Otomatik kilit" / "Bu kadar
// hareketsizlik sonrası kasayı kilitle.") await an app-wide i18n layer.

import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { usePrefs } from "../../hooks/usePrefs";
import { useLastActiveNotePref } from "../../hooks/useLastActiveNotePref";
import { SearchableSelect } from "../primitives/SearchableSelect";
import type { SelectOption } from "../primitives/Select";
import { Switch } from "../primitives/Switch";
import { QuickUnlockSettings } from "./QuickUnlockSettings";
import {
  BLOCK_STYLE,
  HELPER_STYLE,
  LABEL_STYLE,
  PANEL_ROOT_STYLE,
} from "./panel-styles";

const TOGGLE_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3)",
};

// MYND-160 grill Q2.1 disclosure: when the user toggles off, the
// helper text MUST disclose the off-after-unlock semantic so a
// "I turned it off, why is the unlock screen still black?" support
// question is foreseeable + answered at the UI surface. When the
// toggle is on (the default), the helper carries the platform-
// support disclosure inherited from MYND-55/78's disabled placeholder
// copy — modified to drop the "Per-vault toggle ... coming in a
// future release" sentence since the toggle is now interactive.
function screenCaptureHelperText(
  enabled: boolean,
  t: (key: string) => string,
): string {
  if (enabled) {
    return t("settings.privacy.screenCaptureHelperOn");
  }
  return t("settings.privacy.screenCaptureHelperOff");
}

interface ToggleRowProps {
  label: string;
  ariaLabel: string;
  helper: string;
  ariaDescribedBy: string;
  checked: boolean;
  /**
   * When omitted, the toggle is rendered as a disabled placeholder
   * (no `onClick`, `aria-disabled=true`, dimmed visuals). When
   * supplied, the toggle is interactive — `aria-disabled` is omitted,
   * cursor is `pointer`, click fires the callback.
   */
  onToggle?: (next: boolean) => void;
  /** Optional `data-testid` forwarded to the Switch for E2E targeting. */
  testId?: string;
  /** Optional settings-search anchor (MYND-536) on the block root, so a search
   *  result can scroll this row into view and flash it. */
  anchorId?: string;
}

function ToggleRow({
  label,
  ariaLabel,
  helper,
  ariaDescribedBy,
  checked,
  onToggle,
  testId,
  anchorId,
}: ToggleRowProps) {
  return (
    <div style={BLOCK_STYLE} data-setting-anchor={anchorId}>
      <div style={TOGGLE_ROW_STYLE}>
        <span style={LABEL_STYLE}>{label}</span>
        <Switch
          checked={checked}
          onChange={onToggle}
          ariaLabel={ariaLabel}
          ariaDescribedBy={ariaDescribedBy}
          testId={testId}
        />
      </div>
      <p id={ariaDescribedBy} style={HELPER_STYLE}>
        {helper}
      </p>
    </div>
  );
}

// MYND-121 auto-lock-on-idle timeout selector. Options sit within the backend
// protective-envelope bounds (FLOOR 30s / DEFAULT 5min / CEILING 60min) and
// offer NO "Off" — auto-lock is an always-on A6 guarantee. The default shown
// when no value is stored mirrors the Rust `auto_lock::DEFAULT_AUTO_LOCK_SECS`
// (keep in sync if that constant changes; the backend is authoritative for the
// actual timer — this is only the selector's display-when-unset).
const AUTO_LOCK_DEFAULT_SECS = 300;

const AUTO_LOCK_OPTIONS: ReadonlyArray<{ secs: number; label: string }> = [
  { secs: 60, label: "1 min" },
  { secs: 300, label: "5 min" },
  { secs: 900, label: "15 min" },
  { secs: 1800, label: "30 min" },
  { secs: 3600, label: "1 hour" },
];

// The same offered durations as SearchableSelect options (value = the seconds
// as a string; the row maps back to a number on change).
const AUTO_LOCK_SELECT_OPTIONS: readonly SelectOption<string>[] =
  AUTO_LOCK_OPTIONS.map((o) => ({ value: String(o.secs), label: o.label }));

/**
 * Resolve the value the selector displays: the stored timeout when it matches
 * an offered option, otherwise the default. Covers both the unset case (`null`
 * → default) and the defensive case where a replayed / out-of-range stored
 * value has no matching `<option>` (fall back to default so the native select
 * always shows a valid selection; the backend clamps the actual timer anyway).
 */
function selectedAutoLockSecs(stored: number | null): number {
  if (stored !== null && AUTO_LOCK_OPTIONS.some((o) => o.secs === stored)) {
    return stored;
  }
  return AUTO_LOCK_DEFAULT_SECS;
}

interface AutoLockRowProps {
  seconds: number;
  onChange: (secs: number) => void;
}

function AutoLockRow({ seconds, onChange }: AutoLockRowProps) {
  const { t } = useTranslation();
  return (
    <div style={BLOCK_STYLE}>
      <div style={TOGGLE_ROW_STYLE}>
        <span style={LABEL_STYLE} id="auto-lock-label">
          {t("settings.privacy.autoLockLabel")}
        </span>
        <SearchableSelect
          options={AUTO_LOCK_SELECT_OPTIONS}
          selected={[String(seconds)]}
          onChange={(next) => {
            const secs = Number(next[0]);
            if (!Number.isNaN(secs)) onChange(secs);
          }}
          aria-label={t("settings.privacy.autoLockLabel")}
          testId="settings.auto-lock-select"
          searchPlaceholder={t("settings.privacy.autoLockSearchPlaceholder")}
          emptyText={t("settings.privacy.autoLockSearchEmpty")}
        />
      </div>
      <p id="auto-lock-helper" style={HELPER_STYLE}>
        {t("settings.privacy.autoLockHelper")}
      </p>
    </div>
  );
}

interface PrivacyPanelProps {
  /**
   * Toast surface — invoked when an optimistic write rolled back
   * (PrefsWriteError on the Rust side). Threaded from
   * `SettingsModal.onShowToast` per the existing AccountPanel
   * pattern. When undefined, errors are silent (acceptable for
   * dev / non-Tauri contexts where the modal mounts without a
   * toast surface wired).
   */
  onShowToast?: (message: string) => void;
}

// Real-time sync is baseline behaviour, not a toggle (amended sync-protocol
// §8.3): the fixed-interval polling fallback already discloses presence at
// poll granularity while the vault is unlocked, so the continuous connection's
// marginal presence-signal delta stopped justifying a user-facing option. The
// panel keeps an INFO row (no switch) so the disclosure stays honest.
function RealtimeSyncInfoRow() {
  const { t } = useTranslation();
  return (
    <div style={BLOCK_STYLE} data-testid="settings.realtime-sync-info">
      <div style={TOGGLE_ROW_STYLE}>
        <span style={LABEL_STYLE}>{t("settings.privacy.realtimeSyncLabel")}</span>
      </div>
      <p id="realtime-sync-helper" style={HELPER_STYLE}>
        {t("settings.privacy.realtimeSyncHelper")}
      </p>
    </div>
  );
}

export function PrivacyPanel({ onShowToast }: PrivacyPanelProps = {}) {
  const { t } = useTranslation();
  const { prefs, toggleScreenCapture, setAutoLock } = usePrefs(onShowToast);
  const { enabled: lastActiveNote, setEnabled: setLastActiveNote } =
    useLastActiveNotePref();
  return (
    <div style={PANEL_ROOT_STYLE}>
      <ToggleRow
        label={t("settings.privacy.screenCaptureLabel")}
        ariaLabel={t("settings.privacy.screenCaptureLabel")}
        ariaDescribedBy="screen-capture-protection-helper"
        helper={screenCaptureHelperText(prefs.screen_capture_protection, t)}
        checked={prefs.screen_capture_protection}
        onToggle={(next) => {
          void toggleScreenCapture(next);
        }}
        anchorId="privacy.screen-capture"
      />
      <RealtimeSyncInfoRow />
      <ToggleRow
        label="Continue where you left off"
        ariaLabel="Continue where you left off"
        ariaDescribedBy="last-active-note-helper"
        helper="Sync which note you had open so you can pick it up on another device. Off by default — only the note is shared, never your scroll position or open tabs."
        checked={lastActiveNote}
        onToggle={setLastActiveNote}
        testId="settings.last-active-note-toggle"
      />
      <AutoLockRow
        seconds={selectedAutoLockSecs(prefs.auto_lock_seconds)}
        onChange={(secs) => {
          void setAutoLock(secs);
        }}
      />
      <QuickUnlockSettings />
    </div>
  );
}
