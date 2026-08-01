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

import { useTranslation } from "react-i18next";
import { usePrefs } from "../../hooks/usePrefs";
import { has } from "../../platform/capabilities";
import { SearchableSelect } from "../primitives/SearchableSelect";
import type { SelectOption } from "../primitives/Select";
import { Switch } from "../primitives/Switch";
import { CliAccessSettings } from "./CliAccessSettings";
import { QuickUnlockSettings } from "./QuickUnlockSettings";
import { SettingRow } from "./SettingRow";
import { PANEL_ROOT_STYLE } from "./panel-styles";

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
    <SettingRow
      label={t("settings.privacy.autoLockLabel")}
      helper={t("settings.privacy.autoLockHelper")}
      control={
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
      }
    />
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

export function PrivacyPanel({ onShowToast }: PrivacyPanelProps = {}) {
  const { t } = useTranslation();
  const {
    prefs,
    toggleScreenCapture,
    setAutoLock,
    setCliEnabled,
    setCliExcludedFolders,
    setCliRateLimitDisabled,
  } = usePrefs(onShowToast);
  return (
    <div style={PANEL_ROOT_STYLE}>
      <SettingRow
        label={t("settings.privacy.screenCaptureLabel")}
        helper={screenCaptureHelperText(prefs.screen_capture_protection, t)}
        anchorId="privacy.screen-capture"
        control={(helperId) => (
          <Switch
            checked={prefs.screen_capture_protection}
            onChange={(next) => {
              void toggleScreenCapture(next);
            }}
            ariaLabel={t("settings.privacy.screenCaptureLabel")}
            ariaDescribedBy={helperId}
          />
        )}
      />
      <AutoLockRow
        seconds={selectedAutoLockSecs(prefs.auto_lock_seconds)}
        onChange={(secs) => {
          void setAutoLock(secs);
        }}
      />
      <QuickUnlockSettings />
      {/* CLI terminal access (cli-thin-client task 12, MYND-490). Omitted where
          `cliAccess` is absent rather than greyed out: a browser tab cannot host
          a terminal's Unix socket, and the sidecar it would talk to is a file
          inside a desktop bundle (`decisions.md` 2026-07-26 "Web capability
          set" makes omission normative).

          Behind Developer mode as well (#181): the block opens the unlocked
          vault to an EXTERNAL terminal process over the local command socket —
          a separate trust boundary, and Myne does not vouch for what walks
          through it. That is the Developer group's whole membership test, so
          this belongs behind the same deliberate door as AI and Tor even
          though it keeps its home in Privacy. The gate HIDES, it does not
          disable: turning Developer mode back off leaves an enabled socket
          serving, exactly as it leaves `ai_enabled` set — the off switch for
          the feature is its own control. */}
      {prefs.developer_mode && has("cliAccess") && (
        <CliAccessSettings
          enabled={prefs.cli_enabled}
          excludedFolders={prefs.cli_excluded_folders}
          rateLimitDisabled={prefs.cli_rate_limit_disabled}
          onSetEnabled={(next) => {
            void setCliEnabled(next);
          }}
          onSetExcludedFolders={(folders) => {
            void setCliExcludedFolders(folders);
          }}
          onSetRateLimitDisabled={(next) => {
            void setCliRateLimitDisabled(next);
          }}
        />
      )}
    </div>
  );
}
