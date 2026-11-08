// Settings → Editor: vim keyboard-mode toggle (vim-keyboard-mode, MYND-313).
// A single `<Switch>` toggle, the direct sibling of LineNumbersSettings —
// local state loaded on mount, disk-first persist with no in-flight gating.
//
// Default OFF (modal editing is opt-in). `null` ≡ unset → host default-OFF; only
// an explicit choice is persisted. The setter bumps the prefs nonce, so the open
// editor (its own `usePrefs`) re-reads and reconfigures its vim compartment live
// (no remount) — and the engine is only downloaded on the first enable.
//
// The helper copy carries the one honest caveat from the design session: on
// Windows and Linux, Myne's application chords win over vim's `Ctrl-` grammar,
// so a handful of vim chords are unavailable. Stating it here is what keeps a
// missing `Ctrl-d` reading as a documented trade-off rather than a bug report.
import { type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Switch } from "../primitives/Switch";
import { SettingRow } from "./SettingRow";
import { usePrefValue } from "@myne/client-core/pref-value";
import { prefsRead, setEditorVimMode } from "../../lib/prefs";
import { chordPolicyActive } from "../../editor/vim-chords";

const CAVEAT_STYLE: CSSProperties = {
  marginTop: "var(--space-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
};

export function VimModeSettings() {
  const { t } = useTranslation();
  const { value: enabled, set: setEnabled, error } = usePrefValue({
    read: prefsRead,
    select: (p) => p.editor_vim_mode ?? false,
    write: setEditorVimMode,
    initial: false,
    errorMessage: t("settings.vimMode.errorSaveSetting"),
  });

  return (
    <SettingRow
      label={t("settings.vimMode.label")}
      helper={t("settings.vimMode.helper")}
      error={error}
      control={(helperId) => (
        <Switch
          checked={enabled}
          onChange={() => void setEnabled(!enabled)}
          ariaLabel={t("settings.vimMode.label")}
          ariaDescribedBy={helperId}
          testId="settings.vim-mode"
        />
      )}
    >
      {/* The caveat is only true where `Mod` resolves to Ctrl; on macOS vim
          keeps its full Ctrl grammar, so showing it there would be a lie. */}
      {enabled && chordPolicyActive() && (
        <p style={CAVEAT_STYLE} data-testid="settings.vim-mode.caveat">
          {t("settings.vimMode.chordCaveat")}
        </p>
      )}
    </SettingRow>
  );
}
