// Settings → Editor: focus-mode behaviours (focus-mode, MYND-348).
// Two `<Switch>` toggles — typewriter scroll + dim inactive lines — that the
// distraction-free focus mode honors. Both default ON; `null` ≡ unset → host
// default-ON. Self-contained like the sibling controls: local state on mount,
// disk-first persist, no in-flight gating.
//
// These configure the focus-mode BEHAVIOUR; entering focus mode itself is the
// ⇧⌘F toggle (ephemeral, not a pref). The setters bump the prefs nonce so an open
// editor re-reads and reconfigures its focus extensions live (no remount).

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Switch } from "../primitives/Switch";
import { SettingRow } from "./SettingRow";
import { ERROR_STYLE } from "./panel-styles";
import {
  prefsRead,
  setEditorFocusTypewriter,
  setEditorFocusDimInactive,
} from "../../lib/prefs";

export function FocusModeSettings() {
  const { t } = useTranslation();
  const [typewriter, setTypewriter] = useState(true);
  const [dim, setDim] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void prefsRead()
      .then((p) => {
        if (cancelled) return;
        // null ≡ unset → host default-ON.
        setTypewriter(p.editor_focus_typewriter ?? true);
        setDim(p.editor_focus_dim_inactive ?? true);
      })
      .catch(() => {
        /* locked / no vault — leave defaults ON */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggleTypewriter(next: boolean) {
    const prev = typewriter;
    setTypewriter(next);
    try {
      await setEditorFocusTypewriter(next);
      setError(null);
    } catch {
      setTypewriter(prev);
      setError(t("settings.focusMode.saveError"));
    }
  }

  async function toggleDim(next: boolean) {
    const prev = dim;
    setDim(next);
    try {
      await setEditorFocusDimInactive(next);
      setError(null);
    } catch {
      setDim(prev);
      setError(t("settings.focusMode.saveError"));
    }
  }

  return (
    <>
      <SettingRow
        label={t("settings.focusMode.typewriterLabel")}
        helper={t("settings.focusMode.typewriterHelper")}
        control={(helperId) => (
          <Switch
            checked={typewriter}
            onChange={() => toggleTypewriter(!typewriter)}
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
            onChange={() => toggleDim(!dim)}
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
