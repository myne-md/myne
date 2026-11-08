// Settings → Editor: focus-mode behaviours (focus-mode, MYND-348).
// Two `<Switch>` toggles — typewriter scroll + dim inactive lines — that the
// distraction-free focus mode honors. Both default ON; `null` ≡ unset → host
// default-ON. Self-contained like the sibling controls: local state on mount,
// disk-first persist, no in-flight gating.
//
// These configure the focus-mode BEHAVIOUR; entering focus mode itself is the
// ⇧⌘F toggle (ephemeral, not a pref). The setters bump the prefs nonce so an open
// editor re-reads and reconfigures its focus extensions live (no remount).
import { useTranslation } from "react-i18next";
import { Switch } from "../primitives/Switch";
import { usePrefValue } from "@myne/client-core/pref-value";
import { SettingRow } from "./SettingRow";
import { ERROR_STYLE } from "./panel-styles";
import {
  prefsRead,
  setEditorFocusTypewriter,
  setEditorFocusDimInactive,
} from "../../lib/prefs";

export function FocusModeSettings() {
  const { t } = useTranslation();
  const { value: typewriter, set: setTypewriter, error: typewriterError } = usePrefValue({
    read: prefsRead,
    select: (p) => p.editor_focus_typewriter ?? true,
    write: setEditorFocusTypewriter,
    initial: true,
    errorMessage: t("settings.focusMode.saveError"),
  });
  const { value: dim, set: setDim, error: dimError } = usePrefValue({
    read: prefsRead,
    select: (p) => p.editor_focus_dim_inactive ?? true,
    write: setEditorFocusDimInactive,
    initial: true,
    errorMessage: t("settings.focusMode.saveError"),
  });
  const error = typewriterError ?? dimError;

  return (
    <>
      <SettingRow
        label={t("settings.focusMode.typewriterLabel")}
        helper={t("settings.focusMode.typewriterHelper")}
        control={(helperId) => (
          <Switch
            checked={typewriter}
            onChange={() => void setTypewriter(!typewriter)}
            ariaLabel={t("settings.focusMode.typewriterAria")}
            ariaDescribedBy={helperId}
            testId="settings.focus-typewriter"
          />
        )}
      />
      <SettingRow
        label={t("settings.focusMode.dimLabel")}
        helper={t("settings.focusMode.dimHelper")}
        control={(helperId) => (
          <Switch
            checked={dim}
            onChange={() => void setDim(!dim)}
            ariaLabel={t("settings.focusMode.dimAria")}
            ariaDescribedBy={helperId}
            testId="settings.focus-dim"
          />
        )}
      />
      {/* Either toggle sets this, so it sits outside both rows. */}
      {error !== null && <p style={ERROR_STYLE}>{error}</p>}
    </>
  );
}
