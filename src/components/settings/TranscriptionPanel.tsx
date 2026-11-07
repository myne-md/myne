// Settings → Transcription: the speech-to-text switch (MYND-592).
//
// Why this is its own panel rather than a row under Files or Editor, and why it
// is not in Labs: speech-to-text ships a bundled model, runs entirely
// on-device, and does one bounded thing the user asks for one file at a time.
// That makes it a product feature, not a lab experiment — and it used to be
// gated on `ai_enabled`, so turning the AI beta off silently killed it.
//
// The default is ON. The switch is an opt-OUT: it is persisted only when
// `false`, so a vault that never touches it stays byte-identical to a
// pre-feature `vault.prefs`.
//
// This surface is discovery, not enforcement — `transcribe` re-reads the
// persisted value host-side before it decrypts anything, so a WebView that
// forges or skips the setter gains nothing.

import { useTranslation } from "react-i18next";
import { SettingRow } from "./SettingRow";
import { SettingsSection, SettingsSectionCounter } from "./SettingsSection";
import { PANEL_ROOT_STYLE } from "./panel-styles";
import { Switch } from "../primitives/Switch";
import { usePrefValue } from "@myne/client-core/pref-value";
import { prefsRead, setTranscriptionEnabled } from "../../lib/prefs";

export function TranscriptionPanel() {
  const { t } = useTranslation();
  // Starts ON, matching the persisted default: starting from `false` and
  // correcting after the disk read would flash the wrong answer for every
  // vault that never touched the setting — i.e. almost all of them.
  const { value: enabled, set: setEnabled, error } = usePrefValue({
    read: prefsRead,
    select: (p) => p.transcription_enabled,
    write: setTranscriptionEnabled,
    initial: true,
    errorMessage: t("settings.transcription.errorSaveSetting"),
  });

  return (
    <div style={PANEL_ROOT_STYLE} data-testid="settings.transcription-panel">
      {/* One concern, so one section (myne-md/myne#885), and it draws NO
          heading or rule (myne-md/myne#867, on the user's read: "one section,
          but the separator is still there"). The counter is the same mechanism a
          settings topic uses: a section alone in its scope is already named by
          what opened it, here the rail entry, and an accent rule under it
          separated the panel from nothing. The `<section aria-label>` stays, so
          the group is still announced. */}
      <SettingsSectionCounter>
      <SettingsSection title={t("settings.shell.panels.transcription")}>
        <SettingRow
          label={t("settings.transcription.label")}
          helper={t("settings.transcription.helper")}
          error={error}
          control={(helperId) => (
            <Switch
              checked={enabled}
              onChange={(next) => void setEnabled(next)}
              ariaLabel={t("settings.transcription.label")}
              ariaDescribedBy={helperId}
              testId="settings.transcription"
            />
          )}
        />
      </SettingsSection>
      </SettingsSectionCounter>
    </div>
  );
}
